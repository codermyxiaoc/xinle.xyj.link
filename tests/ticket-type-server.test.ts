import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDashboardServer } from "../server.ts";
import { buildPriceExport, normalizeProduct } from "../lib/ticket-prices.ts";
import { persistPriceExport } from "../lib/price-store.ts";

const oldTime = "2026-11-11T01:00:00.000Z";
const newTime = "2026-11-11T02:00:00.000Z";
const date = "2026-11-26";
const groups = ["adult_1d", "children_1d", "adult_1_5d", "children_1_5d", "other"] as const;
const fixture = (fetchedAt = oldTime, price = 350) => {
  const beijing = { spot_id: 1, spot_name: "北京环球度假区" };
  const shanghai = { spot_id: 2, spot_name: "上海迪士尼度假区" };
  const otherBeijing = { spot_id: 3, spot_name: "北京环球影城度假区" };
  const products = [
    normalizeProduct({ goods_id: 1023, goods_name: "北京环球影城-1日标准成人票-提前15天预定", ticket_type: "ADULT" }, beijing),
    normalizeProduct({ goods_id: 1024, goods_name: "北京环球影城-1日儿童票", ticket_type: "CHILDREN" }, beijing),
    normalizeProduct({ goods_id: 1036, goods_name: "暑期特惠：北京环球影城指定日标准成人票【提前3天】", ticket_type: "CHILDREN" }, beijing),
    normalizeProduct({ goods_id: 1027, goods_name: "直连（当天票）北京环球度假区指定1.5日票成人票", ticket_type: "ADULT" }, beijing),
    normalizeProduct({ goods_id: 1028, goods_name: "北京环球度假区指定1.5日票儿童票", ticket_type: "CHILDREN" }, beijing),
    normalizeProduct({ goods_id: 1504, goods_name: "【分销-集合特价票】上海迪士尼乐园1日门票-成人票", ticket_type: "ADULT" }, shanghai),
    normalizeProduct({ goods_id: 1552, goods_name: "【集合-分销当天】上海迪士尼乐园1日儿童票", ticket_type: "ALL" }, shanghai),
    normalizeProduct({ goods_id: 1491, goods_name: "【三人票】北京环球单日门票（优惠）-当日可订", ticket_type: "ALL" }, otherBeijing),
  ];
  const record = (mallPrice: number, valid = 1, visitDate = date) => ({
    date: visitDate, b2b_price: mallPrice, mall_price: mallPrice,
    market_price: mallPrice + 10, valid, stock: -1,
  });
  return {
    ...buildPriceExport(products, {
      "1023": [record(331.85)], "1024": [record(251.46)],
      "1036": [record(price), record(price + 1, 0, "2026-11-27")],
      "1027": [record(538.5)], "1028": [record(403)],
      "1504": [record(404)], "1552": [record(277)], "1491": [record(1094.16)],
    }, { fetchedAt }),
    collectionStatus: "complete",
    collection: { requestedProducts: 8, completedProducts: 8, failures: [] },
  };
};

type Runner = (report: (message: string, progress?: { current: number; total: number }) => void) => Promise<void>;
async function setup(t: any, runner: Runner = async () => {}, initial = true) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "xinle-ticket-types-"));
  const outputDir = path.join(dir, "output");
  await mkdir(outputDir);
  if (initial) await persistPriceExport(fixture(), outputDir);
  let server: ReturnType<typeof createDashboardServer> | undefined;
  let base = "";
  const close = async () => {
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  };
  const start = async () => {
    server = createDashboardServer({ outputDir, configRoot: dir, runRefresh: runner });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  };
  await start();
  t.after(async () => { await close(); await rm(dir, { recursive: true, force: true }); });
  return {
    dir, outputDir, get base() { return base; },
    get: async (endpoint: string) => {
      const response = await fetch(base + endpoint, { signal: AbortSignal.timeout(5_000) });
      assert.equal(response.status, 200, endpoint);
      return response.json();
    },
    post: (endpoint: string, body: unknown, headers: Record<string, string> = {}) => fetch(base + endpoint, {
      method: "POST", headers: { "Content-Type": "application/json", Origin: base, ...headers },
      body: JSON.stringify(body), signal: AbortSignal.timeout(5_000),
    }),
    disk: async () => JSON.parse(await readFile(path.join(outputDir, "ticket-prices.json"), "utf8")),
    restart: async () => { await close(); await start(); },
  };
}

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};
async function finished(env: Awaited<ReturnType<typeof setup>>) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const state = await env.get("/api/refresh");
    if (state.status !== "running") return state;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("价格刷新未完成。");
}
function assertOverride(snapshot: any, group = "adult_1d", price = 350) {
  const ticketType = group.startsWith("adult") ? "ADULT" : "CHILDREN";
  const visitDays = group.includes("1_5d") ? 1.5 : 1;
  const product = snapshot.products["1036"];
  assert.equal(product.group, group);
  assert.equal(product.ticketType, ticketType);
  assert.equal(product.sourceTicketType, "CHILDREN");
  assert.equal(product.sourceGroup, "other");
  assert.equal(product.ticketTypeSource, "local");
  assert.equal(product.visitDays, visitDays);
  assert.equal(snapshot.prices[group]["1036"][date], price);
  assert.equal(snapshot.dayNumbers[group]["1036"]["2026-11"]["26"], price);
  assert.equal("27" in snapshot.dayNumbers[group]["1036"]["2026-11"], false);
  for (const other of groups.filter((value) => value !== group)) {
    assert.equal("1036" in snapshot.prices[other], false);
    assert.equal("1036" in snapshot.dayNumbers[other], false);
  }
  for (const row of snapshot.rows.filter((item: any) => item.goodsId === 1036)) {
    assert.equal(row.group, group);
    assert.equal(row.ticketType, ticketType);
    assert.equal(row.sourceTicketType, "CHILDREN");
  }
  assert.equal(snapshot.summary.productCount, 8);
  assert.equal(snapshot.summary.dailyRecordCount, 9);
  assert.equal(snapshot.summary.priceCount, 8);
  assert.equal(snapshot.summary.excludedInvalidCount, 1);
}

