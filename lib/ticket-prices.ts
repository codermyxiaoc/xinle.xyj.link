export const TICKET_GROUPS = ["adult_1d", "children_1d", "adult_1_5d", "children_1_5d", "other"] as const;
export type TicketGroup = typeof TICKET_GROUPS[number];
export const TICKET_GROUP_LABELS: Record<TicketGroup, string> = {
  adult_1d: "1日成人", children_1d: "1日儿童", adult_1_5d: "1.5日成人", children_1_5d: "1.5日儿童", other: "待设置",
};
export type VisitDays = 1 | 1.5 | null;

export function emptyTicketGroups<T>(factory: () => T): Record<TicketGroup, T> {
  return Object.fromEntries(TICKET_GROUPS.map(group => [group, factory()])) as Record<TicketGroup, T>;
}

/** 地区按来源景区区分，不能因页面省份标注错误而把不同景区混在一起。 */
export function productDestination(product: { spotId?: number | null; spotName?: string }) {
  const name = typeof product.spotName === "string" ? product.spotName.trim() : "";
  return {
    destinationKey: product.spotId ? `spot:${product.spotId}` : name ? `name:${name}` : "unknown",
    destinationName: name || "未标注地区",
  };
}

/** 只识别明确的游玩时长；预订提前天数、日期和多人组合不作为单人票依据。 */
export function classifyTicket(name: string, sourceTicketType: string): { group: TicketGroup; visitDays: VisitDays; reason: string | null } {
  const normalized = String(name ?? "").normalize("NFKC").replace(/\s+/g, "");
  const durationText = normalized
    .replace(/提前(?:至少|最少)?(?:\d+(?:\.\d+)?|[一二两三四五六七八九十]+)[天日](?:预[订定])?/g, "")
    .replace(/(?:\d+(?:\.\d+)?|[一二两三四五六七八九十]+)[天日]内(?:预[订定])?/g, "")
    .replace(/\d{1,2}月\d{1,2}日/g, "");
  const durations = new Set<number>();
  const halfDayPattern = /(?<![\d.])1\.5[日天]|(?<![\d.])1[日天]半|[一壹][日天]半/g;
  const withoutHalfDays = durationText.replace(halfDayPattern, () => { durations.add(1.5); return ""; });
  for (const match of withoutHalfDays.matchAll(/(?<![\d.])(\d+(?:\.\d+)?)[日天]/g)) durations.add(Number(match[1]));
  if (/(?<![一二三四五六七八九十])[一壹][日天]|单日/.test(withoutHalfDays)) durations.add(1);
  const onlyDuration = durations.size === 1 ? [...durations][0] : null;
  const visitDays: VisitDays = onlyDuration === 1 || onlyDuration === 1.5 ? onlyDuration : null;
  const namedAdult = /成人/.test(normalized);
  const namedChild = /儿童|小童/.test(normalized);
  const multiPerson = /家庭|亲子|多人|双人|情侣|(?:[二两三四五六七八九十2-9]|\d{2,})人|(?:[二两三四五六七八九十2-9]|\d{2,})张|[一二两三四五六七八九十\d]+大[一二两三四五六七八九十\d]+小/.test(normalized);
  if (multiPerson || namedAdult && namedChild) return { group: "other", visitDays, reason: "多人或混合人群产品，请确认后在票种设置中指定" };
  if (/老人|老年|长者|青年|学生|年卡|季卡|月卡/.test(normalized) || !["ADULT", "CHILDREN", "UNLIMITED", "ALL", "UNKNOWN", ""].includes(sourceTicketType)) {
    return { group: "other", visitDays, reason: "其他适用人群或特殊票种，请在票种设置中确认" };
  }
  const declaredAudience = sourceTicketType === "ADULT" ? "adult" : sourceTicketType === "CHILDREN" ? "children" : null;
  const namedAudience = namedAdult ? "adult" : namedChild ? "children" : null;
  if (declaredAudience && namedAudience && declaredAudience !== namedAudience) {
    return { group: "other", visitDays, reason: "接口票种与产品名称冲突，请在票种设置中确认" };
  }
  if (!visitDays) return { group: "other", visitDays, reason: "无法确认1日或1.5日游玩时长，请在票种设置中确认" };
  const audience = declaredAudience ?? namedAudience;
  if (!audience) return { group: "other", visitDays, reason: "无法确认成人或儿童人群，请在票种设置中确认" };
  return { group: `${audience}_${visitDays === 1 ? "1d" : "1_5d"}` as TicketGroup, visitDays, reason: null };
}

