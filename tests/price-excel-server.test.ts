import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { inflateRawSync } from "node:zlib";
import os from "node:os";
import path from "node:path";
import { createDashboardServer } from "../server.ts";
import { buildPriceExport, normalizeProduct } from "../lib/ticket-prices.ts";
import { persistPriceExport } from "../lib/price-store.ts";

const date = "2026-11-26";
const fixture = (price = 350, fetchedAt = "2026-11-11T01:00:00.000Z") => ({
  ...buildPriceExport([normalizeProduct({ goods_id: 1036, goods_name: "暑期特惠：北京环球影城指定日标准成人票【提前3天】", ticket_type: "CHILDREN" }, { spot_id: 1, spot_name: "北京环球度假区" })], {
    "1036": [{ date, b2b_price: price, mall_price: price, market_price: price + 10, valid: 1, stock: 50 }],
  }, { fetchedAt }),
  collectionStatus: "complete", collection: { requestedProducts: 1, completedProducts: 1, failures: [] },
});

function readZip(buffer: Buffer) {
  assert.equal(buffer.subarray(0, 4).toString("hex"), "504b0304", "响应必须是真实ZIP格式的xlsx");
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end >= 0);
  const count = buffer.readUInt16LE(end + 10);
  let cursor = buffer.readUInt32LE(end + 16);
  const files = new Map<string, string>();
  for (let i = 0; i < count; i++) {
    assert.equal(buffer.readUInt32LE(cursor), 0x02014b50);
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const local = buffer.readUInt32LE(cursor + 42);
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    assert.equal(buffer.readUInt32LE(local), 0x04034b50);
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const compressed = buffer.subarray(start, start + compressedSize);
    assert.ok([0, 8].includes(method), "仅允许标准ZIP stored/deflate压缩");
    files.set(name, (method === 8 ? inflateRawSync(compressed) : compressed).toString("utf8"));
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  assert.ok(files.has("[Content_Types].xml"));
  assert.ok(files.has("xl/workbook.xml"));
  assert.equal([...files.keys()].filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name)).length, 4);
  return files;
}

function sheetRows(xml: string) {
  const decode = (text: string) => text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
  return [...xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)].map((row) =>
    [...row[1].matchAll(/<c\b[^>]*>([\s\S]*?)<\/c>/g)].map((cell) => {
      const text = [...cell[1].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((part) => decode(part[1])).join("");
      return text || cell[1].match(/<v>([\s\S]*?)<\/v>/)?.[1] || "";
    }));
}

async function setup(t: any, runner: () => Promise<void> = async () => {}, initial = true) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "xinle-excel-server-"));
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
    get: (endpoint: string) => fetch(base + endpoint, { signal: AbortSignal.timeout(5_000) }),
    post: (endpoint: string, body: unknown) => fetch(base + endpoint, {
      method: "POST", headers: { "Content-Type": "application/json", Origin: base },
      body: JSON.stringify(body), signal: AbortSignal.timeout(5_000),
    }),
    restart: async () => { await close(); await start(); },
  };
}

async function readExport(env: Awaited<ReturnType<typeof setup>>) {
  const response = await env.get("/api/export.xlsx");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  const disposition = response.headers.get("Content-Disposition") || "";
  assert.match(disposition, /^attachment;/);
  assert.match(disposition, /filename\*=UTF-8''/i);
  const filename = decodeURIComponent(disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1] || "");
  assert.match(filename, /[\u4e00-\u9fff]/);
  assert.match(filename, /\.xlsx$/);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  return readZip(Buffer.from(await response.arrayBuffer()));
}

function assertLocalWorkbook(files: Map<string, string>, price: number) {
  const channel = sheetRows(files.get("xl/worksheets/sheet1.xml")!).find((row) => row[2] === "1036");
  assert.ok(channel);
  assert.equal(channel[0], "北京环球度假区");
  assert.equal(channel[1], "1.5日成人");
  assert.equal(channel[4], "本地设置");
  assert.equal(Number(channel[5]), price);
  const minimum = sheetRows(files.get("xl/worksheets/sheet2.xml")!).find((row) => row[4] === "1036");
  assert.ok(minimum);
  assert.equal(minimum[1], "1.5日成人");
  assert.equal(Number(minimum[3]), price);
  const detail = sheetRows(files.get("xl/worksheets/sheet3.xml")!).find((row) => row[2] === "1036");
  assert.ok(detail);
  assert.equal(detail[1], "1.5日成人");
  assert.equal(Number(detail[5]), price);
}

