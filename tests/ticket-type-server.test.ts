import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDashboardServer } from "../server.ts";
import { buildPriceExport, normalizeProduct } from "../lib/ticket-prices.ts";
import { persistPriceExport } from "../lib/price-store.ts";

const oldTime = "2026-11-11T01:00:00.000Z";
const newTime = "2026-11-11T02:00:00.000Z";
const date = "2026-11-26";
const fixture = (fetchedAt = oldTime, price = 350) => {
  const products = [
    { goods_id: 1023, goods_name: "标准成人票", ticket_type: "ADULT" },
    { goods_id: 1024, goods_name: "标准儿童票", ticket_type: "CHILDREN" },
    { goods_id: 1036, goods_name: "暑期特惠：标准成人票", ticket_type: "CHILDREN" },
  ].map((raw) => normalizeProduct(raw, { spot_id: 1, spot_name: "北京环球度假区" }));
  const record = (mallPrice: number, valid = 1, visitDate = date) => ({
    date: visitDate, b2b_price: mallPrice, mall_price: mallPrice,
    market_price: mallPrice + 10, valid, stock: -1,
  });
  return {
    ...buildPriceExport(products, {
      "1023": [record(331.85)], "1024": [record(251.46)],
      "1036": [record(price), record(price + 1, 0, "2026-11-27")],
    }, { fetchedAt }),
    collectionStatus: "complete",
    collection: { requestedProducts: 3, completedProducts: 3, failures: [] },
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
function assertAdultOverride(snapshot: any, price = 350) {
  assert.equal(snapshot.products["1036"].group, "adult");
  assert.equal(snapshot.products["1036"].ticketType, "ADULT");
  assert.equal(snapshot.products["1036"].sourceTicketType, "CHILDREN");
  assert.equal(snapshot.products["1036"].sourceGroup, "children");
  assert.equal(snapshot.prices.adult["1036"][date], price);
  assert.equal("1036" in snapshot.prices.children, false);
  assert.equal(snapshot.dayNumbers.adult["1036"]["2026-11"]["26"], price);
  assert.equal("1036" in snapshot.dayNumbers.children, false);
  assert.equal("27" in snapshot.dayNumbers.adult["1036"]["2026-11"], false);
  for (const row of snapshot.rows.filter((item: any) => item.goodsId === 1036)) {
    assert.equal(row.group, "adult");
    assert.equal(row.ticketType, "ADULT");
    assert.equal(row.sourceTicketType, "CHILDREN");
  }
  assert.equal(snapshot.summary.productCount, 3);
  assert.equal(snapshot.summary.dailyRecordCount, 4);
  assert.equal(snapshot.summary.priceCount, 3);
  assert.equal(snapshot.summary.excludedInvalidCount, 1);
}

test("本地票种保存后立即重分组页面、下载和持久化文件，保留接口来源与价格", async (t) => {
  const env = await setup(t);
  const original = await env.get("/api/ticket-types");
  assert.deepEqual(original.overrides, {});
  const product = original.products.find((item: any) => item.goodsId === 1036);
  assert.equal(product.name, "暑期特惠：标准成人票");
  assert.equal(product.sourceTicketType, "CHILDREN");
  assert.equal(product.sourceGroup, "children");
  assert.equal(product.group, "children");
  assert.equal(product.override, null);

  assert.equal((await env.post("/api/ticket-types", { overrides: { "1036": "adult" } })).status, 200);
  const latest = await env.get("/api/prices");
  assertAdultOverride(latest);
  assert.equal(latest.fetchedAt, oldTime);
  assert.deepEqual(latest.summary.productCounts, { adult: 2, children: 1, other: 0 });
  const download = await fetch(env.base + "/api/download");
  assert.match(download.headers.get("Content-Disposition") ?? "", /ticket-prices\.json/);
  assert.deepEqual(await download.json(), latest);
  assertAdultOverride(await env.disk());
  assert.deepEqual(JSON.parse(await readFile(path.join(env.outputDir, "prices-by-date.json"), "utf8")), latest.prices);
  assert.deepEqual(JSON.parse(await readFile(path.join(env.outputDir, "prices-by-month.json"), "utf8")), latest.dayNumbers);
  assert.match(await readFile(path.join(env.outputDir, "ticket-prices.csv"), "utf8"), /"1036","ADULT"/);
  const saved = await env.get("/api/ticket-types");
  assert.deepEqual(saved.overrides, { "1036": "adult" });
  assert.equal(saved.products.find((item: any) => item.goodsId === 1036).override, "adult");
});

test("部分保存保留其他渠道设置，重启继续优先本地，null 可恢复原接口票种", async (t) => {
  const env = await setup(t);
  assert.equal((await env.post("/api/ticket-types", { overrides: { "1036": "adult", "1023": "children" } })).status, 200);
  await env.restart();
  const saved = await env.get("/api/ticket-types");
  assert.deepEqual(saved.overrides, { "1023": "children", "1036": "adult" });
  assertAdultOverride(await env.get("/api/prices"));
  assert.equal((await env.get("/api/prices")).products["1023"].group, "children");

  assert.equal((await env.post("/api/ticket-types", { overrides: { "1036": null } })).status, 200);
  assert.deepEqual((await env.get("/api/ticket-types")).overrides, { "1023": "children" });
  const restored = await env.get("/api/prices");
  assert.equal(restored.products["1036"].group, "children");
  assert.equal(restored.products["1036"].ticketType, "CHILDREN");
  assert.equal(restored.products["1036"].sourceTicketType, "CHILDREN");
  assert.equal(restored.prices.children["1036"][date], 350);
  assert.equal("1036" in restored.prices.adult, false);
  assert.equal(restored.products["1023"].group, "children");
  assert.deepEqual(restored.summary.productCounts, { adult: 0, children: 3, other: 0 });
  await env.restart();
  assert.deepEqual((await env.get("/api/ticket-types")).overrides, { "1023": "children" });
  assert.equal((await env.get("/api/prices")).products["1036"].group, "children");
});

test("刷新写入接口快照期间仍可调整票种，最新配置与新价格均不会被旧快照覆盖", async (t) => {
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
    assert.equal((await env.post("/api/ticket-types", { overrides: { "1036": "adult" } })).status, 200);
    assertAdultOverride(await env.get("/api/prices"));
    assert.equal((await env.disk()).products["1036"].group, "children", "刷新期间不重写采集器的主快照");
    allowWrite.resolve();
    await written.promise;
    assert.equal((await env.post("/api/ticket-types", { overrides: { "1023": "children" } })).status, 200);
    const current = await env.get("/api/prices");
    assertAdultOverride(current, 419.99);
    assert.equal(current.fetchedAt, newTime);
    assert.equal(current.products["1023"].group, "children");
    assert.equal((await env.disk()).products["1036"].group, "children");
    allowFinish.resolve();
    assert.equal((await finished(env)).status, "success");
    const final = await env.disk();
    assertAdultOverride(final, 419.99);
    assert.equal(final.fetchedAt, newTime);
    assert.deepEqual(final.summary.productCounts, { adult: 1, children: 2, other: 0 });
    assert.equal(final.products["1023"].group, "children");
    assert.deepEqual((await env.get("/api/ticket-types")).overrides, { "1023": "children", "1036": "adult" });
  } finally {
    allowWrite.resolve();
    allowFinish.resolve();
    await finished(env);
  }
});

test("同时保存设置并启动刷新时最终快照包含新价格和本地票种", async (t) => {
  const env = await setup(t, async () => { await persistPriceExport(fixture(newTime, 399.45), env.outputDir); });
  const responses = await Promise.all([
    env.post("/api/ticket-types", { overrides: { "1036": "adult" } }),
    env.post("/api/refresh", {}),
  ]);
  assert.deepEqual(responses.map((response) => response.status), [200, 202]);
  assert.equal((await finished(env)).status, "success");
  const result = await env.disk();
  assertAdultOverride(result, 399.45);
  assert.equal(result.fetchedAt, newTime);
});

test("拒绝非法票种、跨站和非JSON保存，配置文件不作为静态资源暴露", async (t) => {
  const env = await setup(t);
  assert.equal((await env.post("/api/ticket-types", { overrides: { "1036": "adult" } })).status, 200);
  const configPath = path.join(env.dir, "config", "ticket-types.json");
  const previous = await readFile(configPath, "utf8");
  for (const payload of [null, [], {}, { overrides: [] }, { overrides: { "1036": "other" } }, { overrides: { "1036": true } }, { overrides: { "0": "adult" } }, { overrides: { "not-an-id": "children" } }]) {
    assert.equal((await env.post("/api/ticket-types", payload)).status, 400);
    assert.equal(await readFile(configPath, "utf8"), previous);
  }
  assert.equal((await env.post("/api/ticket-types", { overrides: { "1036": null } }, { Origin: "https://example.com" })).status, 403);
  assert.equal((await env.post("/api/ticket-types", { overrides: { "1036": null } }, { "Sec-Fetch-Site": "cross-site" })).status, 403);
  assert.equal((await fetch(env.base + "/api/ticket-types", { method: "POST", body: "{}" })).status, 415);
  assert.equal((await fetch(env.base + "/api/ticket-types", { method: "POST", headers: { "Content-Type": "application/json", Origin: env.base }, body: "{bad json" })).status, 400);
  assert.equal((await fetch(env.base + "/config/ticket-types.json")).status, 404);
  assert.equal(await readFile(configPath, "utf8"), previous);
  assertAdultOverride(await env.get("/api/prices"));
});

test("首次没有价格时可以读取和保存票种设置，后续接口采集仍应用本地设置", async (t) => {
  const env = await setup(t, async () => { await persistPriceExport(fixture(newTime), env.outputDir); }, false);
  assert.deepEqual(await env.get("/api/ticket-types"), { overrides: {}, products: [] });
  assert.equal((await env.post("/api/ticket-types", { overrides: { "1036": "adult" } })).status, 200);
  assert.equal((await fetch(env.base + "/api/prices")).status, 404);
  assert.equal((await env.post("/api/refresh", {})).status, 202);
  assert.equal((await finished(env)).status, "success");
  assertAdultOverride(await env.get("/api/prices"));
  assertAdultOverride(await env.disk());
});
