import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";
import { _electron } from "@playwright/test";
import { buildPriceExport, normalizeProduct } from "../lib/ticket-prices.ts";
import { persistPriceExport } from "../lib/price-store.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const buildRoot = path.join(root, "build", "portable");
await fs.mkdir(buildRoot, { recursive: true });
const testRoot = await fs.mkdtemp(path.join(buildRoot, "electron-export-test-"));
const dataDirectory = path.join(testRoot, "data");
const downloadDirectory = path.join(testRoot, "downloads");
await fs.mkdir(downloadDirectory);
const execute = promisify(execFile);
const env = { ...process.env, PATH: path.join(process.env.SystemRoot, "System32") };
for (const key of ["ELECTRON_RUN_AS_NODE", "NODE_OPTIONS", "NODE_PATH", "XINLE_USERNAME", "XINLE_PASSWORD", "XINLE_BROWSER_PATH", "XINLE_NODE_PATH", "XINLE_DATA_DIR"]) delete env[key];

// 只使用隔离的虚构渠道与本地票种，不读取用户账号、AppData 或真实行情。
const areas = [
  { spot_id: 1, spot_name: "北京环球度假区" },
  { spot_id: 2, spot_name: "上海迪士尼度假区" },
  { spot_id: 3, spot_name: "北京环球影城度假区" },
];
const specifications = [
  [1023, "北京环球影城-1日标准票-提前15天预定", "ADULT", 0, 331.85],
  [1024, "北京环球影城-1日儿童票", "CHILDREN", 0, 251.46],
  [1027, "北京环球影城-1.5日成人票", "ADULT", 0, 538.5],
  [1028, "北京环球影城-1.5日儿童票", "CHILDREN", 0, 403],
  [1036, "北京环球影城指定日标准成人票【提前3天】", "CHILDREN", 0, 350],
  [1504, "上海迪士尼乐园1日成人票", "ADULT", 1, 404],
  [1552, "上海迪士尼乐园1日儿童票", "ALL", 1, 277],
  [1491, "【三人票】北京环球单日门票", "ALL", 2, 1094.16],
];
const date = "2026-11-26";
const products = specifications.map(([goods_id, goods_name, ticket_type, area]) => normalizeProduct({ goods_id, goods_name, ticket_type }, areas[area]));
const seed = {
  ...buildPriceExport(products, Object.fromEntries(specifications.map(([id, , , , price]) => [id, [{ date, b2b_price: price, mall_price: price, market_price: price + 10, valid: 1, stock: 50 }]])), { fetchedAt: "2026-11-11T01:00:00.000Z" }),
  collectionStatus: "complete", collection: { requestedProducts: products.length, completedProducts: products.length, failures: [] },
};
await persistPriceExport(seed, path.join(dataDirectory, "output"));
await fs.mkdir(path.join(dataDirectory, "config"));
await fs.writeFile(path.join(dataDirectory, "config", "ticket-types.json"), JSON.stringify({ overrides: { "1036": "adult_1_5d" } }));

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
const waitFor = async (check, timeout = 30_000) => {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const result = await check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Electron 导出验收等待超时。");
};
const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (error) { if (error.code === "ESRCH") return false; throw error; }
};
let application;
let activeSession;
try {
  application = await _electron.launch({
    executablePath: path.join(root, "build", "electron-release", "win-unpacked", "XinlePriceDashboard.exe"),
    args: ["--data-root", testRoot], env, timeout: 60_000,
  });
  const page = await application.firstWindow();
  page.setDefaultTimeout(15_000);
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.locator('.channel-row[data-goods-id="1036"]').waitFor();
  activeSession = JSON.parse(await fs.readFile(path.join(testRoot, "session.json"), "utf8"));
  assert.equal(path.resolve(activeSession.dataDirectory), dataDirectory);
  const windowState = await application.evaluate(({ app, BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    const prefs = window.webContents.getLastWebPreferences();
    return { userData: app.getPath("userData"), windowCount: BrowserWindow.getAllWindows().length, sandbox: prefs.sandbox, contextIsolation: prefs.contextIsolation, nodeIntegration: prefs.nodeIntegration, electronVersion: process.versions.electron };
  });
  assert.equal(path.resolve(windowState.userData), path.join(testRoot, "electron-profile"));
  assert.equal(windowState.windowCount, 1);
  assert.equal(windowState.sandbox, true);
  assert.equal(windowState.contextIsolation, true);
  assert.equal(windowState.nodeIntegration, false);
  await assert.rejects(fs.access(path.join(dataDirectory, "config", "login.json")), { code: "ENOENT" });
  // 字节比较确认实际 EXE 内置的是当前最新服务、分类、Excel、日历和地区 UI。
  const verifiedSourceFiles = ["server.ts", "lib/ticket-prices.ts", "lib/ticket-type-config.ts", "lib/price-excel.ts", "lib/xlsx.ts", "web/index.html", "web/app.js", "web/styles.css", "web/ticket-types.js"];
  for (const filename of verifiedSourceFiles) {
    const bundled = await fs.readFile(path.join(activeSession.runtimeDirectory, filename));
    assert.deepEqual(bundled, await fs.readFile(path.join(root, filename)), `内置 ${filename} 应与当前源码一致`);
  }

  assert.equal(await page.locator('#destination-filter button[aria-pressed="true"]').getAttribute("data-destination"), "spot:1");
  assert.equal(await page.locator("#destination-filter button").count(), 4);
  for (const group of ["adult_1d", "children_1d", "adult_1_5d", "children_1_5d"]) {
    assert.equal(await page.locator(`.ticket-card[data-group="${group}"]`).count(), 1);
  }
  assert.equal(await page.locator('.ticket-card[data-group="adult_1_5d"] .channel-row[data-goods-id="1036"] .local-ticket-type-label').innerText(), "本地设为1.5日成人");
  await page.locator('#view-mode button[data-view="calendar"]').click();
  assert.equal(await page.locator(".price-calendar").count(), 4);
  assert.equal(await page.locator(`.price-calendar[data-group="adult_1_5d"] .calendar-day[data-date="${date}"]`).getAttribute("data-price"), "350");
  await page.locator('#destination-filter button[data-destination="spot:2"]').click();
  assert.equal(await page.locator(`.price-calendar[data-group="adult_1d"] .calendar-day[data-date="${date}"]`).getAttribute("data-price"), "404");
  await page.locator('#destination-filter button[data-destination="spot:1"]').click();
  await page.locator("#ticket-types-button").click();
  await page.locator('#ticket-types-list [data-goods-id="1036"]').waitFor();
  assert.equal(await page.locator('#ticket-types-destination-filter button[aria-pressed="true"]').getAttribute("data-destination"), "spot:1");
  assert.equal(await page.locator('#ticket-types-list [data-goods-id="1036"] input[value="adult_1_5d"]').isChecked(), true);
  await page.locator("#ticket-types-close").click();

  // 后注册监听读取应用实际设置的保存过滤，再只替换保存位置以避免系统对话框阻塞。
  const listenersBefore = await application.evaluate(({ BrowserWindow }, options) => {
    const targetSession = BrowserWindow.getAllWindows()[0].webContents.session;
    const count = targetSession.listenerCount("will-download");
    globalThis.__xinleExportTestDownloads = [];
    targetSession.on("will-download", (_event, item) => {
      const download = { filename: item.getFilename(), url: item.getURL(), mime: item.getMimeType(), options: item.getSaveDialogOptions(), state: "starting", savedPath: "", bytes: 0, error: null };
      globalThis.__xinleExportTestDownloads.push(download);
      try {
        if (!/\.(xlsx|json)$/i.test(download.filename) || /[\\/]/.test(download.filename)) throw new Error("unexpected test download filename");
        const savePath = options.directory + options.separator + download.filename;
        item.setSavePath(savePath);
        item.once("done", (_event, state) => {
          download.state = state;
          download.savedPath = item.getSavePath();
          download.bytes = item.getReceivedBytes();
        });
      } catch (error) { download.error = error.message; item.cancel(); }
    });
    return count;
  }, { directory: downloadDirectory, separator: path.sep });
  assert.ok(listenersBefore >= 1, "应用应先安装真实的下载保存选项处理器");
  const getDownloads = () => application.evaluate(() => globalThis.__xinleExportTestDownloads);
  await page.locator("#excel-export-button").click();
  const excel = await waitFor(async () => {
    const entry = (await getDownloads()).find((item) => /\.xlsx$/i.test(item.filename));
    if (entry?.error) throw new Error(entry.error);
    if (entry?.state === "cancelled" || entry?.state === "interrupted") throw new Error(`Excel Blob 下载失败：${entry.state}`);
    return entry?.state === "completed" ? entry : null;
  });
  assert.match(excel.url, /^blob:http:\/\/127\.0\.0\.1:\d+\//);
  assert.equal(new URL(excel.url).origin, activeSession.url);
  assert.match(excel.filename, /[\u4e00-\u9fff].*\.xlsx$/);
  assert.equal(excel.options.title, "导出渠道每日最低价 Excel");
  assert.equal(excel.options.defaultPath, excel.filename);
  assert.deepEqual(excel.options.filters, [{ name: "Excel 工作簿", extensions: ["xlsx"] }]);
  assert.equal(path.dirname(excel.savedPath), downloadDirectory);
  const bytes = await fs.readFile(excel.savedPath);
  assert.equal(bytes.length, excel.bytes);
  const files = zipFiles(bytes);
  assert.ok(files.has("[Content_Types].xml"));
  assert.equal([...files.keys()].filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name)).length, 4);
  assert.match(files.get("xl/worksheets/sheet1.xml"), /本地设置/);
  assert.match(files.get("xl/worksheets/sheet1.xml"), /1\.5日成人/);
  assert.match(files.get("xl/worksheets/sheet1.xml"), /上海迪士尼度假区/);
  assert.equal(await page.locator('#view-mode button[data-view="calendar"]').getAttribute("aria-pressed"), "true");

  await page.locator('a[href="/api/download"]').click();
  const json = await waitFor(async () => (await getDownloads()).find((item) => /\.json$/i.test(item.filename) && item.state === "completed"));
  assert.deepEqual(json.options.filters, [{ name: "JSON 数据", extensions: ["json"] }]);
  assert.equal(JSON.parse(await fs.readFile(json.savedPath, "utf8")).products["1036"].group, "adult_1_5d");
  await page.screenshot({ path: path.join(buildRoot, "electron-export-calendar.png"), fullPage: false });
  await application.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.setMinimumSize(320, 480);
    window.setContentSize(390, 844);
  });
  await waitFor(async () => (await page.evaluate(() => innerWidth)) <= 400);
  const layout = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, content: document.documentElement.scrollWidth }));
  assert.ok(layout.content <= layout.viewport + 1);
  await page.screenshot({ path: path.join(buildRoot, "electron-export-narrow.png"), fullPage: false });
  assert.deepEqual(pageErrors, []);
  const closed = application.waitForEvent("close");
  await application.evaluate(({ BrowserWindow }) => { setTimeout(() => BrowserWindow.getAllWindows()[0].close(), 100); });
  await closed;
  await waitFor(() => !alive(activeSession.serverPid), 15_000);
  await assert.rejects(fs.access(path.join(testRoot, "session.json")), { code: "ENOENT" });
  const report = {
    passed: true, electronVersion: windowState.electronVersion, latestBundledSourceFiles: verifiedSourceFiles,
    destinations: 3, ticketCategories: 4, calendar: true, localOverride: true,
    excelBlobDownloaded: true, excelSaveFilters: excel.options.filters, excelFilename: excel.filename,
    excelBytes: bytes.length, excelSha256: createHash("sha256").update(bytes).digest("hex"),
    jsonDownload: true, narrowNoOverflow: true, isolatedProfile: windowState.userData,
    noLoginCredentials: true, shutdownCleanup: true, testRoot, testedAt: new Date().toISOString(),
  };
  await fs.writeFile(path.join(buildRoot, "electron-export-report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  try { await application?.close(); } catch { }
  if (activeSession && alive(activeSession.serverPid)) {
    try { await execute(path.join(process.env.SystemRoot, "System32", "taskkill.exe"), ["/PID", String(activeSession.serverPid), "/T", "/F"], { windowsHide: true }); } catch { }
  }
}
