import test from "node:test";
import assert from "node:assert/strict";
import { buildPriceExport, classifyTicket, normalizeProduct, productDestination } from "../lib/ticket-prices.ts";

const adult = normalizeProduct({ goods_id: 1023, goods_name: "1日成人票", ticket_type: "ADULT" });
const child = normalizeProduct({ goods_id: 1024, goods_name: "1日儿童票", ticket_type: "CHILDREN" });
function record(goodsId: number, date: string, price: unknown, extra = {}) {
  return { goods_id: goodsId, date, b2b_price: price, mall_price: price, valid: 1, stock: -1, ...extra };
}

test("按显式票种分组，日历价转换成数值并保留 -1 库存", () => {
  const result = buildPriceExport([adult, child], {
    1023: [record(1023, "2026-11-26", "331.85", { market_price: "335.20" })],
    1024: [record(1024, "2026-11-26", 251.46)],
  });
  assert.equal(result.priceSource, "mall_price");
  assert.equal(result.prices.adult_1d[1023]["2026-11-26"], 331.85);
  assert.equal(result.prices.children_1d[1024]["2026-11-26"], 251.46);
  assert.equal(result.rows[0].stock, -1);
  assert.equal(result.rows[0].marketPrice, 335.2);
  assert.deepEqual(result.summary.productCounts, { adult_1d: 1, children_1d: 1, adult_1_5d: 0, children_1_5d: 0, other: 0 });
  assert.equal(result.summary.priceCount, 2);
});

test("日历价和平台价不同时使用 mall_price，明细保留两种价格", () => {
  const result = buildPriceExport([adult], {
    1023: [record(1023, "2026-11-26", 331.85, { mall_price: "320.50", market_price: "335.20" })],
  });
  assert.equal(result.prices.adult_1d[1023]["2026-11-26"], 320.5);
  assert.equal(result.dayNumbers.adult_1d[1023]["2026-11"][26], 320.5);
  assert.equal(result.rows[0].mallPrice, 320.5);
  assert.equal(result.rows[0].b2bPrice, 331.85);
  assert.equal(result.rows[0].marketPrice, 335.2);
});

test("跨月同日价格各自保留，日号结构按年月分组", () => {
  const result = buildPriceExport([adult], {
    1023: [record(1023, "2026-12-01", 390.2), record(1023, "2026-11-01", 331.85)],
  });
  assert.deepEqual(result.prices.adult_1d[1023], { "2026-11-01": 331.85, "2026-12-01": 390.2 });
  assert.deepEqual(result.dayNumbers.adult_1d[1023], { "2026-11": { 1: 331.85 }, "2026-12": { 1: 390.2 } });
  assert.equal(result.summary.dateStart, "2026-11-01");
  assert.equal(result.summary.dateEnd, "2026-12-01");
});

test("1036 名称和票种冲突进入待设置，保留原接口票种和价格", () => {
  const product = normalizeProduct({
    goods_id: 1036,
    goods_name: "暑期特惠：北京环球影城指定日标准成人票【提前3天】",
    ticket_type: "CHILDREN",
  });
  const result = buildPriceExport([product], { 1036: [record(1036, "2026-11-26", 350)] });
  assert.equal(result.prices.other[1036]["2026-11-26"], 350);
  assert.equal(result.products[1036].ticketType, "CHILDREN");
  assert.equal(result.prices.adult_1d[1036], undefined);
  assert.ok(result.warnings.some((warning) => warning.includes("1036") && warning.includes("冲突")));
});

test("无效日期不进入价格表，但保留明细；stock=0 不静默过滤", () => {
  const result = buildPriceExport([adult], {
    1023: [
      record(1023, "2026-11-26", 331.85, { valid: 0 }),
      record(1023, "2026-11-27", 331.85, { stock: 0 }),
    ],
  });
  assert.deepEqual(result.prices.adult_1d[1023], { "2026-11-27": 331.85 });
  assert.equal(result.rows.length, 2);
  assert.equal(result.rows[0].includedInPrices, false);
  assert.equal(result.summary.excludedInvalidCount, 1);
  assert.equal(result.summary.zeroStockRecordCount, 1);
  assert.ok(result.warnings.some((warning) => warning.includes("stock=0")));
});

