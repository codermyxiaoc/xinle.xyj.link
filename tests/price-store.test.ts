import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rmdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildPriceExport, normalizeProduct } from "../lib/ticket-prices.ts";
import { persistPriceExport } from "../lib/price-store.ts";

function fixture(price = 331.85) {
  const product = normalizeProduct({
    goods_id: 1023, goods_name: '1日成人票,"测试"', ticket_type: "ADULT",
    spot_id: 1040, spot_name: "北京环球度假区",
  });
  return {
    ...buildPriceExport([product], {
      1023: [{ goods_id: 1023, date: "2026-11-26", mall_price: price, b2b_price: price, market_price: 335.2, valid: 1, stock: -1 }],
    }, { fetchedAt: "2026-11-11T08:18:51.206Z" }),
    collectionStatus: "complete",
    collection: { requestedProducts: 1, completedProducts: 1, failures: [] },
  };
}

async function temporaryDirectory(t: test.TestContext) {
  const directory = await mkdtemp(path.join(tmpdir(), "xinle-price-store-test-"));
  t.after(async () => {
    // 只删除此测试独占目录中的直接文件，不进行递归删除。
    for (const name of await readdir(directory)) await unlink(path.join(directory, name));
    await rmdir(directory);
  });
  return directory;
}

test("完整结果持久化为可读取 JSON 和带 BOM 的 UTF-8 CSV", async (t) => {
  const directory = await temporaryDirectory(t);
  const data = fixture();
  const paths = await persistPriceExport(data, directory);
  assert.deepEqual(JSON.parse(await readFile(paths.main, "utf8")), data);
  assert.deepEqual(JSON.parse(await readFile(paths.byDate, "utf8")), data.prices);
  assert.deepEqual(JSON.parse(await readFile(paths.byMonth, "utf8")), data.dayNumbers);
  const csv = await readFile(paths.csv);
  assert.deepEqual([...csv.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.ok(csv.toString("utf8").includes('"1日成人票,""测试"""'));
  assert.ok(csv.toString("utf8").includes('"北京环球度假区"'));
  assert.ok(csv.toString("utf8").includes('"1日成人"'));
  assert.ok(csv.toString("utf8").includes('"spot:1040"'));
  assert.ok(csv.toString("utf8").includes('"游玩天数"'));
  assert.equal(csv.toString("utf8").split("\r\n").length, 3);
});

test("partial 采集拒绝写入并原样保留旧主 JSON", async (t) => {
  const directory = await temporaryDirectory(t);
  const paths = await persistPriceExport(fixture(), directory);
  const before = await readFile(paths.main, "utf8");
  const partial = fixture(400);
  partial.collectionStatus = "partial";
  await assert.rejects(persistPriceExport(partial, directory), /不完整/);
  assert.equal(await readFile(paths.main, "utf8"), before);
  assert.deepEqual((await readdir(directory)).sort(), ["prices-by-date.json", "prices-by-month.json", "ticket-prices.csv", "ticket-prices.json"]);
});

test("保存开始后取消不会发布新价格，并清理临时文件", async (t) => {
  const directory = await temporaryDirectory(t);
  const paths = await persistPriceExport(fixture(), directory);
  const original = await readFile(paths.main, "utf8");
  const controller = new AbortController();
  const saving = persistPriceExport(fixture(400), directory, { signal: controller.signal });
  controller.abort();
  await assert.rejects(saving, { name: "AbortError" });
  assert.equal(await readFile(paths.main, "utf8"), original);
  assert.deepEqual((await readdir(directory)).sort(), ["prices-by-date.json", "prices-by-month.json", "ticket-prices.csv", "ticket-prices.json"]);
});

test("已完成数不匹配或包含失败项目时禁止覆盖", async (t) => {
  const directory = await temporaryDirectory(t);
  const paths = await persistPriceExport(fixture(), directory);
  const before = await readFile(paths.main, "utf8");
  const incomplete = fixture(400);
  incomplete.collection.completedProducts = 0;
  await assert.rejects(persistPriceExport(incomplete, directory), /完成票种数/);
  const failed = { ...fixture(400), collection: { requestedProducts: 1, completedProducts: 1, failures: [{ goodsId: 1023 }] } };
  await assert.rejects(persistPriceExport(failed, directory), /失败项目/);
  assert.equal(await readFile(paths.main, "utf8"), before);
});

test("再次保存后 previous 保留上一次完整快照且无临时文件", async (t) => {
  const directory = await temporaryDirectory(t);
  const first = fixture();
  const second = fixture(320.5);
  await persistPriceExport(first, directory);
  const paths = await persistPriceExport(second, directory);
  assert.deepEqual(JSON.parse(await readFile(paths.previous, "utf8")), first);
  assert.deepEqual(JSON.parse(await readFile(paths.main, "utf8")), second);
  const files = await readdir(directory);
  assert.equal(files.length, 5);
  assert.equal(files.some((name) => name.endsWith(".tmp")), false);
});

test("结构或金额无效时拒绝保存，防止 NaN 被 JSON 静默转成 null", async (t) => {
  const directory = await temporaryDirectory(t);
  const invalid = fixture();
  invalid.rows[0].mallPrice = NaN;
  await assert.rejects(persistPriceExport(invalid, directory), /金额无效/);
  const mismatched = fixture();
  mismatched.summary.dailyRecordCount = 2;
  await assert.rejects(persistPriceExport(mismatched, directory), /统计不一致/);
  assert.deepEqual(await readdir(directory), []);
});
