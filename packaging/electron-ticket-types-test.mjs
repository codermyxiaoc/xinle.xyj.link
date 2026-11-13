import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { _electron } from "@playwright/test";
import { buildPriceExport, normalizeProduct } from "../lib/ticket-prices.ts";
import { persistPriceExport } from "../lib/price-store.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const buildRoot = path.join(root, "build", "portable");
await fs.mkdir(buildRoot, { recursive: true });
const testRoot = await fs.mkdtemp(path.join(buildRoot, "electron-ticket-types-test-"));
const dataDirectory = path.join(testRoot, "data");
const execute = promisify(execFile);
const env = { ...process.env, PATH: path.join(process.env.SystemRoot, "System32") };
for (const key of ["ELECTRON_RUN_AS_NODE", "NODE_OPTIONS", "NODE_PATH", "XINLE_USERNAME", "XINLE_PASSWORD", "XINLE_BROWSER_PATH", "XINLE_NODE_PATH", "XINLE_DATA_DIR"]) delete env[key];

// 独立虚构价格 fixture：不复制当前用户的账号、配置或真实行情。
const products = [
  { goods_id: 1023, goods_name: "北京环球影城-1日标准票-提前15天预定", ticket_type: "ADULT", limit_day: 15 },
  { goods_id: 1024, goods_name: "北京环球影城-1日儿童票-提前15天预定", ticket_type: "CHILDREN", limit_day: 15 },
  { goods_id: 1036, goods_name: "暑期特惠：北京环球影城指定日标准成人票【提前3天】", ticket_type: "CHILDREN", limit_day: 3 },
].map((product) => normalizeProduct(product, { spot_id: 1, spot_name: "北京环球度假区" }));
const priceRow = (price) => ({ date: "2026-11-26", b2b_price: price, mall_price: price, market_price: price + 10, valid: 1, stock: -1 });
const seed = {
  ...buildPriceExport(products, { "1023": [priceRow(331.85)], "1024": [priceRow(251.46)], "1036": [priceRow(350)] }, { fetchedAt: "2026-11-11T01:00:00.000Z" }),
  collectionStatus: "complete", collection: { requestedProducts: 3, completedProducts: 3, failures: [] },
};
await persistPriceExport(seed, path.join(dataDirectory, "output"));

let application;
let activeSession;
const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (error) { if (error.code === "ESRCH") return false; throw error; }
};
const waitFor = async (check, timeout = 30_000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = await check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("票种设置窗口验收等待超时。");
};