test("不同价格的重复日期抛错，相同价格的重复记录合并并警告", () => {
  assert.throws(() => buildPriceExport([adult], {
    1023: [record(1023, "2026-11-26", 331.85), record(1023, "2026-11-26", 332)],
  }), /1023.*2026-11-26.*冲突/);
  const result = buildPriceExport([adult], {
    1023: [record(1023, "2026-11-26", "331.85"), record(1023, "2026-11-26", 331.85)],
  });
  assert.equal(result.rows.length, 1);
  assert.equal(result.summary.sourceRecordCount, 2);
  assert.ok(result.warnings.some((warning) => warning.includes("重复返回")));
  for (const changed of [{ mall_price: 320 }, { b2b_price: 320 }, { market_price: 320 }]) {
    assert.throws(() => buildPriceExport([adult], {
      1023: [record(1023, "2026-11-26", 331.85), record(1023, "2026-11-26", 331.85, changed)],
    }), /1023.*2026-11-26.*冲突/);
  }
});

test("无效金额抛出可定位错误，不产生 NaN 或 null 日历价", () => {
  for (const value of [undefined, null, "", "NaN", "oops", NaN, Infinity, -1, true, "1e2"]) {
    assert.throws(() => buildPriceExport([adult], {
      1023: [record(1023, "2026-11-26", value)],
    }), /1023.*2026-11-26.*b2b_price.*金额不合法/);
    assert.throws(() => buildPriceExport([adult], {
      1023: [record(1023, "2026-11-26", 100, { mall_price: value })],
    }), /1023.*2026-11-26.*mall_price.*金额不合法/);
  }
  assert.throws(() => buildPriceExport([adult], {
    1023: [record(1023, "2026-11-26", 100, { market_price: "bad" })],
  }), /market_price.*金额不合法/);
});

test("检查真实日历日期，支持闰年并拒绝坏格式和不存在的日期", () => {
  for (const date of ["2026-02-29", "2026-11-31", "2026-13-01", "2026-00-10", "2026-11-00", "0000-01-01", "2026-1-1"]) {
    assert.throws(() => buildPriceExport([adult], { 1023: [record(1023, date, 100)] }), /日期/);
  }
  assert.equal(buildPriceExport([adult], {
    1023: [record(1023, "2028-02-29", 100)],
  }).prices.adult_1d[1023]["2028-02-29"], 100);
});

test("空结果和其他票种可导出，元数据仅保留所需字段", () => {
  const result = buildPriceExport([], {}, { fetchedAt: "2026-11-11T00:00:00.000Z", sourceUrl: "https://example.test/prices" });
  assert.equal(result.summary.productCount, 0);
  assert.equal(result.summary.dateStart, null);
  assert.deepEqual(result.rows, []);
  const product = normalizeProduct({
    goods_id: "20", goods_name: "家庭票", ticket_type: "FAMILY", interface_keys: "must-not-export",
  }, { spot_id: 1040, spot_name: "北京环球度假区" });
  assert.equal(product.spotId, 1040);
  assert.equal(product.spotName, "北京环球度假区");
  assert.equal("interface_keys" in product, false);
  const noPrices = buildPriceExport([product], {});
  assert.deepEqual(noPrices.prices.other[20], {});
  assert.deepEqual(noPrices.summary.productsWithoutPrices, [20]);
});

test("拒绝商品ID不匹配和孤立价格，避免错误归组", () => {
  assert.throws(() => buildPriceExport([adult], { 1023: [record(1024, "2026-11-26", 100)] }), /goods_id 不匹配/);
  assert.throws(() => buildPriceExport([adult], { 1024: [] }), /未收集的商品 1024/);
});

test("年卡价格记录ID为0是合法占位，保留价格库存且不放宽商品ID校验", () => {
  const annual = normalizeProduct({ goods_id: 1042, goods_name: "北京环球影城年卡", ticket_type: "ADULT" });
  const result = buildPriceExport([adult, annual], {
    1023: [record(1023, "2026-11-12", 331.85, { goods_price_id: 84522 })],
    1042: [record(1042, "2026-11-12", 999, { goods_price_id: 0, stock: 0, market_price: "999.00" })],
  });
  assert.equal(result.rows.find(row => row.goodsId === 1042)?.goodsPriceId, 0);
  assert.equal(result.prices.other[1042]["2026-11-12"], 999);
  assert.equal(result.summary.priceCount, 2);
  assert.ok(result.warnings.some(warning => warning.includes("1042") && warning.includes("stock=0")));
  assert.throws(() => normalizeProduct({ goods_id: 0 }), /goods_id.*正整数/);
  assert.throws(() => buildPriceExport([annual], { 1042: [record(1042, "2026-11-12", 999, { goods_price_id: -1 })] }), /goods_price_id.*非负整数/);
});

