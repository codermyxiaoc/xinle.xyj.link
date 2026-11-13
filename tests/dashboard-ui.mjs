import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "patchright";
import { createDashboardServer } from "../server.ts";
import { buildPriceExport, normalizeProduct } from "../lib/ticket-prices.ts";
import { persistPriceExport } from "../lib/price-store.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const screenshotDir = path.join(root, "build", "dashboard-ui");
const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "xinle-dashboard-ui-"));
const outputDir = path.join(testRoot, "output");
const date = "2026-11-26";
const areas = [
  { spot_id: 1, spot_name: "北京环球度假区" },
  { spot_id: 2, spot_name: "上海迪士尼度假区" },
  { spot_id: 3, spot_name: "北京环球影城度假区" },
];
// 隔离虚构行情覆盖同价、不同地区、四种票型和待设置，不读取用户配置。
const specifications = [
  [1023, "北京环球影城-1日标准票-提前15天预定", "ADULT", 0, 331.85],
  [1026, "北京环球影城-1日标准票-提前3天预定", "ADULT", 0, 331.85],
  [1031, "北京环球影城-1日标准票-提前10天预定", "ADULT", 0, 400],
  [1024, "北京环球影城-1日儿童票", "CHILDREN", 0, 251.46],
  [1027, "北京环球影城-1.5日成人票", "ADULT", 0, 538.5],
  [1028, "北京环球影城-1.5日儿童票", "CHILDREN", 0, 403],
  [1036, "暑期特惠：北京环球影城指定日标准成人票【提前3天】", "CHILDREN", 0, 350],
  [1504, "上海迪士尼乐园1日门票-成人票", "ADULT", 1, 100],
  [1552, "上海迪士尼乐园1日儿童票", "ALL", 1, 77],
  [1491, "【三人票】北京环球单日门票（优惠）-当日可订", "ALL", 2, 1094.16],
];
const products = specifications.map(([goods_id, goods_name, ticket_type, area]) =>
  normalizeProduct({ goods_id, goods_name, ticket_type }, areas[area]));