test("三景区四票种及待设置渠道完整保留，设置API提供来源和地区信息", async (t) => {
  const env = await setup(t);
  const data = await env.get("/api/prices");
  assert.equal(data.products["1023"].group, "adult_1d");
  assert.equal(data.products["1024"].group, "children_1d");
  assert.equal(data.products["1027"].group, "adult_1_5d");
  assert.equal(data.products["1028"].group, "children_1_5d");
  assert.equal(data.products["1552"].group, "children_1d");
  assert.equal(data.products["1036"].group, "other");
  assert.equal(data.products["1491"].group, "other");
  assert.deepEqual(data.summary.productCounts, { adult_1d: 2, children_1d: 2, adult_1_5d: 1, children_1_5d: 1, other: 2 });
  const settings = await env.get("/api/ticket-types");
  assert.deepEqual(settings.overrides, {});
  assert.equal(settings.products.length, 8);
  const destinations = new Set(settings.products.map((product: any) => product.destinationKey));
  assert.equal(destinations.size, 3);
  for (const product of settings.products) {
    assert.equal(product.destinationName, product.spotName);
    assert.ok(product.destinationKey);
    assert.ok(product.spotId);
    assert.equal(product.override, null);
    for (const field of ["spotId", "spotName", "destinationKey", "destinationName", "visitDays"]) {
      assert.equal(product[field], data.products[String(product.goodsId)][field], `设置 API 与价格快照的 ${field} 应一致`);
    }
  }
  const conflict = settings.products.find((product: any) => product.goodsId === 1036);
  assert.equal(conflict.sourceTicketType, "CHILDREN");
  assert.equal(conflict.sourceGroup, "other");
  assert.equal(conflict.visitDays, null);
  assert.equal(settings.products.find((product: any) => product.goodsId === 1027).visitDays, 1.5);
  assert.equal(data.prices.adult_1d["1023"][date], 331.85);
  assert.equal(data.prices.adult_1d["1504"][date], 404);
  assert.notEqual(data.products["1023"].destinationKey, data.products["1504"].destinationKey);
});

test("四种本地票种都立即同步API、JSON下载和导出文件，保持原金额与有效日期", async (t) => {
  const env = await setup(t);
  for (const group of groups.filter((value) => value !== "other")) {
    assert.equal((await env.post("/api/ticket-types", { overrides: { "1036": group } })).status, 200);
    const latest = await env.get("/api/prices");
    assertOverride(latest, group);
    assert.equal(latest.fetchedAt, oldTime);
    const download = await fetch(env.base + "/api/download");
    assert.match(download.headers.get("Content-Disposition") ?? "", /ticket-prices\.json/);
    assert.deepEqual(await download.json(), latest);
    assertOverride(await env.disk(), group);
    assert.deepEqual(JSON.parse(await readFile(path.join(env.outputDir, "prices-by-date.json"), "utf8")), latest.prices);
    assert.deepEqual(JSON.parse(await readFile(path.join(env.outputDir, "prices-by-month.json"), "utf8")), latest.dayNumbers);
    const csvRow = (await readFile(path.join(env.outputDir, "ticket-prices.csv"), "utf8")).split(/\r?\n/).find((line) => line.startsWith('"1036",'));
    const labels = { adult_1d: "1日成人", children_1d: "1日儿童", adult_1_5d: "1.5日成人", children_1_5d: "1.5日儿童" };
    assert.ok(csvRow?.includes(labels[group]), "CSV 也应能区分四种票型");
    assert.ok(csvRow.includes("北京环球度假区"));
    assert.equal((await env.get("/api/ticket-types")).products.find((item: any) => item.goodsId === 1036).override, group);
  }
});