test("Excel按同渠道本地票种导出，接口刷新期间、完成后和重启后均保持本地优先", async (t) => {
  let release!: () => void;
  const finishGate = new Promise<void>((resolve) => { release = resolve; });
  let written!: () => void;
  const sourceWritten = new Promise<void>((resolve) => { written = resolve; });
  const env = await setup(t, async () => {
    await persistPriceExport(fixture(419.99, "2026-11-11T02:00:00.000Z"), env.outputDir);
    written();
    await finishGate;
  });
  const configPath = path.join(env.dir, "config", "ticket-types.json");
  try {
    assert.equal((await env.post("/api/ticket-types", { overrides: { "1036": "adult_1_5d" } })).status, 200);
    const configBefore = await readFile(configPath, "utf8");
    assertLocalWorkbook(await readExport(env), 350);
    assert.equal((await env.post("/api/refresh", {})).status, 202);
    await sourceWritten;
    const source = JSON.parse(await readFile(path.join(env.outputDir, "ticket-prices.json"), "utf8"));
    assert.equal(source.products["1036"].group, "other");
    assert.equal(source.products["1036"].ticketType, "CHILDREN");
    assertLocalWorkbook(await readExport(env), 419.99);
    assert.equal(await readFile(configPath, "utf8"), configBefore, "刷新不能重写同渠道本地票种配置");
    release();
    let state;
    for (let i = 0; i < 100; i++) {
      state = await (await env.get("/api/refresh")).json();
      if (state.status !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(state.status, "success");
    assertLocalWorkbook(await readExport(env), 419.99);
    await env.restart();
    assertLocalWorkbook(await readExport(env), 419.99);
    const prices = await (await env.get("/api/prices")).json();
    assert.equal(prices.products["1036"].group, "adult_1_5d");
    assert.equal(prices.products["1036"].sourceTicketType, "CHILDREN");
    assert.equal(prices.products["1036"].ticketTypeSource, "local");
    assert.equal(await readFile(configPath, "utf8"), configBefore);
  } finally { release(); }
});

test("没有完整价格数据时返回JSON错误而不是下载Excel", async (t) => {
  const env = await setup(t, async () => {}, false);
  const missing = await env.get("/api/export.xlsx");
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get("Content-Disposition"), null);
  assert.match(missing.headers.get("Content-Type") || "", /application\/json/);
  assert.equal(typeof (await missing.json()).error, "string");
  for (const invalid of ["{broken json", JSON.stringify({ ...fixture(), collectionStatus: "partial" }), JSON.stringify({ collectionStatus: "complete", products: {}, prices: {} })]) {
    await writeFile(path.join(env.outputDir, "ticket-prices.json"), invalid);
    const response = await env.get("/api/export.xlsx");
    assert.equal(response.status, 500);
    assert.equal(response.headers.get("Content-Disposition"), null);
    assert.match(response.headers.get("Content-Type") || "", /application\/json/);
    assert.equal(typeof (await response.json()).error, "string");
  }
});

test("Excel和价格API均不包含本地登录配置", async (t) => {
  const env = await setup(t);
  const credentials = { username: "excel-fixture-user-never-export", password: "excel-fixture-password-never-export" };
  await mkdir(path.join(env.dir, "config"));
  await writeFile(path.join(env.dir, "config", "login.json"), JSON.stringify(credentials));
  const files = await readExport(env);
  const exportedXml = [...files.values()].join("\n");
  const prices = await (await env.get("/api/prices")).text();
  for (const marker of Object.values(credentials)) {
    assert.equal(exportedXml.includes(marker), false);
    assert.equal(prices.includes(marker), false);
  }
  assert.equal((await env.get("/config/login.json")).status, 404);
});
