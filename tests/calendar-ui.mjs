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
const screenshotDir = path.join(root, "build", "calendar-ui");
const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "xinle-calendar-ui-"));
const outputDir = path.join(testRoot, "output");
const areas = [
  { spot_id: 1, spot_name: "北京环球度假区" },
  { spot_id: 2, spot_name: "上海迪士尼度假区" },
];
const specifications = [
  [101, "北京环球影城-1日成人票-渠道A", "ADULT", 0],
  [102, "北京环球影城-1日成人票-渠道B", "ADULT", 0],
  [103, "北京环球影城-1日成人票-无库存渠道", "ADULT", 0],
  [104, "北京环球影城-1日成人票-无效渠道", "ADULT", 0],
  [201, "北京环球影城-1日儿童票", "CHILDREN", 0],
  [301, "北京环球影城-1.5日成人票", "ADULT", 0],
  [401, "北京环球影城-1.5日儿童票", "CHILDREN", 0],
  [501, "上海迪士尼-1日成人票", "ADULT", 1],
  [601, "上海迪士尼-1日儿童票", "CHILDREN", 1],
  [701, "上海迪士尼-1.5日成人票", "ADULT", 1],
  [801, "上海迪士尼-1.5日儿童票", "CHILDREN", 1],
  [901, "北京环球影城特惠成人票-游玩时长待确认", "ADULT", 0],
];
const products = specifications.map(([goods_id, goods_name, ticket_type, area]) =>
  normalizeProduct({ goods_id, goods_name, ticket_type }, areas[area]));