test("部分保存保留其他设置，重启继续优先本地，null 恢复自动分类并保留待设置价格", async (t) => {
  const env = await setup(t);
  assert.equal((await env.post("/api/ticket-types", { overrides: { "1036": "adult_1_5d", "1023": "children_1d" } })).status, 200);
  await env.restart();
  assert.deepEqual((await env.get("/api/ticket-types")).overrides, { "1023": "children_1d", "1036": "adult_1_5d" });
  assertOverride(await env.get("/api/prices"), "adult_1_5d");
  assert.equal((await env.get("/api/prices")).products["1023"].group, "children_1d");
  assert.equal((await env.post("/api/ticket-types", { overrides: { "1036": null } })).status, 200);
  const restored = await env.get("/api/prices");
  assert.equal(restored.products["1036"].group, "other");
  assert.equal(restored.products["1036"].ticketType, "CHILDREN");
  assert.equal(restored.products["1036"].ticketTypeSource, "remote");
  assert.equal(restored.products["1036"].visitDays, null);
  assert.equal(restored.prices.other["1036"][date], 350);
  assert.equal(restored.products["1023"].group, "children_1d");
  await env.restart();
  assert.deepEqual((await env.get("/api/ticket-types")).overrides, { "1023": "children_1d" });
  assert.equal((await env.get("/api/prices")).products["1036"].group, "other");
});

test("旧版成人儿童设置和已覆盖快照迁移为一日票，恢复自动后不丢旧价格", async (t) => {
  const env = await setup(t, async () => {}, false);
  const legacy = {
    fetchedAt: oldTime, priceSource: "mall_price", sourceUrl: null, collectionStatus: "complete",
    collection: { requestedProducts: 1, completedProducts: 1, failures: [] },
    products: { "1036": { goodsId: 1036, name: "暑期特惠：北京环球影城指定日标准成人票【提前3天】", ticketType: "ADULT", group: "adult", sourceTicketType: "CHILDREN", sourceGroup: "children", ticketTypeSource: "local", spotId: 1, spotName: "北京环球度假区", limitDays: 3, priceEndDate: null } },
    prices: { adult: { "1036": { [date]: 350 } }, children: {}, other: {} },
    dayNumbers: { adult: { "1036": { "2026-11": { "26": 350 } } }, children: {}, other: {} },
    rows: [{ goodsId: 1036, goodsPriceId: 1, ticketType: "ADULT", group: "adult", sourceTicketType: "CHILDREN", sourceGroup: "children", ticketTypeSource: "local", date, b2bPrice: 350, mallPrice: 350, marketPrice: 360, valid: 1, stock: -1, includedInPrices: true }],
    warnings: [], sourceWarnings: [],
    summary: { productCount: 1, productCounts: { adult: 1, children: 0, other: 0 }, sourceRecordCount: 1, dailyRecordCount: 1, priceCount: 1, excludedInvalidCount: 0, zeroStockRecordCount: 0, productsWithoutPrices: [], dateCount: 1, dateStart: date, dateEnd: date },
  };
  await writeFile(path.join(env.outputDir, "ticket-prices.json"), JSON.stringify(legacy));
  await mkdir(path.join(env.dir, "config"));
  await writeFile(path.join(env.dir, "config", "ticket-types.json"), JSON.stringify({ overrides: { "1036": "adult", "9999": "children" } }));
  await env.restart();
  assert.deepEqual((await env.get("/api/ticket-types")).overrides, { "1036": "adult_1d", "9999": "children_1d" });
  const migrated = await env.get("/api/prices");
  assert.equal(migrated.products["1036"].group, "adult_1d");
  assert.equal(migrated.products["1036"].sourceTicketType, "CHILDREN");
  assert.equal(migrated.products["1036"].sourceGroup, "other");
  assert.equal(migrated.prices.adult_1d["1036"][date], 350);
  assert.equal(migrated.dayNumbers.adult_1d["1036"]["2026-11"]["26"], 350);
  assert.equal((await env.post("/api/ticket-types", { overrides: { "1036": null } })).status, 200);
  const reset = await env.get("/api/prices");
  assert.equal(reset.products["1036"].group, "other");
  assert.equal(reset.prices.other["1036"][date], 350);
  assert.equal(reset.rows[0].mallPrice, 350);
  assert.equal((await env.disk()).prices.other["1036"][date], 350);
  assert.deepEqual((await env.get("/api/ticket-types")).overrides, { "9999": "children_1d" });
});