export function ticketClassificationWarning(goodsId: string | number, reason: string | null) {
  return `商品 ${goodsId} 票种待设置：${reason ?? "请确认游玩时长及适用人群"}。`;
}

export interface NormalizedProduct {
  goodsId: number;
  name: string;
  ticketType: string;
  spotId: number | null;
  spotName: string;
  limitDays: number | null;
  priceEndDate: string | null;
  destinationKey: string;
  destinationName: string;
  visitDays: VisitDays;
  classificationReason: string | null;
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
  visitDays: VisitDays;
  destinationKey: string;
  destinationName: string;
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

/** 上游年卡等动态定价行用 0 作为价格记录占位 ID，商品本身仍必须有正整数 ID。 */
function optionalPriceId(value: unknown, label: string): number | null {
  const result = integer(value, label, true);
  if (result !== null && result < 0) throw new Error(`${label} 必须是非负整数。`);
  return result;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** 只提取价格采集需要的元数据，不复制商品对象中的账号/接口配置。 */
export function normalizeProduct(raw: unknown, spot?: unknown): NormalizedProduct {
  const product = asRecord(raw, "商品");
  const parent = spot === undefined ? {} : asRecord(spot, "景区");
  const goodsId = positiveId(product.goods_id, "goods_id");
  const spotId = optionalId(product.spot_id ?? parent.spot_id, `商品 ${goodsId} spot_id`);
  const spotName = text(product.spot_name) || text(parent.spot_name);
  const name = text(product.goods_name);
  const ticketType = text(product.ticket_type).toUpperCase() || "UNKNOWN";
  const classification = classifyTicket(name, ticketType);
  return {
    goodsId,
    name, ticketType, spotId, spotName,
    limitDays: integer(product.limit_day, `商品 ${goodsId} limit_day`, true),
    priceEndDate: text(product.price_end_date) || null,
    ...productDestination({ spotId, spotName }),
    visitDays: classification.visitDays,
    classificationReason: classification.reason,
  };
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
  const prices: Prices = emptyTicketGroups(() => ({}));
  const dayNumbers: DayNumbers = emptyTicketGroups(() => ({}));
  const metadata: Record<string, NormalizedProduct & { group: TicketGroup }> = {};
  const warnings: string[] = [];
  const rows: DailyPriceRow[] = [];
  const seen = new Map<string, DailyPriceRow>();
  let sourceRecordCount = 0;

  for (const product of products) {
    const goodsId = positiveId(product.goodsId, "商品 goodsId");
    const id = String(goodsId);
    const { group, visitDays, reason } = classifyTicket(product.name, product.ticketType);
    const normalized = { ...product, ...productDestination(product), visitDays, classificationReason: reason, group };
    if (metadata[id]) {
      if (JSON.stringify(metadata[id]) !== JSON.stringify(normalized)) {
        throw new Error(`商品 ${id} 的元数据重复且不一致。`);
      }
      warnings.push(`商品 ${id} 重复出现，已合并相同元数据。`);
      continue;
    }
    metadata[id] = normalized;
    prices[group][id] = {};
    dayNumbers[group][id] = {};
    if (group === "other") {
      warnings.push(ticketClassificationWarning(id, reason));
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
        goodsPriceId: optionalPriceId(record.goods_price_id, `${label} goods_price_id`),
        ticketType: product.ticketType,
        group: product.group,
        date,
        b2bPrice: money(record.b2b_price, `${label} b2b_price`) as number,
        marketPrice: money(record.market_price, `${label} market_price`, true),
        mallPrice: money(record.mall_price, `${label} mall_price`) as number,
        valid,
        stock: integer(record.stock, `${label} stock`, true),
        includedInPrices: valid === 1,
        visitDays: product.visitDays,
        destinationKey: product.destinationKey,
        destinationName: product.destinationName,
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
  for (const group of TICKET_GROUPS) {
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
    schemaVersion: 2,
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
      productCounts: Object.fromEntries(TICKET_GROUPS.map(group => [group, Object.keys(prices[group]).length])) as Record<TicketGroup, number>,
      destinationCount: new Set(Object.values(metadata).map(product => product.destinationKey)).size,
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
