import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { applyTicketTypeOverrides, readTicketTypeOverrides, saveTicketTypeOverrides } from "../lib/ticket-type-config.ts";
import { buildPriceExport, normalizeProduct } from "../lib/ticket-prices.ts";

function fixture() {
  const products = [
    normalizeProduct({ goods_id: 1036, goods_name: "暑期特惠：北京环球影城指定日标准成人票【提前3天】", ticket_type: "CHILDREN" }),
    normalizeProduct({ goods_id: 1023, goods_name: "1日成人票", ticket_type: "ADULT" }),
    normalizeProduct({ goods_id: 1024, goods_name: "1日儿童票", ticket_type: "CHILDREN" }),
    normalizeProduct({ goods_id: 20, goods_name: "家庭票", ticket_type: "FAMILY" }),
    normalizeProduct({ goods_id: 21, goods_name: "其他票", ticket_type: "UNKNOWN" }),
  ];
  const row = (goodsId: number, date: string, price: number, extra = {}) => ({
    goods_id: goodsId, date, mall_price: price, b2b_price: price + 1, market_price: price + 5, stock: -1, valid: 1, ...extra,
  });
  return {
    ...buildPriceExport(products, {
      1036: [row(1036, "2026-11-26", 350, { stock: 0 }), row(1036, "2026-12-01", 365), row(1036, "2026-12-02", 370, { valid: 0 })],
      1023: [row(1023, "2026-11-26", 331.85)],
      1024: [row(1024, "2026-11-26", 251.46)],
      20: [row(20, "2026-11-26", 500)],
    }, { fetchedAt: "2026-11-11T12:00:00.000Z", sourceUrl: "https://xinle.xyj.link/scm/spot/getSearchData.html" }),
    collectionStatus: "complete", collection: { requestedProducts: 5, completedProducts: 5, failures: [] },
  };
}

async function directory(t: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "xinle-ticket-type-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("1036 本地成人设置优先，完整分类索引一致且不改变原始价格、日期或参数", () => {
  const source = fixture();
  const original = structuredClone(source);
  const overrides = { 1036: "adult_1d", 20: "children_1d" } as const;
  const result = applyTicketTypeOverrides(source, overrides);
  assert.deepEqual(source, original);
  assert.deepEqual(overrides, { 1036: "adult_1d", 20: "children_1d" });
  assert.equal(result.products[1036].ticketType, "ADULT");
  assert.equal(result.products[1036].group, "adult_1d");
  assert.equal(result.products[1036].sourceTicketType, "CHILDREN");
  assert.equal(result.products[1036].sourceGroup, "other");
  assert.equal(result.products[1036].ticketTypeSource, "local");
  assert.equal(result.products[1023].ticketTypeSource, "remote");
  assert.deepEqual(result.prices.adult_1d[1036], original.prices.other[1036]);
  assert.deepEqual(result.dayNumbers.adult_1d[1036], original.dayNumbers.other[1036]);
  assert.equal(result.prices.children_1d[1036], undefined);
  assert.equal(result.dayNumbers.children_1d[1036], undefined);
  assert.deepEqual(result.prices.children_1d[20], original.prices.other[20]);
  assert.deepEqual(result.prices.other[21], {});
  assert.deepEqual(result.summary.productCounts, { adult_1d: 2, children_1d: 2, adult_1_5d: 0, children_1_5d: 0, other: 1 });
  assert.equal(result.summary.priceCount, original.summary.priceCount);
  assert.equal(result.summary.excludedInvalidCount, original.summary.excludedInvalidCount);
  assert.deepEqual(result.summary.productsWithoutPrices, original.summary.productsWithoutPrices);
  assert.equal(result.fetchedAt, original.fetchedAt);
  assert.deepEqual(result.collection, original.collection);
  for (const [index, row] of result.rows.entries()) {
    const { ticketType, group, sourceTicketType, sourceGroup, ticketTypeSource, visitDays, ...unchanged } = row;
    const { ticketType: remoteType, group: remoteGroup, visitDays: remoteVisitDays, ...originalValues } = original.rows[index];
    assert.deepEqual(unchanged, originalValues);
    assert.equal(sourceTicketType, remoteType);
    assert.equal(sourceGroup, remoteGroup);
    assert.equal(group, result.products[row.goodsId].group);
    assert.equal(ticketType, result.products[row.goodsId].ticketType);
    assert.equal(ticketTypeSource, result.products[row.goodsId].ticketTypeSource);
    assert.equal(visitDays, result.products[row.goodsId].visitDays);
  }
});

