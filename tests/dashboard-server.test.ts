import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDashboardServer } from "../server.ts";

const data = (time: string) => ({
  fetchedAt: time, collectionStatus: "complete", prices: { adult: {}, children: {}, other: {} },
  products: {}, rows: [], summary: { productCount: 0 },
});

async function setup(t: any, runner: (report: any) => Promise<void>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "xinle-dashboard-"));
  await writeFile(path.join(dir, "ticket-prices.json"), JSON.stringify(data("2026-11-11T01:00:00Z")));
  const server = createDashboardServer({ outputDir: dir, runRefresh: runner });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });
  return { dir, base, post: () => fetch(base + "/api/refresh", {
    method: "POST", headers: { "Content-Type": "application/json", Origin: base }, body: "{}",
  }) };
}

async function finished(base: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const status = await (await fetch(base + "/api/refresh")).json();
    if (status.status !== "running") return status;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("刷新没有完成");
}

test("重复刷新只启动一次，刷新期间仍可读旧数据，成功后读取新JSON", async (t) => {
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const env = await setup(t, async (report) => {
    calls++;
    report("正在读取价格", { current: 1, total: 2 });
    await gate;
    await writeFile(path.join(env.dir, "ticket-prices.json"), JSON.stringify(data("2026-11-11T02:00:00Z")));
  });
  assert.equal((await env.post()).status, 202);
  assert.equal((await env.post()).status, 202);
  assert.equal((await (await fetch(env.base + "/api/prices")).json()).fetchedAt, "2026-11-11T01:00:00Z");
  release();
  assert.equal((await finished(env.base)).status, "success");
  assert.equal(calls, 1);
  assert.equal((await (await fetch(env.base + "/api/prices")).json()).fetchedAt, "2026-11-11T02:00:00Z");
});

test("刷新失败保留可用旧数据并返回失败状态", async (t) => {
  const env = await setup(t, async () => { throw new Error("来源暂时不可用"); });
  const original = await readFile(path.join(env.dir, "ticket-prices.json"), "utf8");
  await env.post();
  const state = await finished(env.base);
  assert.equal(state.status, "error");
  assert.match(state.error, /来源暂时不可用/);
  assert.equal(await readFile(path.join(env.dir, "ticket-prices.json"), "utf8"), original);
});

test("未生成新JSON不会误报刷新成功", async (t) => {
  const env = await setup(t, async () => {});
  await env.post();
  assert.equal((await finished(env.base)).status, "error");
});

test("只提供指定页面和数据，拒绝跨站刷新及非JSON请求", async (t) => {
  let calls = 0;
  const env = await setup(t, async () => { calls++; });
  assert.equal((await fetch(env.base + "/.env.local")).status, 404);
  assert.equal((await fetch(env.base + "/api/refresh", {
    method: "POST", headers: { "Content-Type": "application/json", Origin: "https://example.com" }, body: "{}",
  })).status, 403);
  assert.equal((await fetch(env.base + "/api/refresh", { method: "POST", body: "{}" })).status, 415);
  assert.equal(calls, 0);
});
