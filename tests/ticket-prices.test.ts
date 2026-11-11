import test from "node:test";
import assert from "node:assert/strict";
import { buildPriceExport, normalizeProduct } from "../lib/ticket-prices.ts";

const adult = normalizeProduct({ goods_id: 1023, goods_name: "成人票", ticket_type: "ADULT" });
const child = normalizeProduct({ goods_id: 1024, goods_name: "儿童票", ticket_type: "CHILDREN" });
function record(goodsId: number, date: string, price: unknown, extra = {}) {
  return { goods_id: goodsId, date, b2b_price: price, mall_price: price, valid: 1, stock: -1, ...extra };
}

test("按显式票种分组，日历价转换成数值并保留 -1 库存", () => {
  const result = buildPriceExport([adult, child], {
    1023: [record(1023, "2026-11-26", "331.85", { market_price: "335.20" })],
    1024: [record(1024, "2026-11-26", 251.46)],
  });
  assert.equal(result.priceSource, "mall_price");
  assert.equal(result.prices.adult[1023]["2026-11-26"], 331.85);
  assert.equal(result.prices.children[1024]["2026-11-26"], 251.46);
  assert.equal(result.rows[0].stock, -1);
  assert.equal(result.rows[0].marketPrice, 335.2);
  assert.deepEqual(result.summary.productCounts, { adult: 1, children: 1, other: 0 });
  assert.equal(result.summary.priceCount, 2);
});

test("日历价和平台价不同时使用 mall_price，明细保留两种价格", () => {
  const result = buildPriceExport([adult], {
    1023: [record(1023, "2026-11-26", 331.85, { mall_price: "320.50", market_price: "335.20" })],
  });
  assert.equal(result.prices.adult[1023]["2026-11-26"], 320.5);
  assert.equal(result.dayNumbers.adult[1023]["2026-11"][26], 320.5);
  assert.equal(result.rows[0].mallPrice, 320.5);
  assert.equal(result.rows[0].b2bPrice, 331.85);
  assert.equal(result.rows[0].marketPrice, 335.2);
});

test("跨月同日价格各自保留，日号结构按年月分组", () => {
  const result = buildPriceExport([adult], {
    1023: [record(1023, "2026-12-01", 390.2), record(1023, "2026-11-01", 331.85)],
  });
  assert.deepEqual(result.prices.adult[1023], { "2026-11-01": 331.85, "2026-12-01": 390.2 });
  assert.deepEqual(result.dayNumbers.adult[1023], { "2026-11": { 1: 331.85 }, "2026-12": { 1: 390.2 } });
  assert.equal(result.summary.dateStart, "2026-11-01");
  assert.equal(result.summary.dateEnd, "2026-12-01");
});

test("1036 名称和票种冲突时警告，不把 CHILDREN 改成成人票", () => {
  const product = normalizeProduct({
    goods_id: 1036,
    goods_name: "暑期特惠：北京环球影城指定日标准成人票【提前3天】",
    ticket_type: "CHILDREN",
  });
  const result = buildPriceExport([product], { 1036: [record(1036, "2026-11-26", 350)] });
  assert.equal(result.prices.children[1036]["2026-11-26"], 350);
  assert.equal(result.prices.adult[1036], undefined);
  assert.ok(result.warnings.some((warning) => warning.includes("1036") && warning.includes("冲突")));
});

test("无效日期不进入价格表，但保留明细；stock=0 不静默过滤", () => {
  const result = buildPriceExport([adult], {
    1023: [
      record(1023, "2026-11-26", 331.85, { valid: 0 }),
      record(1023, "2026-11-27", 331.85, { stock: 0 }),
    ],
  });
  assert.deepEqual(result.prices.adult[1023], { "2026-11-27": 331.85 });
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
  }).prices.adult[1023]["2028-02-29"], 100);
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