test("重复应用和重新采集仍采用本地设置，恢复默认能回到接口类型及原警告", () => {
  const source = fixture();
  const changed = applyTicketTypeOverrides(source, { 1036: "adult_1d", 20: "children_1d" });
  assert.deepEqual(applyTicketTypeOverrides(changed, { 1036: "adult_1d", 20: "children_1d" }), changed);
  assert.equal(applyTicketTypeOverrides(fixture(), { 1036: "adult_1d" }).products[1036].group, "adult_1d");
  const restored = applyTicketTypeOverrides(changed, {});
  assert.equal(restored.products[1036].ticketType, "CHILDREN");
  assert.equal(restored.products[1036].ticketTypeSource, "remote");
  assert.equal(restored.products[1036].sourceGroup, "other");
  assert.equal(restored.products[20].ticketType, "FAMILY");
  assert.deepEqual(restored.prices, source.prices);
  assert.deepEqual(restored.dayNumbers, source.dayNumbers);
  assert.deepEqual(restored.summary, source.summary);
  assert.deepEqual([...restored.warnings].sort(), [...source.warnings].sort());
  assert.deepEqual([...restored.sourceWarnings].sort(), [...source.warnings].sort());
});

test("本地设置只抑制对应渠道的票种提示，库存、空价格和其他渠道警告仍保留", () => {
  const source = fixture();
  const result = applyTicketTypeOverrides(source, { 1036: "adult_1d", 20: "children_1d" });
  assert.equal(result.warnings.some(warning => warning.includes("1036") && warning.includes("票种待设置")), false);
  assert.equal(result.warnings.some(warning => warning.includes("商品 20 票种")), false);
  assert.ok(result.warnings.some(warning => warning.includes("1036") && warning.includes("stock=0")));
  assert.ok(result.warnings.some(warning => warning.includes("商品 21 票种")));
  assert.ok(result.warnings.some(warning => warning.includes("商品 21 未返回")));
  assert.deepEqual([...result.sourceWarnings].sort(), [...source.warnings].sort());
});

test("持久化部分更新，null 恢复接口，保留未提交和当前没有出现的渠道", async t => {
  const root = await directory(t);
  assert.deepEqual(readTicketTypeOverrides(root), {});
  await saveTicketTypeOverrides({ overrides: { 1036: "adult_1d", 1023: "children_1d", 987654: "adult_1d" } }, root);
  const saved = await saveTicketTypeOverrides({ overrides: { 1023: null } }, root);
  assert.deepEqual(saved, { 1036: "adult_1d", 987654: "adult_1d" });
  assert.deepEqual(readTicketTypeOverrides(root), saved);
  assert.deepEqual(JSON.parse(await readFile(path.join(root, "config", "ticket-types.json"), "utf8")).overrides, saved);
  assert.equal(applyTicketTypeOverrides(fixture(), readTicketTypeOverrides(root)).products[1036].group, "adult_1d");
  const lastSnapshot = applyTicketTypeOverrides(fixture(), saved);
  await saveTicketTypeOverrides({ overrides: { 1036: null } }, root);
  const restored = applyTicketTypeOverrides(lastSnapshot, readTicketTypeOverrides(root));
  assert.equal(restored.products[1036].group, "other");
  assert.equal(restored.products[1036].ticketTypeSource, "remote");
  assert.deepEqual(readTicketTypeOverrides(root), { 987654: "adult_1d" });
  assert.deepEqual(await readdir(path.join(root, "config")), ["ticket-types.json"]);
});