test("自动识别四种单人票时长与人群，接口不限人群时使用明确名称", () => {
  const cases = [
    ["北京环球影城-1日标准票-提前15天预定", "ADULT", "adult_1d", 1],
    ["上海迪士尼乐园1日儿童票", "UNLIMITED", "children_1d", 1],
    ["【惊彩环球】北京环球影城1日+美食套餐-标准票1张", "ADULT", "adult_1d", 1],
    ["指定1.5日门票成人票", "ADULT", "adult_1_5d", 1.5],
    ["1.5日儿童票-提前1天预定", "CHILDREN", "children_1_5d", 1.5],
    ["一天半成人票", "ALL", "adult_1_5d", 1.5],
    ["1.5天儿童票", "CHILDREN", "children_1_5d", 1.5],
    ["一日成人票", "ADULT", "adult_1d", 1],
    ["1天儿童票", "CHILDREN", "children_1d", 1],
    ["单日成人票-单人票【提前5天】", "ADULT", "adult_1d", 1],
    ["1日儿童票-2日内预定", "CHILDREN", "children_1d", 1],
  ] as const;
  for (const [name, source, group, days] of cases) {
    assert.deepEqual(classifyTicket(name, source), { group, visitDays: days, reason: null }, name);
  }
});

test("预订天数不冒充游玩时长，无法确认、多人和其他人群保留待设置", () => {
  const cases = [
    ["成人票提前15天预定", "ADULT"], ["成人票提前1天预定", "ADULT"],
    ["儿童票2日内预定", "CHILDREN"], ["儿童票2026年11月1日", "CHILDREN"],
    ["【三人票】北京环球单日门票", "UNLIMITED"], ["1日家庭票", "ADULT"],
    ["1.5日2大2小票", "CHILDREN"], ["1日成人儿童套票", "ADULT"],
    ["1日票两张成人票", "ADULT"], ["1日一大一小票", "ADULT"], ["1日10人票", "ADULT"],
    ["1日票", "UNLIMITED"], ["1日儿童票", "ADULT"],
    ["1.5日儿童票", "FAMILY"], ["1.5日儿童票", "PARENTAGE"],
    ["0.5日成人票", "ADULT"], ["2日成人票", "ADULT"],
    ["1日老人票", "ADULT"], ["1日青年票", "UNLIMITED"], ["年卡成人票", "ADULT"],
  ];
  for (const [name, source] of cases) {
    const classification = classifyTicket(name, source);
    assert.equal(classification.group, "other", name);
    assert.ok(classification.reason, name);
  }
});

test("各景区同日同票种独立保留，地区键来自原景区ID或名称", () => {
  const beijing = normalizeProduct({ goods_id: 1023, goods_name: "1日成人票", ticket_type: "ADULT", spot_id: 1040, spot_name: "北京环球度假区" });
  const shanghai = normalizeProduct({ goods_id: 1504, goods_name: "1日成人票", ticket_type: "ADULT", spot_id: 1024, spot_name: "上海迪士尼度假区" });
  const result = buildPriceExport([beijing, shanghai], {
    1023: [record(1023, "2026-11-26", 331.85)], 1504: [record(1504, "2026-11-26", 404)],
  });
  assert.equal(result.products[1023].destinationKey, "spot:1040");
  assert.equal(result.products[1504].destinationKey, "spot:1024");
  assert.equal(result.summary.destinationCount, 2);
  assert.equal(result.prices.adult_1d[1023]["2026-11-26"], 331.85);
  assert.equal(result.prices.adult_1d[1504]["2026-11-26"], 404);
  assert.deepEqual(productDestination({ spotName: " 上海景区 " }), { destinationKey: "name:上海景区", destinationName: "上海景区" });
  assert.equal(productDestination({}).destinationKey, "unknown");
});