const record = (price, date = "2028-02-01", stock = 10, valid = 1) => ({ date, b2b_price: price, mall_price: price, market_price: price + 10, stock, valid });
const rawPrices = {
  "101": [record(300), record(0, "2028-02-29"), record(321, "2028-03-31"), record(555, "2028-05-01")],
  "102": [record(250)], "103": [record(100, "2028-02-01", 0)], "104": [record(90, "2028-02-01", 10, 0)],
  "201": [record(180)], "301": [record(450)], "401": [record(350)],
  "501": [record(1)], "601": [record(2)], "701": [record(3)], "801": [record(4)], "901": [record(50)],
};
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
  server = createDashboardServer({ outputDir, configRoot: testRoot, runRefresh: async () => { throw new Error("日历 UI fixture 不请求外部网站"); } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ channel: "msedge", headless: true, args: ["--no-proxy-server"] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(10_000);
  page.on("pageerror", (error) => failures.push(error.message));
  await page.goto(base, { waitUntil: "networkidle" });
  await page.locator('.channel-row[data-goods-id="101"]').first().waitFor();
  const calendar = (group = "adult_1d", destination = "spot:1") => page.locator(`.price-calendar[data-group="${group}"][data-destination="${destination}"]`);
  const day = (date, group = "adult_1d", destination = "spot:1") => calendar(group, destination).locator(`.calendar-day[data-date="${date}"]`);
  const setView = async (view) => {
    await page.locator(`#view-mode button[data-view="${view}"]`).click();
    assert.equal(await page.locator(`#view-mode button[data-view="${view}"]`).getAttribute("aria-pressed"), "true");
  };
  const setDestination = async (destination) => {
    await page.locator(`#destination-filter button[data-destination="${destination}"]`).click();
    assert.equal(await page.locator('#destination-filter button[aria-pressed="true"]').getAttribute("data-destination"), destination);
  };
  const clearDate = async () => {
    await page.locator("#calendar-selection .calendar-clear").click();
    assert.equal(await page.locator("#calendar-selection").isVisible(), false);
    assert.equal(await page.locator('#view-mode button[data-view="calendar"]').getAttribute("aria-pressed"), "true");
  };
  const checkMonth = async (month, days, leadingBlanks) => {
    const first = calendar();
    assert.equal(await first.locator(".calendar-day").count(), days);
    assert.equal(await first.locator(".calendar-day").first().getAttribute("data-date"), `${month}-01`);
    assert.equal(await first.locator(".calendar-day").last().getAttribute("data-date"), `${month}-${days}`);
    const blanks = await first.locator(".calendar-day").first().evaluate((node) => {
      let count = 0;
      for (let previous = node.previousElementSibling; previous; previous = previous.previousElementSibling) {
        if (previous.classList.contains("calendar-blank")) count++;
      }
      return count;
    });
    assert.equal(blanks, leadingBlanks, "日历以周日开头并正确补齐月初空格");
    assert.ok((await page.locator(".calendar-month-title").first().innerText()).includes(String(Number(month.slice(5)))));
  };
  const price = async (date, group, destination) => Number(await day(date, group, destination).getAttribute("data-price"));
  const checkLayout = async () => {
    const bounds = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth }));
    assert.ok(bounds.scrollWidth <= bounds.width + 1, "日历页面不应横向溢出");
  };

  assert.equal(await page.locator('#view-mode button[data-view="list"]').getAttribute("aria-pressed"), "true", "默认使用列表视图");
  await setView("calendar");
  await page.locator("#calendar-view").waitFor();
  assert.equal(await page.locator(".price-calendar").count(), 4);
  await checkMonth("2028-02", 29, 2);
  for (const [group, minimum] of [["adult_1d", 250], ["children_1d", 180], ["adult_1_5d", 450], ["children_1_5d", 350]]) {
    assert.equal(await price("2028-02-01", group), minimum, `${group} 按同地区同票种选可预订最低价`);
    assert.ok((await day("2028-02-01", group).locator(".calendar-day-price").innerText()).includes(String(minimum)));
  }
  const emptyDay = day("2028-02-02");
  assert.equal(await emptyDay.isDisabled(), true);
  assert.match(await emptyDay.innerText(), /暂无/);
  assert.ok([null, ""].includes(await emptyDay.getAttribute("data-price")), "无报价不应写为0元");
  assert.equal(await price("2028-02-29"), 0, "真正的0元价格仍然有效");
  assert.equal(await day("2028-02-29").isDisabled(), false);

  await day("2028-02-01").click();
  await page.locator("#calendar-selection").waitFor();
  assert.equal(await page.locator('#view-mode button[data-view="calendar"]').getAttribute("aria-pressed"), "true");
  assert.equal(await page.locator("#daily-list .day-section").count(), 1);
  assert.equal(await page.locator("#daily-list .day-section").getAttribute("data-date"), "2028-02-01");
  assert.equal(await page.locator('#daily-list .channel-row[data-goods-id="102"]').getAttribute("data-rank"), "1");
  await clearDate();

  await page.locator('.segmented button[data-type="children_1_5d"]').click();
  assert.equal(await page.locator(".price-calendar").count(), 1);
  assert.equal(await page.locator(".price-calendar").getAttribute("data-group"), "children_1_5d");
  await page.locator('.segmented button[data-type="other"]').click();
  assert.equal(await page.locator(".price-calendar").count(), 0);
  assert.match(await page.locator("#calendar-view").innerText(), /待设置/);
  await page.locator('.segmented button[data-type="all"]').click();
  await setDestination("");
  assert.equal(await page.locator(".calendar-destination").count(), 2);
  assert.equal(await page.locator(".price-calendar").count(), 8);
  assert.equal(await price("2028-02-01", "adult_1d", "spot:1"), 250);
  assert.equal(await price("2028-02-01", "adult_1d", "spot:2"), 1, "不同旅游地区不能混合取最低价");
  await page.screenshot({ path: path.join(screenshotDir, "all-destinations.png"), fullPage: true });
  await setDestination("spot:1");

  assert.equal(await page.locator(".calendar-month-prev").first().isDisabled(), true);
  await page.locator(".calendar-month-next").first().click();
  await checkMonth("2028-03", 31, 3);
  assert.equal(await price("2028-03-31"), 321);
  await page.locator(".calendar-month-next").first().click();
  await checkMonth("2028-05", 31, 1);
  assert.equal(await page.locator(".calendar-month-next").first().isDisabled(), true, "只遍历有数据月份并跳过4月");
  await page.locator(".calendar-month-prev").first().click();
  await checkMonth("2028-03", 31, 3);
  await page.locator(".calendar-month-prev").first().click();
  await checkMonth("2028-02", 29, 2);
  await day("2028-02-29").click();
  assert.equal(await page.locator('#daily-list .channel-row[data-goods-id="101"]').getAttribute("data-price"), "0");
  await clearDate();

  await page.locator("#ticket-types-button").click();
  await page.locator("#ticket-types-search").fill("901");
  const setting = page.locator('#ticket-types-list [data-goods-id="901"]');
  await setting.waitFor();
  await setting.locator("label").filter({ hasText: /^1日成人$/ }).click();
  const saved = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/ticket-types" && response.request().method() === "POST");
  await page.locator("#ticket-types-save").click();
  assert.equal((await saved).status(), 200);
  await page.locator("#ticket-types-feedback.is-success").waitFor();
  await page.locator("#ticket-types-close").click();
  await page.waitForFunction(() => document.querySelector('.price-calendar[data-group="adult_1d"][data-destination="spot:1"] .calendar-day[data-date="2028-02-01"]')?.getAttribute("data-price") === "50");
  assert.equal(await page.locator('#view-mode button[data-view="calendar"]').getAttribute("aria-pressed"), "true", "修改本地票种后保留日历模式");
  assert.equal(JSON.parse(await fs.readFile(path.join(outputDir, "ticket-prices.json"), "utf8")).products["901"].group, "adult_1d");
  await day("2028-02-01").click();
  assert.equal(await page.locator('#daily-list .channel-row[data-goods-id="901"]').getAttribute("data-rank"), "1");
  await clearDate();
  await checkLayout();
  await page.screenshot({ path: path.join(screenshotDir, "calendar-desktop.png"), fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await checkLayout();
  await day("2028-02-01").click();
  await page.locator("#calendar-selection").waitFor();
  await checkLayout();
  await page.screenshot({ path: path.join(screenshotDir, "calendar-narrow.png"), fullPage: true });
  await clearDate();
  await setView("list");
  assert.equal(await page.locator("#calendar-view").isVisible(), false);
  assert.ok(await page.locator("#daily-list .day-section").count() > 0);
  await checkLayout();
  assert.deepEqual(failures, [], "页面不应出现JavaScript异常");
  console.log("日历UI验收通过：四类最低价、库存/有效状态排除、0元与空价、地区隔离、闰月/月末、月份切换、每日详情、设置后重绘、列表切换及390px布局。");
  console.log(`截图：${screenshotDir}`);
} finally {
  await browser?.close();
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  await fs.rm(testRoot, { recursive: true, force: true });
}
