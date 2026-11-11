import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { buildPriceExport } from "./ticket-prices.ts";

type PriceExport = ReturnType<typeof buildPriceExport>;
export type PersistablePriceExport = PriceExport & {
  collectionStatus: string;
  collection: {
    requestedProducts: number;
    completedProducts: number;
    failures: unknown[];
    [key: string]: unknown;
  };
};

const groups = ["adult", "children", "other"] as const;
const filenames = {
  main: "ticket-prices.json",
  byDate: "prices-by-date.json",
  byMonth: "prices-by-month.json",
  csv: "ticket-prices.csv",
  previous: "ticket-prices.previous.json",
};

function isObject(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPrice(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function validate(result: PersistablePriceExport) {
  if (!isObject(result) || result.collectionStatus !== "complete") {
    throw new Error("采集结果不完整，保留上一次已保存的数据。");
  }
  const collection = result.collection;
  if (!isObject(collection) || !Array.isArray(collection.failures) || collection.failures.length) {
    throw new Error("采集包含失败项目，不能覆盖已保存数据。");
  }
  if (!isCount(collection.requestedProducts) || !isCount(collection.completedProducts) ||
      collection.requestedProducts !== collection.completedProducts) {
    throw new Error("已完成票种数与请求票种数不一致，不能覆盖已保存数据。");
  }
  if (!isObject(result.products) || !isObject(result.summary) || !Array.isArray(result.rows) ||
      !isObject(result.prices) || !isObject(result.dayNumbers) || !Array.isArray(result.warnings) ||
      typeof result.fetchedAt !== "string" || !Number.isFinite(Date.parse(result.fetchedAt)) ||
      result.priceSource !== "mall_price") {
    throw new Error("价格导出结构不完整，不能保存。");
  }
  if (Object.keys(result.products).length !== collection.requestedProducts ||
      result.summary.productCount !== collection.requestedProducts ||
      result.summary.dailyRecordCount !== result.rows.length) {
    throw new Error("价格导出的商品或日期记录统计不一致，不能保存。");
  }
  for (const [id, product] of Object.entries(result.products)) {
    if (!isObject(product) || String(product.goodsId) !== id || !isCount(product.goodsId) ||
        product.goodsId === 0 || typeof product.name !== "string" ||
        typeof product.spotName !== "string" || typeof product.ticketType !== "string" ||
        !groups.includes(product.group)) {
      throw new Error(`商品 ${id} 的元数据不完整，不能保存。`);
    }
  }
  for (const group of groups) {
    if (!isObject(result.prices[group]) || !isObject(result.dayNumbers[group])) {
      throw new Error(`价格导出缺少 ${group} 分组。`);
    }
    for (const [id, dates] of Object.entries(result.prices[group])) {
      if (result.products[id]?.group !== group || !isObject(dates) ||
          Object.entries(dates).some(([date, price]) => !/^\d{4}-\d{2}-\d{2}$/.test(date) || !isPrice(price))) {
        throw new Error(`商品 ${id} 的日期价格结构无效。`);
      }
    }
    for (const [id, months] of Object.entries(result.dayNumbers[group])) {
      if (result.products[id]?.group !== group || !isObject(months)) {
        throw new Error(`商品 ${id} 的月份价格结构无效。`);
      }
      for (const [month, days] of Object.entries(months)) {
        if (!/^\d{4}-\d{2}$/.test(month) || !isObject(days) ||
            Object.entries(days).some(([day, price]) => !/^(?:[1-9]|[12]\d|3[01])$/.test(day) || !isPrice(price))) {
          throw new Error(`商品 ${id} 的月份价格结构无效。`);
        }
      }
    }
  }
  for (const row of result.rows) {
    if (!isObject(row) || !result.products[row.goodsId] ||
        result.products[row.goodsId].group !== row.group ||
        typeof row.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(row.date) ||
        !isPrice(row.mallPrice) || !isPrice(row.b2bPrice) ||
        (row.marketPrice !== null && !isPrice(row.marketPrice)) ||
        typeof row.includedInPrices !== "boolean") {
      throw new Error("每日价格明细不完整或金额无效，不能保存。");
    }
  }
}

function csvCell(value: unknown) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

function toCsv(result: PersistablePriceExport) {
  const rows = [
    ["商品ID", "票种", "商品名称", "景区", "日期", "日历价_元", "平台价_元", "门市价_元", "valid", "stock", "纳入价格表"],
    ...result.rows.map((row) => [
      row.goodsId, row.ticketType, result.products[row.goodsId].name,
      result.products[row.goodsId].spotName, row.date, row.mallPrice,
      row.b2bPrice, row.marketPrice, row.valid, row.stock, row.includedInPrices,
    ]),
  ];
  return "\uFEFF" + rows.map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

/** 完整采集才保存；同目录临时文件原子替换，主 JSON 最后发布供看板读取。 */
export async function persistPriceExport(result: PersistablePriceExport, outputDir: string, options: { signal?: AbortSignal } = {}) {
  const signal = options.signal;
  signal?.throwIfAborted();
  validate(result);
  const directory = path.resolve(outputDir);
  const paths = Object.fromEntries(
    Object.entries(filenames).map(([key, filename]) => [key, path.join(directory, filename)]),
  ) as Record<keyof typeof filenames, string>;
  const json = (data: unknown) => JSON.stringify(data, null, 2) + "\n";
  const stages: { target: string; temp: string; content: string | Buffer }[] = [];
  const stage = (target: string, content: string | Buffer) => {
    stages.push({ target, temp: `${target}.${randomUUID()}.tmp`, content });
  };

  await mkdir(directory, { recursive: true });
  try {
    stage(paths.previous, await readFile(paths.main));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  stage(paths.byDate, json(result.prices));
  stage(paths.byMonth, json(result.dayNumbers));
  stage(paths.csv, toCsv(result));
  stage(paths.main, json(result));

  try {
    // 等全部写入结束后再检查错误，防止失败清理时仍有后台写入。
    const writes = await Promise.allSettled(stages.map(({ temp, content }) =>
      writeFile(temp, content, { encoding: "utf8", flag: "wx", signal }),
    ));
    for (const outcome of writes) {
      if (outcome.status === "rejected") throw outcome.reason;
    }
    // 看板以 main 为唯一权威快照；其他文件先更新，main 最后替换。
    for (const { target, temp } of stages) {
      signal?.throwIfAborted();
      await rename(temp, target);
    }
  } finally {
    await Promise.all(stages.map(({ temp }) => rm(temp, { force: true })));
  }
  return paths;
}
