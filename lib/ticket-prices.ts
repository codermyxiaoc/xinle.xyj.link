export type TicketGroup = "adult" | "children" | "other";

export interface NormalizedProduct {
  goodsId: number;
  name: string;
  ticketType: string;
  spotId: number | null;
  spotName: string;
  limitDays: number | null;
  priceEndDate: string | null;
}

export interface DailyPriceRow {
  goodsId: number;
  goodsPriceId: number | null;
  ticketType: string;
  group: TicketGroup;
  date: string;
  b2bPrice: number;
  marketPrice: number | null;
  mallPrice: number;
  valid: number | null;
  stock: number | null;
  includedInPrices: boolean;
}

type Prices = Record<TicketGroup, Record<string, Record<string, number>>>;
type DayNumbers = Record<
  TicketGroup,
  Record<string, Record<string, Record<string, number>>>
>;
type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown, label: string): UnknownRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} 必须是对象。`);
  }
  return value as UnknownRecord;
}

function integer(value: unknown, label: string, optional = false): number | null {
  if (optional && (value === undefined || value === null || value === "")) return null;
  if (
    (typeof value !== "number" && typeof value !== "string") ||
    (typeof value === "string" && !/^-?\d+$/.test(value.trim()))
  ) {
    throw new Error(`${label} 必须是整数。`);
  }
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new Error(`${label} 必须是安全整数。`);
  return result;
}

function positiveId(value: unknown, label: string): number {
  const result = integer(value, label);
  if (result === null || result <= 0) throw new Error(`${label} 必须是正整数。`);
  return result;
}

function optionalId(value: unknown, label: string): number | null {
  if (value === undefined || value === null || value === "") return null;
  return positiveId(value, label);
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** 只提取价格采集需要的元数据，不复制商品对象中的账号/接口配置。 */
export function normalizeProduct(raw: unknown, spot?: unknown): NormalizedProduct {
  const product = asRecord(raw, "商品");
  const parent = spot === undefined ? {} : asRecord(spot, "景区");
  const goodsId = positiveId(product.goods_id, "goods_id");
  return {
    goodsId,
    name: text(product.goods_name),
    ticketType: text(product.ticket_type).toUpperCase() || "UNKNOWN",
    spotId: optionalId(product.spot_id ?? parent.spot_id, `商品 ${goodsId} spot_id`),
    spotName: text(product.spot_name) || text(parent.spot_name),
    limitDays: integer(product.limit_day, `商品 ${goodsId} limit_day`, true),
    priceEndDate: text(product.price_end_date) || null,
  };
}

function groupFor(ticketType: string): TicketGroup {
  if (ticketType === "ADULT") return "adult";
  if (ticketType === "CHILDREN") return "children";
  return "other";
}

function checkedDate(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${label} 日期必须采用 YYYY-MM-DD 格式。`);
  }
  const [year, month, day] = value.split("-").map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1]) {
    throw new Error(`${label} 日期不合法：${value}。`);
  }
  return value;
}

function money(value: unknown, label: string, optional = false): number | null {
  if (optional && (value === undefined || value === null)) return null;
  if (
    (typeof value !== "number" && typeof value !== "string") ||
    (typeof value === "string" && !/^\d+(?:\.\d+)?$/.test(value.trim()))
  ) {
    throw new Error(`${label} 金额不合法，必须是非负有限数值。`);
  }
  const result = Number(value);
  if (!Number.isFinite(result) || result < 0 || result > Number.MAX_SAFE_INTEGER) {
    throw new Error(`${label} 金额不合法，必须是非负有限数值。`);
  }
  return result;
}

/**
 * prices 使用预订页日历实际显示的 mall_price，另保留 b2b/market 价格供核对。
 * 日历前端本身未检查 valid；导出仍仅将 valid=1 纳入简表，所有日期均保留在 rows。
 */
