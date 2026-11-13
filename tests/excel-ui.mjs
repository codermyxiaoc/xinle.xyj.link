import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";
import { chromium } from "patchright";
import { createDashboardServer } from "../server.ts";
import { buildPriceExport, normalizeProduct } from "../lib/ticket-prices.ts";
import { persistPriceExport } from "../lib/price-store.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const screenshotDir = path.join(root, "build", "excel-ui");
const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "xinle-excel-ui-"));
const outputDir = path.join(testRoot, "output");
const date = "2026-11-26";
const products = [
  normalizeProduct({ goods_id: 1036, goods_name: "北京环球影城特惠成人票-时长待确认", ticket_type: "CHILDREN" }, { spot_id: 1, spot_name: "北京环球度假区" }),
  normalizeProduct({ goods_id: 1552, goods_name: "上海迪士尼1日儿童票", ticket_type: "ALL" }, { spot_id: 2, spot_name: "上海迪士尼度假区" }),
];
const record = (price) => ({ date, b2b_price: price, mall_price: price, market_price: price + 10, valid: 1, stock: 50 });
const seed = {
  ...buildPriceExport(products, { "1036": [record(350)], "1552": [record(277)] }, { fetchedAt: "2026-11-11T01:00:00.000Z" }),
  collectionStatus: "complete", collection: { requestedProducts: 2, completedProducts: 2, failures: [] },
};
const zipFiles = (buffer) => {
  assert.equal(buffer.subarray(0, 4).toString("hex"), "504b0304");
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end >= 0);
  const files = new Map();
  let cursor = buffer.readUInt32LE(end + 16);
  for (let i = 0; i < buffer.readUInt16LE(end + 10); i++) {
    assert.equal(buffer.readUInt32LE(cursor), 0x02014b50);
    const method = buffer.readUInt16LE(cursor + 10);
    const size = buffer.readUInt32LE(cursor + 20);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const local = buffer.readUInt32LE(cursor + 42);
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const compressed = buffer.subarray(start, start + size);
    assert.ok([0, 8].includes(method));
    files.set(name, (method === 8 ? inflateRawSync(compressed) : compressed).toString("utf8"));
    cursor += 46 + nameLength + buffer.readUInt16LE(cursor + 30) + buffer.readUInt16LE(cursor + 32);
  }
  return files;
};
let server;
let browser;
try {
  await fs.mkdir(screenshotDir, { recursive: true });
  await persistPriceExport(seed, outputDir);
  server = createDashboardServer({ outputDir, configRoot: testRoot, runRefresh: async () => { throw new Error("Excel UI fixture 不访问外站"); } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const saved = await fetch(base + "/api/ticket-types", {
    method: "POST", headers: { "Content-Type": "application/json", Origin: base },
    body: JSON.stringify({ overrides: { "1036": "adult_1_5d" } }),
  });
  assert.equal(saved.status, 200);
  browser = await chromium.launch({ channel: "msedge", headless: true, args: ["--no-proxy-server"] });
  const page = await browser.newPage({ acceptDownloads: true, viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(10_000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(base, { waitUntil: "networkidle" });
  await page.locator('.channel-row[data-goods-id="1036"]').waitFor();
  await page.locator('#view-mode button[data-view="calendar"]').click();
  const beforeUrl = page.url();
  const downloads = [];
  page.on("download", (download) => downloads.push(download));
  const downloadEvent = page.waitForEvent("download");
  const exportResponse = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/export.xlsx");
  await page.locator("#excel-export-button").click();
  const download = await downloadEvent;
  const response = await exportResponse;
  assert.equal(response.status(), 200);
  assert.match(response.headers()["content-type"], /spreadsheetml\.sheet/);
  assert.match(download.suggestedFilename(), /\.xlsx$/);
  assert.match(download.suggestedFilename(), /[\u4e00-\u9fff]/);
  assert.equal(await download.failure(), null);
  const savedPath = path.join(testRoot, download.suggestedFilename());
  await download.saveAs(savedPath);
  const bytes = await fs.readFile(savedPath);
  const files = zipFiles(bytes);
  assert.ok(files.has("[Content_Types].xml"));
  assert.ok(files.has("xl/workbook.xml"));
  assert.equal([...files.keys()].filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name)).length, 4);
  const channelXml = files.get("xl/worksheets/sheet1.xml");
  assert.match(channelXml, /1\.5日成人/);
  assert.match(channelXml, /本地设置/);
  assert.match(channelXml, /上海迪士尼度假区/, "导出包含全部持久化地区，不受当前看板筛选限制");
  assert.equal(page.url(), beforeUrl);
  assert.equal(await page.locator('#view-mode button[data-view="calendar"]').getAttribute("aria-pressed"), "true");
  assert.equal(await page.locator("#excel-export-button").isDisabled(), false);
  assert.match(await page.locator("#excel-export-feedback").innerText(), /下载/);

  await page.setViewportSize({ width: 390, height: 844 });
  const width = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, content: document.documentElement.scrollWidth }));
  assert.ok(width.content <= width.viewport + 1, "新增导出按钮不应导致窄屏横向溢出");
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: path.join(screenshotDir, "download-narrow.png") });
  await fs.rename(path.join(outputDir, "ticket-prices.json"), path.join(outputDir, "ticket-prices-test-backup.json"));
  const rejected = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/export.xlsx");
  await page.locator("#excel-export-button").click();
  assert.equal((await rejected).status(), 404);
  await page.locator("#excel-export-feedback.is-error").waitFor();
  assert.match(await page.locator("#excel-export-feedback").innerText(), /导出失败/);
  assert.equal(downloads.length, 1, "失败响应不应产生Excel下载");
  assert.equal(page.url(), beforeUrl, "导出失败不跳转离开看板");
  assert.equal(await page.locator("#excel-export-button").isDisabled(), false);
  assert.deepEqual(errors, []);
  console.log("Excel UI验收通过：真实中文.xlsx下载、四工作表ZIP、本地票种、全地区导出、保留日历模式、失败提示及390px布局。");
  console.log(`截图：${path.join(screenshotDir, "download-narrow.png")}`);
} finally {
  await browser?.close();
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  await fs.rm(testRoot, { recursive: true, force: true });
}