try {
  application = await _electron.launch({
    executablePath: path.join(root, "build", "electron-release", "win-unpacked", "XinlePriceDashboard.exe"),
    args: ["--data-root", testRoot], env, timeout: 60_000,
  });
  const page = await application.firstWindow();
  await page.locator('.ticket-card[data-group="other"] .channel-row[data-goods-id="1036"]').waitFor({ state: "visible" });
  activeSession = JSON.parse(await fs.readFile(path.join(testRoot, "session.json"), "utf8"));
  const getPrices = async () => (await fetch(activeSession.url + "/api/prices")).json();
  const measurements = [];
  const checkButtonsAndOverflow = async (label) => {
    const measurement = await page.evaluate(() => ({
      innerWidth,
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      buttons: [...document.querySelectorAll(".refresh-actions > button")].map((button) => {
        const bounds = button.getBoundingClientRect();
        return { width: bounds.width, height: bounds.height };
      }),
    }));
    assert.equal(measurement.buttons.length, 3);
    for (const button of measurement.buttons) {
      assert.ok(Math.abs(button.width - measurement.buttons[0].width) < 1, "三个操作按钮宽度一致");
      assert.ok(Math.abs(button.height - measurement.buttons[0].height) < 1, "三个操作按钮高度一致");
    }
    assert.ok(measurement.scrollWidth <= measurement.clientWidth + 1, `${label} 页面不能横向溢出`);
    measurements.push({ label, ...measurement });
  };
  await checkButtonsAndOverflow("desktop");

  const open1036 = async () => {
    await page.locator("#ticket-types-button").click();
    await page.locator('#ticket-types-list [data-goods-id="1036"]').waitFor({ state: "visible" });
    await page.locator("#ticket-types-search").fill("1036");
    assert.equal(await page.locator(".ticket-type-row").count(), 1);
    const row = page.locator('#ticket-types-list [data-goods-id="1036"]');
    assert.match(await row.locator("legend").innerText(), /1036$/);
    assert.match(await row.locator(".ticket-type-meta").innerText(), /CHILDREN/);
    return row;
  };
  const saveSettings = async () => {
    const saved = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/ticket-types" && response.request().method() === "POST");
    await page.locator("#ticket-types-save").click();
    assert.equal((await saved).status(), 200);
    await page.locator("#ticket-types-feedback.is-success").waitFor({ state: "visible" });
  };
  let row = await open1036();
  assert.equal(await row.locator('input[value=""]').isChecked(), true);
  for (const group of ["adult_1d", "children_1d", "adult_1_5d", "children_1_5d"]) {
    assert.equal(await row.locator(`input[value="${group}"]`).count(), 1, `票种设置应支持 ${group}`);
  }
  await row.locator("label").filter({ hasText: /^1日成人$/ }).click();
  await saveSettings();
  assert.equal(await row.locator('input[value="adult_1d"]').isChecked(), true);
  await page.screenshot({ path: path.join(buildRoot, "electron-ticket-types-dialog.png") });
  await page.locator("#ticket-types-close").click();
  const adultRow = page.locator('.ticket-card[data-group="adult_1d"] .channel-row[data-goods-id="1036"]');
  await adultRow.waitFor({ state: "visible" });
  assert.equal(await adultRow.locator(".local-ticket-type-label").innerText(), "本地设为1日成人");
  assert.equal(await page.locator('.ticket-card[data-group="other"] .channel-row[data-goods-id="1036"]').count(), 0);
  const applied = await getPrices();
  assert.equal(applied.products["1036"].group, "adult_1d");
  assert.equal(applied.products["1036"].visitDays, 1);
  assert.equal(applied.products["1036"].sourceTicketType, "CHILDREN");
  assert.equal(applied.summary.priceCount, 3);
  const persisted = JSON.parse(await fs.readFile(path.join(dataDirectory, "output", "ticket-prices.json"), "utf8"));
  assert.equal(persisted.products["1036"].group, "adult_1d");
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: path.join(buildRoot, "electron-ticket-types-dashboard.png"), fullPage: true });

  await page.reload();
  await adultRow.locator(".local-ticket-type-label").waitFor({ state: "visible" });
  assert.equal((await getPrices()).products["1036"].ticketTypeSource, "local");
  const savedMapping = JSON.parse(await fs.readFile(path.join(dataDirectory, "config", "ticket-types.json"), "utf8"));
  assert.deepEqual(savedMapping.overrides, { "1036": "adult_1d" });

  // 临时放宽测试窗口最小宽度，以覆盖 390px 窄屏布局，不更改产品的窗口配置。
  await application.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.setMinimumSize(320, 480);
    window.setContentSize(390, 844);
  });
  await waitFor(async () => (await page.evaluate(() => innerWidth)) <= 400);
  await checkButtonsAndOverflow("narrow");
  row = await open1036();
  assert.equal(await row.locator('input[value="adult_1d"]').isChecked(), true);
  const bounds = await page.locator("#ticket-types-dialog").evaluate((dialog) => {
    const rect = dialog.getBoundingClientRect();
    return { left: rect.left, right: rect.right, viewport: innerWidth, clientWidth: dialog.clientWidth, scrollWidth: dialog.scrollWidth };
  });
  assert.ok(bounds.left >= 0 && bounds.right <= bounds.viewport + 1, "窄屏弹窗应处于窗口内");
  assert.ok(bounds.scrollWidth <= bounds.clientWidth + 1, "窄屏弹窗不能横向溢出");
  await page.screenshot({ path: path.join(buildRoot, "electron-ticket-types-narrow.png") });
  await row.locator("label").filter({ hasText: /^跟随接口$/ }).click();
  await saveSettings();
  await page.locator("#ticket-types-close").click();
  const pendingRow = page.locator('.ticket-card[data-group="other"] .channel-row[data-goods-id="1036"]');
  await pendingRow.waitFor({ state: "visible" });
  assert.equal(await pendingRow.locator(".local-ticket-type-label").count(), 0);
  assert.equal(await pendingRow.locator(".pending-type-action").innerText(), "设置票种");
  assert.equal(await page.locator('.adult-card .channel-row[data-goods-id="1036"]').count(), 0);
  const restored = await getPrices();
  assert.equal(restored.products["1036"].group, "other");
  assert.equal(restored.products["1036"].ticketType, "CHILDREN");
  assert.equal(restored.products["1036"].ticketTypeSource, "remote");
  assert.equal(restored.summary.priceCount, 3);
  assert.deepEqual(restored.prices.other["1036"], seed.prices.other["1036"]);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dataDirectory, "config", "ticket-types.json"), "utf8")).overrides, {});
  await assert.rejects(fs.access(path.join(dataDirectory, "config", "login.json")), { code: "ENOENT" });

  const closed = application.waitForEvent("close");
  await application.evaluate(({ BrowserWindow }) => { setTimeout(() => BrowserWindow.getAllWindows()[0].close(), 100); });
  await closed;
  await waitFor(() => !alive(activeSession.serverPid), 15_000);
  await assert.rejects(fs.access(path.join(testRoot, "session.json")), { code: "ENOENT" });
  const report = {
    passed: true, electronVersion: activeSession.electronVersion,
    adultOverride: true, fourTicketTypes: true, localLabel: true, reloadPersistence: true,
    resetToAutomaticPending: true, equalButtons: true, narrowNoOverflow: true,
    credentialsCopied: false, measurements, testRoot, testedAt: new Date().toISOString(),
  };
  await fs.writeFile(path.join(buildRoot, "electron-ticket-types-report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  try { await application?.close(); } catch { }
  if (activeSession && alive(activeSession.serverPid)) {
    try { await execute(path.join(process.env.SystemRoot, "System32", "taskkill.exe"), ["/PID", String(activeSession.serverPid), "/T", "/F"], { windowsHide: true }); } catch { }
  }
  await fs.rm(path.join(dataDirectory, "config", "ticket-types.json"), { force: true });
}