test("同一目录并发部分更新不丢数据，同渠道更新按提交顺序生效", async t => {
  const root = await directory(t);
  await Promise.all(Array.from({ length: 20 }, (_, index) => saveTicketTypeOverrides({ overrides: { [2000 + index]: index % 2 ? "adult_1d" : "children_1d" } }, root)));
  const expected = Object.fromEntries(Array.from({ length: 20 }, (_, index) => [2000 + index, index % 2 ? "adult_1d" : "children_1d"]));
  assert.deepEqual(readTicketTypeOverrides(root), expected);
  await Promise.all([
    saveTicketTypeOverrides({ overrides: { 1036: "adult_1d" } }, root),
    saveTicketTypeOverrides({ overrides: { 1036: "children_1d" } }, path.join(root, ".")),
    saveTicketTypeOverrides({ overrides: { 1036: null } }, root),
  ]);
  assert.deepEqual(readTicketTypeOverrides(root), expected);
  assert.deepEqual(await readdir(path.join(root, "config")), ["ticket-types.json"]);
});

test("拒绝无效输入且不覆盖旧配置，损坏文件不会静默清空", async t => {
  const root = await directory(t);
  await saveTicketTypeOverrides({ overrides: { 1036: "adult_1d" } }, root);
  const file = path.join(root, "config", "ticket-types.json");
  const original = await readFile(file, "utf8");
  const invalid = [null, [], {}, { overrides: null }, { overrides: [] }, { overrides: { 0: "adult_1d" } }, { overrides: { "01": "adult_1d" } }, { overrides: { "1.5": "adult_1d" } }, { overrides: { "-1": "adult_1d" } }, { overrides: { "9007199254740992": "adult_1d" } }, { overrides: { 1036: "ADULT" } }, { overrides: { 1036: "other" } }, { overrides: { 1036: false } }, JSON.parse('{"overrides":{"__proto__":"adult_1d"}}')];
  for (const input of invalid) {
    await assert.rejects(saveTicketTypeOverrides(input, root));
    assert.equal(await readFile(file, "utf8"), original);
  }
  await writeFile(file, "{invalid json");
  assert.throws(() => readTicketTypeOverrides(root), /配置无效/);
  await assert.rejects(saveTicketTypeOverrides({ overrides: { 1023: "children_1d" } }, root), /配置无效/);
  assert.equal(await readFile(file, "utf8"), "{invalid json");
  await writeFile(file, original);
  await saveTicketTypeOverrides({ overrides: { 1023: "children_1d" } }, root);
  assert.deepEqual(readTicketTypeOverrides(root), { 1036: "adult_1d", 1023: "children_1d" });
});

test("四种本地票种可指定时长和人群，刷新与重置保留原始来源", () => {
  const source = fixture();
  const mapping = { 1023: "children_1_5d", 1024: "adult_1_5d", 1036: "adult_1d", 20: "children_1d" } as const;
  const result = applyTicketTypeOverrides(source, mapping);
  assert.equal(result.products[1023].group, "children_1_5d");
  assert.equal(result.products[1023].visitDays, 1.5);
  assert.equal(result.products[1023].ticketType, "CHILDREN");
  assert.equal(result.products[1023].sourceTicketType, "ADULT");
  assert.equal(result.products[1023].sourceGroup, "adult_1d");
  assert.equal(result.products[1024].visitDays, 1.5);
  assert.deepEqual(result.prices.children_1_5d[1023], source.prices.adult_1d[1023]);
  assert.deepEqual(applyTicketTypeOverrides(fixture(), mapping), result);
  assert.deepEqual(applyTicketTypeOverrides(result, mapping), result);
  const restored = applyTicketTypeOverrides(result, {});
  assert.equal(restored.products[1023].group, "adult_1d");
  assert.equal(restored.products[1023].visitDays, 1);
  assert.equal(restored.products[1036].group, "other");
  assert.equal(restored.products[1036].classificationReason?.includes("冲突"), true);
  assert.deepEqual(restored.prices, source.prices);
});