test("刷新写入三景区接口数据期间修改票种，最新设置和新价格均保留", async (t) => {
  const allowWrite = deferred();
  const written = deferred();
  const allowFinish = deferred();
  const env = await setup(t, async () => {
    await allowWrite.promise;
    await persistPriceExport(fixture(newTime, 419.99), env.outputDir);
    written.resolve();
    await allowFinish.promise;
  });
  try {
    assert.equal((await env.post("/api/refresh", {})).status, 202);
    assert.equal((await env.post("/api/ticket-types", { overrides: { "1036": "adult_1d" } })).status, 200);
    assertOverride(await env.get("/api/prices"));
    assert.equal((await env.disk()).products["1036"].group, "other", "刷新期间不重写采集器快照");
    allowWrite.resolve();
    await written.promise;
    assert.equal((await env.post("/api/ticket-types", { overrides: { "1023": "children_1_5d" } })).status, 200);
    const current = await env.get("/api/prices");
    assertOverride(current, "adult_1d", 419.99);
    assert.equal(current.fetchedAt, newTime);
    assert.equal(current.products["1023"].group, "children_1_5d");
    assert.equal((await env.disk()).products["1036"].group, "other");
    allowFinish.resolve();
    assert.equal((await finished(env)).status, "success");
    const final = await env.disk();
    assertOverride(final, "adult_1d", 419.99);
    assert.equal(final.fetchedAt, newTime);
    assert.equal(final.products["1023"].group, "children_1_5d");
    assert.equal(final.products["1552"].group, "children_1d");
    assert.equal(new Set(Object.values(final.products).map((product: any) => product.destinationKey)).size, 3);
    assert.deepEqual((await env.get("/api/ticket-types")).overrides, { "1023": "children_1_5d", "1036": "adult_1d" });
  } finally {
    allowWrite.resolve();
    allowFinish.resolve();
    await finished(env);
  }
});

test("同时保存设置并启动刷新时最终快照包含新价格和四票种设置", async (t) => {
  const env = await setup(t, async () => { await persistPriceExport(fixture(newTime, 399.45), env.outputDir); });
  const responses = await Promise.all([
    env.post("/api/ticket-types", { overrides: { "1036": "children_1_5d" } }),
    env.post("/api/refresh", {}),
  ]);
  assert.deepEqual(responses.map((response) => response.status), [200, 202]);
  assert.equal((await finished(env)).status, "success");
  assertOverride(await env.disk(), "children_1_5d", 399.45);
  assert.equal((await env.disk()).fetchedAt, newTime);
});

test("拒绝非法票种、跨站和非JSON保存，配置文件不暴露", async (t) => {
  const env = await setup(t);
  assert.equal((await env.post("/api/ticket-types", { overrides: { "1036": "adult_1d" } })).status, 200);
  const configPath = path.join(env.dir, "config", "ticket-types.json");
  const previous = await readFile(configPath, "utf8");
  for (const payload of [null, [], {}, { overrides: [] }, { overrides: { "1036": "other" } }, { overrides: { "1036": "adult_2d" } }, { overrides: { "1036": true } }, { overrides: { "0": "adult_1d" } }, { overrides: { "not-an-id": "children_1d" } }]) {
    assert.equal((await env.post("/api/ticket-types", payload)).status, 400);
    assert.equal(await readFile(configPath, "utf8"), previous);
  }
  assert.equal((await env.post("/api/ticket-types", { overrides: { "1036": null } }, { Origin: "https://example.com" })).status, 403);
  assert.equal((await env.post("/api/ticket-types", { overrides: { "1036": null } }, { "Sec-Fetch-Site": "cross-site" })).status, 403);
  assert.equal((await fetch(env.base + "/api/ticket-types", { method: "POST", body: "{}" })).status, 415);
  assert.equal((await fetch(env.base + "/api/ticket-types", { method: "POST", headers: { "Content-Type": "application/json", Origin: env.base }, body: "{bad json" })).status, 400);
  assert.equal((await fetch(env.base + "/config/ticket-types.json")).status, 404);
  assert.equal(await readFile(configPath, "utf8"), previous);
  assertOverride(await env.get("/api/prices"));
});

test("首次没有价格也可预存四票种设置，之后抓取与旧别名提交均能正确应用", async (t) => {
  const env = await setup(t, async () => { await persistPriceExport(fixture(newTime), env.outputDir); }, false);
  assert.deepEqual(await env.get("/api/ticket-types"), { overrides: {}, products: [] });
  assert.equal((await env.post("/api/ticket-types", { overrides: { "1036": "adult", "9999": "children" } })).status, 200);
  assert.deepEqual((await env.get("/api/ticket-types")).overrides, { "1036": "adult_1d", "9999": "children_1d" });
  assert.equal((await fetch(env.base + "/api/prices")).status, 404);
  assert.equal((await env.post("/api/refresh", {})).status, 202);
  assert.equal((await finished(env)).status, "success");
  assertOverride(await env.get("/api/prices"));
  assertOverride(await env.disk());
});
