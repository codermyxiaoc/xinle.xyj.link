import { readFileSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { resolveRuntimePaths } from "./runtime-paths.ts";
import type { buildPriceExport, TicketGroup } from "./ticket-prices.ts";

export type TicketTypeOverride = "adult" | "children";
export type TicketTypeOverrides = Record<string, TicketTypeOverride>;
type OverridePatch = Record<string, TicketTypeOverride | null>;
type PriceSnapshot = ReturnType<typeof buildPriceExport>;
type SourceMetadata = {
  sourceTicketType: string;
  sourceGroup: TicketGroup;
  ticketTypeSource: "local" | "remote";
};
type AppliedSnapshot<T extends PriceSnapshot> = Omit<T, "products" | "rows"> & {
  products: Record<string, PriceSnapshot["products"][string] & SourceMetadata>;
  rows: (PriceSnapshot["rows"][number] & SourceMetadata)[];
  sourceWarnings: string[];
};
const saveQueues = new Map<string, Promise<void>>();
const ticketTypes = { adult: "ADULT", children: "CHILDREN" } as const;

function isObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateMapping(value: unknown, allowReset: boolean): OverridePatch {
  if (!isObject(value)) throw new Error("票种设置 overrides 必须是对象。");
  const result: OverridePatch = {};
  for (const [id, ticketType] of Object.entries(value)) {
    if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id))) {
      throw new Error("票种设置中的渠道 ID 必须是正整数。");
    }
    if (ticketType !== "adult" && ticketType !== "children" && !(allowReset && ticketType === null)) {
      throw new Error(`渠道 ${id} 的票种必须是 adult、children${allowReset ? " 或 null（恢复接口）" : ""}。`);
    }
    result[id] = ticketType as TicketTypeOverride | null;
  }
  return result;
}

/** 读取完整本地映射；不按当前渠道列表裁剪，避免暂时下架后丢失设置。 */
export function readTicketTypeOverrides(configRoot = resolveRuntimePaths().dataRoot): TicketTypeOverrides {
  let raw: string;
  try { raw = readFileSync(path.join(configRoot, "config", "ticket-types.json"), "utf8"); }
  catch (error: any) {
    if (error.code === "ENOENT") return {};
    throw new Error("无法读取本地票种配置。", { cause: error });
  }
  try {
    const config: unknown = JSON.parse(raw);
    if (!isObject(config)) throw new Error("配置必须是对象。");
    return validateMapping(config.overrides, false) as TicketTypeOverrides;
  } catch (error) {
    throw new Error("本地票种配置无效，请检查 config/ticket-types.json。", { cause: error });
  }
}

/** 部分更新，null 恢复接口分类；同一目录排队读改写并以 rename 原子发布。 */
export async function saveTicketTypeOverrides(
  input: unknown,
  configRoot = resolveRuntimePaths().dataRoot,
): Promise<TicketTypeOverrides> {
  if (!isObject(input) || !Object.hasOwn(input, "overrides")) throw new Error("票种设置必须包含 overrides 对象。");
  const patch = validateMapping(input.overrides, true);
  const root = path.resolve(configRoot);
  const queueKey = process.platform === "win32" ? root.toLowerCase() : root;
  const operation = (saveQueues.get(queueKey) ?? Promise.resolve()).then(async () => {
    const overrides = readTicketTypeOverrides(root);
    for (const [id, ticketType] of Object.entries(patch)) {
      if (ticketType === null) delete overrides[id];
      else overrides[id] = ticketType;
    }
    const directory = path.join(root, "config");
    await mkdir(directory, { recursive: true });
    const temporary = path.join(directory, `ticket-types.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify({ overrides, updatedAt: new Date().toISOString() }, null, 2) + "\n", {
        encoding: "utf8", flag: "wx", mode: 0o600,
      });
      await rename(temporary, path.join(directory, "ticket-types.json"));
    } finally {
      await rm(temporary, { force: true });
    }
    return overrides;
  });
  // 将失败转为已完成的队尾，不让一次写入失败阻塞后续保存。
  const tail = operation.then(() => {}, () => {});
  saveQueues.set(queueKey, tail);
  void tail.then(() => { if (saveQueues.get(queueKey) === tail) saveQueues.delete(queueKey); });
  return operation;
}

function typeWarningGoodsId(warning: string): string | undefined {
  return warning.match(/^商品 ([1-9]\d*) 名称“[\s\S]*”与 ticket_type=\S+ 冲突；按接口显式票种分组，未根据名称更改。$/)?.[1]
    ?? warning.match(/^商品 ([1-9]\d*) 票种 [\s\S]+ 未归入成人\/儿童，保留在 other。$/)?.[1];
}

/** 只调整分类及其索引；来源字段使已覆盖快照仍可恢复接口分类。 */
export function applyTicketTypeOverrides<T extends PriceSnapshot>(
  snapshot: T,
  overrides: TicketTypeOverrides,
): AppliedSnapshot<T> {
  const mapping = validateMapping(overrides, false) as TicketTypeOverrides;
  const output = structuredClone(snapshot) as AppliedSnapshot<T>;
  const oldPrices = output.prices;
  const oldDayNumbers = output.dayNumbers;
  output.prices = { adult: {}, children: {}, other: {} };
  output.dayNumbers = { adult: {}, children: {}, other: {} };
  output.sourceWarnings = [...(output.sourceWarnings ?? output.warnings ?? [])];
  const counts = { adult: 0, children: 0, other: 0 };

  for (const [id, product] of Object.entries(output.products)) {
    const currentGroup = product.group;
    product.sourceTicketType ??= product.ticketType;
    product.sourceGroup ??= currentGroup;
    const override = mapping[id];
    product.ticketType = override ? ticketTypes[override] : product.sourceTicketType;
    product.group = override ?? product.sourceGroup;
    product.ticketTypeSource = override ? "local" : "remote";
    counts[product.group]++;
    // 移动已有的日期索引，金额、日期键和无有效价格的空对象均原样保留。
    output.prices[product.group][id] = oldPrices?.[currentGroup]?.[id] ?? {};
    output.dayNumbers[product.group][id] = oldDayNumbers?.[currentGroup]?.[id] ?? {};
  }
  for (const row of output.rows) {
    const product = output.products[String(row.goodsId)];
    row.sourceTicketType ??= row.ticketType;
    row.sourceGroup ??= row.group;
    row.ticketType = product.ticketType;
    row.group = product.group;
    row.ticketTypeSource = product.ticketTypeSource;
  }
  output.summary.productCounts = counts;
  output.summary.productCount = Object.keys(output.products).length;
  output.warnings = output.sourceWarnings.filter((warning) => {
    const id = typeWarningGoodsId(warning);
    return !id || !Object.hasOwn(mapping, id);
  });
  return output;
}