const record = (price, visitDate = date) => ({ date: visitDate, b2b_price: price, mall_price: price, market_price: price + 10, valid: 1, stock: -1 });
const rawPrices = Object.fromEntries(specifications.map(([id, , , , price]) => [id, [record(price)]]));
rawPrices[1023].push(record(390, "2026-11-27"));
const seed = {
  ...buildPriceExport(products, rawPrices, { fetchedAt: "2026-11-11T01:00:00.000Z" }),
  collectionStatus: "complete", collection: { requestedProducts: products.length, completedProducts: products.length, failures: [] },
};
let server;
let browser;
const failures = [];
try {
  await fs.mkdir(screenshotDir, { recursive: true });
  await persistPriceExport(seed, outputDir);
  server = createDashboardServer({ outputDir, configRoot: testRoot, runRefresh: async () => { throw new Error("UI fixture 不请求外部网站"); } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ channel: "msedge", headless: true, args: ["--no-proxy-server"] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on("pageerror", (error) => failures.push(error.message));
  page.setDefaultTimeout(10_000);
  await page.goto(base, { waitUntil: "networkidle" });
  await page.locator('.channel-row[data-goods-id="1036"]').waitFor();
  const day = () => page.locator(`.day-section[data-date="${date}"]`);
  const card = (group, destination = "spot:1") => day().locator(`.ticket-card[data-group="${group}"][data-destination="${destination}"]`);
  const choose = async (id, value) => {
    if (id === "destination-filter") {
      await page.locator(`#destination-filter button[data-destination="${value}"]`).click();
      assert.equal(await page.locator("#destination-filter button[aria-pressed=\"true\"]").getAttribute("data-destination"), value);
      return;
    }
    await page.locator(`#${id}-trigger`).click();
    await page.locator(`#${id}-listbox [role="option"][data-value="${value}"]`).click();
    assert.equal(await page.locator(`#${id}`).inputValue(), value);
    assert.equal(await page.locator(`#${id}-trigger`).getAttribute("aria-expanded"), "false");
  };
  const chooseSettingsDestination = async (value) => {
    await page.locator(`#ticket-types-destination-filter button[data-destination="${value}"]`).click();
    assert.equal(await page.locator('#ticket-types-destination-filter button[aria-pressed="true"]').getAttribute("data-destination"), value);
  };
  const assertLayout = async (label) => {
    const size = await page.evaluate(() => ({
      width: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      buttons: [...document.querySelectorAll(".refresh-actions > button")].map((button) => {
        const rect = button.getBoundingClientRect(); return { width: rect.width, height: rect.height };
      }),
    }));
    assert.ok(size.scrollWidth <= size.width + 1, `${label} 页面不应横向溢出`);
    assert.equal(size.buttons.length, 3);
    for (const button of size.buttons) {
      assert.ok(Math.abs(button.width - size.buttons[0].width) < 1, `${label} 操作按钮同宽`);
      assert.ok(Math.abs(button.height - size.buttons[0].height) < 1, `${label} 操作按钮同高`);
    }
  };

  assert.equal(await page.locator("#destination-filter.segmented[role=\"group\"] button").count(), 4);
  assert.equal(await page.locator("#destination-filter button[aria-pressed=\"true\"]").getAttribute("data-destination"), "spot:1", "首次进入默认选择北京环球度假区");
  assert.equal(await day().locator(".destination-section").count(), 1);
  assert.equal(await page.locator("#adult_1d-lowest").innerText(), "331.85");
  await choose("destination-filter", "");
  assert.equal(await day().locator(".destination-section").count(), 3);
  assert.equal(await page.locator("#adult_1d-lowest").innerText(), "—", "全部地区不应汇总成一个跨地区最低价");
  assert.equal(await card("adult_1d", "spot:2").locator('.channel-row[data-goods-id="1504"]').getAttribute("data-rank"), "1");
  assert.deepEqual(await card("adult_1d").locator(".channel-row").evaluateAll((nodes) => nodes.map((node) => [node.dataset.goodsId, node.dataset.rank])), [["1023", "1"], ["1026", "1"], ["1031", "3"]]);
  assert.equal(await card("adult_1d").locator(".best-label").first().innerText(), "并列最低");
  assert.equal(await card("other").locator(".channel-row").getAttribute("data-rank"), "");
  assert.match(await card("adult_1d").locator('.channel-row[data-goods-id="1023"] .channel-title').innerText(), /提前15天预定-1023$/);
  await assertLayout("桌面");
  await page.screenshot({ path: path.join(screenshotDir, "all-destinations.png"), fullPage: true });

  await choose("destination-filter", "spot:1");
  assert.equal(await day().locator(".destination-section").count(), 1);
  assert.equal(await page.locator('.channel-row[data-goods-id="1504"]').count(), 0);
  assert.equal(await page.locator("#adult_1d-lowest").innerText(), "331.85");
  await choose("date-filter", date);
  assert.equal(await page.locator(".day-section").count(), 1);
  for (const [group, expectedId] of [["adult_1d", "1023"], ["children_1d", "1024"], ["adult_1_5d", "1027"], ["children_1_5d", "1028"], ["other", "1036"]]) {
    await page.locator(`.segmented button[data-type="${group}"]`).click();
    assert.equal(await day().locator(".ticket-card").count(), 1);
    assert.equal(await day().locator(".ticket-card").getAttribute("data-group"), group);
    assert.equal(await page.locator("#destination-filter button[aria-pressed=\"true\"]").getAttribute("data-destination"), "spot:1", "票种筛选保留当前地区");
    await day().locator(`.channel-row[data-goods-id="${expectedId}"]`).waitFor();
  }
  await page.locator('.segmented button[data-type="all"]').click();
  await choose("destination-filter", "spot:2");
  assert.equal(await page.locator("#adult_1d-lowest").innerText(), "100.00");
  assert.equal(await page.locator('.channel-row[data-goods-id="1023"]').count(), 0);
  await page.locator("#ticket-types-button").click();
  await page.locator('#ticket-types-list [data-goods-id="1504"]').waitFor();
  assert.equal(await page.locator('#ticket-types-destination-filter.segmented[role="group"] button').count(), 4);
  assert.equal(await page.locator('#ticket-types-destination-filter button[aria-pressed="true"]').getAttribute("data-destination"), "spot:2", "常规打开票种设置默认跟随看板地区");
  assert.deepEqual(await page.locator(".ticket-type-row").evaluateAll((rows) => rows.map((row) => row.dataset.goodsId).sort()), ["1504", "1552"]);
  await chooseSettingsDestination("");
  assert.equal(await page.locator(".ticket-type-row").count(), 10, "全部地区显示所有渠道");
  await page.locator("#ticket-types-search").fill("1552");
  assert.equal(await page.locator(".ticket-type-row").count(), 1);
  await chooseSettingsDestination("spot:1");
  assert.equal(await page.locator(".ticket-type-row").count(), 0, "搜索与地区筛选需要同时匹配");
  await chooseSettingsDestination("spot:2");
  assert.equal(await page.locator(".ticket-type-row").count(), 1);
  await page.locator("#ticket-types-close").click();
  await choose("destination-filter", "");

  const saveSettings = async (expectedOverrides) => {
    const response = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/ticket-types" && response.request().method() === "POST");
    await page.locator("#ticket-types-save").click();
    const result = await response;
    assert.equal(result.status(), 200);
    if (expectedOverrides) assert.deepEqual(result.request().postDataJSON(), { overrides: expectedOverrides }, "一次保存提交所有地区的草稿");
    await page.locator("#ticket-types-feedback.is-success").waitFor();
  };
  await card("other").locator('.channel-row[data-goods-id="1036"] .pending-type-action').click();
  let settingsRow = page.locator('#ticket-types-list [data-goods-id="1036"]');
  await settingsRow.waitFor();
  assert.equal(await page.locator('#ticket-types-destination-filter button[aria-pressed="true"]').getAttribute("data-destination"), "spot:1", "待设置商品快捷入口自动选择商品所属地区");
  assert.equal(await page.locator(".ticket-type-row").count(), 1);
  assert.equal(await settingsRow.locator('input[type="radio"]').count(), 5);
  assert.match(await settingsRow.locator(".ticket-type-destination").innerText(), /北京环球度假区/);
  await settingsRow.locator("label").filter({ hasText: /^1.5日儿童$/ }).click();
  await chooseSettingsDestination("spot:2");
  assert.equal(await page.locator(".ticket-type-row").count(), 0, "切换地区保留搜索关键词");
  await page.locator("#ticket-types-search").fill("");
  assert.equal(await page.locator(".ticket-type-row").count(), 2);
  await page.locator('#ticket-types-list [data-goods-id="1552"] label').filter({ hasText: /^1.5日儿童$/ }).click();
  await chooseSettingsDestination("spot:1");
  await page.locator("#ticket-types-search").fill("1036");
  assert.equal(await settingsRow.locator('input[value="children_1_5d"]').isChecked(), true, "地区间切换保留北京渠道未保存的修改");
  await saveSettings({ "1036": "children_1_5d", "1552": "children_1_5d" });
  await page.locator("#ticket-types-close").click();
  await card("children_1_5d").locator('.channel-row[data-goods-id="1036"]').waitFor();
  assert.equal(await page.locator("#destination-filter button[aria-pressed=\"true\"]").getAttribute("data-destination"), "", "保存票种后仍保持用户选择的全部地区");
  assert.equal(await card("children_1_5d").locator('.channel-row[data-goods-id="1036"] .local-ticket-type-label').innerText(), "本地设为1.5日儿童");
  assert.deepEqual(await card("children_1_5d").locator(".channel-row").evaluateAll((nodes) => nodes.map((node) => node.dataset.goodsId)), ["1036", "1028"]);
  const persisted = JSON.parse(await fs.readFile(path.join(outputDir, "ticket-prices.json"), "utf8"));
  assert.equal(persisted.products["1036"].group, "children_1_5d");
  assert.equal(persisted.prices.children_1_5d["1036"][date], 350);
  assert.equal(persisted.products["1552"].group, "children_1_5d");
  assert.equal(persisted.prices.children_1_5d["1552"][date], 77);
  await page.reload({ waitUntil: "networkidle" });
  await card("children_1_5d").locator('.channel-row[data-goods-id="1036"] .local-ticket-type-label').waitFor();
  assert.equal(await page.locator("#destination-filter button[aria-pressed=\"true\"]").getAttribute("data-destination"), "spot:1", "重新进入恢复默认北京环球度假区");

  await page.setViewportSize({ width: 390, height: 844 });
  await assertLayout("窄屏");
  await page.locator("#ticket-types-button").click();
  await page.locator(".ticket-type-row").first().waitFor();
  const listScroll = await page.locator("#ticket-types-list").evaluate((list) => {
    list.scrollTop = list.scrollHeight;
    const result = { height: list.clientHeight, scrollHeight: list.scrollHeight, top: list.scrollTop };
    list.scrollTop = 0;
    return result;
  });
  assert.ok(listScroll.height > 0 && listScroll.scrollHeight > listScroll.height && listScroll.top > 0, "窄屏新增地区按钮后渠道列表仍可滚动");
  await page.locator("#ticket-types-search").fill("1036");
  settingsRow = page.locator('#ticket-types-list [data-goods-id="1036"]');
  await settingsRow.waitFor();
  assert.equal(await page.locator('#ticket-types-destination-filter button[aria-pressed="true"]').getAttribute("data-destination"), "spot:1");
  assert.equal(await settingsRow.locator('input[value="children_1_5d"]').isChecked(), true);
  const dialogBounds = await page.locator("#ticket-types-dialog").evaluate((dialog) => {
    const rect = dialog.getBoundingClientRect();
    return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, viewport: innerWidth, viewportHeight: innerHeight, width: dialog.clientWidth, scrollWidth: dialog.scrollWidth };
  });
  assert.ok(dialogBounds.left >= 0 && dialogBounds.right <= dialogBounds.viewport + 1, "窄屏弹窗应处于窗口内");
  assert.ok(dialogBounds.scrollWidth <= dialogBounds.width + 1, "窄屏弹窗不应横向溢出");
  assert.ok(dialogBounds.top >= 0 && dialogBounds.bottom <= dialogBounds.viewportHeight + 1, "窄屏弹窗应完整处于视口高度内");
  await page.screenshot({ path: path.join(screenshotDir, "settings-narrow.png") });
  await settingsRow.locator("label").filter({ hasText: /^跟随接口$/ }).click();
  await chooseSettingsDestination("spot:2");
  await page.locator("#ticket-types-search").fill("1552");
  const shanghaiSettingsRow = page.locator('#ticket-types-list [data-goods-id="1552"]');
  assert.equal(await shanghaiSettingsRow.locator('input[value="children_1_5d"]').isChecked(), true, "上海渠道设置重新载入后仍保留");
  await shanghaiSettingsRow.locator("label").filter({ hasText: /^跟随接口$/ }).click();
  await saveSettings({ "1036": null, "1552": null });
  await page.locator("#ticket-types-close").click();
  await card("other").locator('.channel-row[data-goods-id="1036"]').waitFor();
  assert.equal(await card("other").locator('.channel-row[data-goods-id="1036"] .local-ticket-type-label').count(), 0);
  assert.equal(JSON.parse(await fs.readFile(path.join(outputDir, "ticket-prices.json"), "utf8")).products["1036"].group, "other");
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(testRoot, "config", "ticket-types.json"), "utf8")).overrides, {});
  await assertLayout("窄屏重置后");
  await page.screenshot({ path: path.join(screenshotDir, "dashboard-narrow.png"), fullPage: true });
  assert.deepEqual(failures, [], "页面不应出现 JavaScript 异常");
  console.log("UI 验收通过：地区按钮及默认北京环球度假区、三地区独立排序、同价并列、四类筛选、本地票种保存/重载/重置、完整标题、等大按钮及390px窄屏。");
  console.log(`截图：${screenshotDir}`);
} finally {
  await browser?.close();
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  await fs.rm(testRoot, { recursive: true, force: true });
}