export function buildPriceExport(
  products: NormalizedProduct[],
  recordsByGoods: Record<string, unknown[]>,
  options: { fetchedAt?: string; sourceUrl?: string } = {},
) {
  const prices: Prices = { adult: {}, children: {}, other: {} };
  const dayNumbers: DayNumbers = { adult: {}, children: {}, other: {} };
  const metadata: Record<string, NormalizedProduct & { group: TicketGroup }> = {};
  const warnings: string[] = [];
  const rows: DailyPriceRow[] = [];
  const seen = new Map<string, DailyPriceRow>();
  let sourceRecordCount = 0;

  for (const product of products) {
    const goodsId = positiveId(product.goodsId, "商品 goodsId");
    const id = String(goodsId);
    const group = groupFor(product.ticketType);
    if (metadata[id]) {
      if (JSON.stringify(metadata[id]) !== JSON.stringify({ ...product, group })) {
        throw new Error(`商品 ${id} 的元数据重复且不一致。`);
      }
      warnings.push(`商品 ${id} 重复出现，已合并相同元数据。`);
      continue;
    }
    metadata[id] = { ...product, group };
    prices[group][id] = {};
    dayNumbers[group][id] = {};
    if (
      (product.ticketType === "CHILDREN" && product.name.includes("成人")) ||
      (product.ticketType === "ADULT" && product.name.includes("儿童"))
    ) {
      warnings.push(
        `商品 ${id} 名称“${product.name}”与 ticket_type=${product.ticketType} 冲突；按接口显式票种分组，未根据名称更改。`,
      );
    }
    if (group === "other") {
      warnings.push(`商品 ${id} 票种 ${product.ticketType} 未归入成人/儿童，保留在 other。`);
    }
  }

  for (const [id, records] of Object.entries(recordsByGoods)) {
    if (!metadata[id]) throw new Error(`价格记录引用了未收集的商品 ${id}。`);
    if (!Array.isArray(records)) throw new Error(`商品 ${id} 的价格记录必须是数组。`);
  }

  for (const [id, product] of Object.entries(metadata)) {
    const records = recordsByGoods[id] ?? [];
    for (const raw of records) {
      sourceRecordCount += 1;
      const record = asRecord(raw, `商品 ${id} 价格记录`);
      if (
        record.goods_id !== undefined &&
        positiveId(record.goods_id, `商品 ${id} 记录 goods_id`) !== product.goodsId
      ) {
        throw new Error(`商品 ${id} 价格记录中的 goods_id 不匹配。`);
      }
      const date = checkedDate(record.date, `商品 ${id}`);
      const label = `商品 ${id} ${date}`;
      const valid = integer(record.valid, `${label} valid`, true);
      const row: DailyPriceRow = {
        goodsId: product.goodsId,
        goodsPriceId: optionalId(record.goods_price_id, `${label} goods_price_id`),
        ticketType: product.ticketType,
        group: product.group,
        date,
        b2bPrice: money(record.b2b_price, `${label} b2b_price`) as number,
        marketPrice: money(record.market_price, `${label} market_price`, true),
        mallPrice: money(record.mall_price, `${label} mall_price`) as number,
        valid,
        stock: integer(record.stock, `${label} stock`, true),
        includedInPrices: valid === 1,
      };
      const key = `${id}:${date}`;
      const previous = seen.get(key);
      if (previous) {
        if (
          previous.b2bPrice !== row.b2bPrice ||
          previous.marketPrice !== row.marketPrice ||
          previous.mallPrice !== row.mallPrice ||
          previous.valid !== row.valid ||
          previous.stock !== row.stock
        ) {
          throw new Error(`${label} 存在冲突的重复记录（价格、有效性或库存不一致），禁止覆盖。`);
        }
        warnings.push(`${label} 重复返回相同价格与状态，已合并为一条记录。`);
        continue;
      }
      seen.set(key, row);
      rows.push(row);

      if (row.stock === 0) {
        warnings.push(`${label} stock=0；库存含义尚未确认，保留明细及 valid=1 的价格，请核对可订状态。`);
      } else if (row.stock !== null && row.stock < -1) {
        warnings.push(`${label} stock=${row.stock} 为未知库存值，按原值保留。`);
      }
      if (valid !== 0 && valid !== 1) {
        warnings.push(`${label} valid=${valid} 未明确有效，仅保留明细，不加入 prices。`);
      }
      if (!row.includedInPrices) continue;
      prices[product.group][id][date] = row.mallPrice;
      const month = date.slice(0, 7);
      const day = String(Number(date.slice(8)));
      dayNumbers[product.group][id][month] ??= {};
      dayNumbers[product.group][id][month][day] = row.mallPrice;
    }
    if (records.length === 0) warnings.push(`商品 ${id} 未返回每日价格记录。`);
    else if (Object.keys(prices[product.group][id]).length === 0) {
      warnings.push(`商品 ${id} 没有 valid=1 的每日价格，原始日期状态已保留在 rows。`);
    }
  }

  rows.sort((a, b) => a.goodsId - b.goodsId || a.date.localeCompare(b.date));
  for (const group of ["adult", "children", "other"] as const) {
    for (const id of Object.keys(prices[group])) {
      prices[group][id] = Object.fromEntries(
        Object.entries(prices[group][id]).sort(([a], [b]) => a.localeCompare(b)),
      );
      dayNumbers[group][id] = Object.fromEntries(
        Object.entries(dayNumbers[group][id]).sort(([a], [b]) => a.localeCompare(b)),
      );
    }
  }
  const availableRows = rows.filter((row) => row.includedInPrices);
  const availableDates = [...new Set(availableRows.map((row) => row.date))].sort();
  return {
    fetchedAt: options.fetchedAt ?? new Date().toISOString(),
    sourceUrl: options.sourceUrl ?? null,
    priceSource: "mall_price" as const,
    prices,
    dayNumbers,
    products: metadata,
    rows,
    warnings,
    summary: {
      productCount: Object.keys(metadata).length,
      productCounts: {
        adult: Object.keys(prices.adult).length,
        children: Object.keys(prices.children).length,
        other: Object.keys(prices.other).length,
      },
      sourceRecordCount,
      dailyRecordCount: rows.length,
      priceCount: availableRows.length,
      excludedInvalidCount: rows.length - availableRows.length,
      zeroStockRecordCount: rows.filter((row) => row.stock === 0).length,
      productsWithoutPrices: Object.values(metadata)
        .filter((product) => Object.keys(prices[product.group][String(product.goodsId)]).length === 0)
        .map((product) => product.goodsId),
      dateCount: availableDates.length,
      dateStart: availableDates[0] ?? null,
      dateEnd: availableDates.at(-1) ?? null,
    },
  };
}