test("旧版配置 adult/children 读取及后续保存迁移为1日，不丢下架渠道设置", async t => {
  const root = await directory(t);
  await saveTicketTypeOverrides({ overrides: { 1036: "adult", 987654: "children" } }, root);
  assert.deepEqual(readTicketTypeOverrides(root), { 1036: "adult_1d", 987654: "children_1d" });
  const file = path.join(root, "config", "ticket-types.json");
  await writeFile(file, JSON.stringify({ overrides: { 1036: "adult", 987654: "children" } }));
  assert.deepEqual(readTicketTypeOverrides(root), { 1036: "adult_1d", 987654: "children_1d" });
  await saveTicketTypeOverrides({ overrides: { 1024: "children_1_5d" } }, root);
  const expected = { 1036: "adult_1d", 987654: "children_1d", 1024: "children_1_5d" };
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")).overrides, expected);
  assert.equal(applyTicketTypeOverrides(fixture(), { 1036: "adult" }).products[1036].group, "adult_1d");
});

test("旧快照重新推断四类且保留原金额日期，旧本地来源字段支持正确恢复", () => {
  const original = fixture();
  const legacy: any = structuredClone(original);
  legacy.schemaVersion = 1;
  legacy.prices = { adult: {}, children: {}, other: {} };
  legacy.dayNumbers = { adult: {}, children: {}, other: {} };
  delete legacy.summary.destinationCount;
  legacy.summary.productCounts = { adult: 0, children: 0, other: 0 };
  for (const [id, product] of Object.entries(legacy.products) as [string, any][]) {
    const source = original.products[id];
    const previousGroup = source.ticketType === "ADULT" ? "adult" : source.ticketType === "CHILDREN" ? "children" : "other";
    product.group = previousGroup;
    delete product.visitDays;
    delete product.destinationKey;
    delete product.destinationName;
    delete product.classificationReason;
    legacy.prices[previousGroup][id] = original.prices[source.group][id];
    legacy.dayNumbers[previousGroup][id] = original.dayNumbers[source.group][id];
    legacy.summary.productCounts[previousGroup]++;
  }
  // 模拟旧版已人工将 1036 修正为成人，保存了 CHILDREN 来源字段。
  legacy.products[1036].sourceTicketType = "CHILDREN";
  legacy.products[1036].sourceGroup = "children";
  legacy.products[1036].ticketType = "ADULT";
  legacy.products[1036].group = "adult";
  legacy.prices.adult[1036] = legacy.prices.children[1036];
  legacy.dayNumbers.adult[1036] = legacy.dayNumbers.children[1036];
  delete legacy.prices.children[1036];
  delete legacy.dayNumbers.children[1036];
  for (const row of legacy.rows) {
    row.group = legacy.products[row.goodsId].group;
    delete row.visitDays;
    delete row.destinationKey;
    delete row.destinationName;
  }
  const preserved = structuredClone(legacy);
  const migrated = applyTicketTypeOverrides(legacy, { 1036: "adult" });
  assert.deepEqual(legacy, preserved);
  assert.equal(migrated.schemaVersion, 2);
  assert.equal(migrated.products[1036].sourceGroup, "other");
  assert.equal(migrated.products[1036].group, "adult_1d");
  assert.deepEqual(migrated.prices.adult_1d[1036], original.prices.other[1036]);
  assert.deepEqual(migrated.dayNumbers.adult_1d[1036], original.dayNumbers.other[1036]);
  assert.equal(migrated.fetchedAt, original.fetchedAt);
  assert.equal(migrated.rows.length, original.rows.length);
  assert.deepEqual(migrated.rows.map(row => [row.goodsId, row.date, row.mallPrice, row.valid, row.stock]), original.rows.map(row => [row.goodsId, row.date, row.mallPrice, row.valid, row.stock]));
  assert.deepEqual(applyTicketTypeOverrides(migrated, {}).prices, original.prices);
});
