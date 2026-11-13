import { TICKET_GROUPS, TICKET_GROUP_LABELS, productDestination, type TicketGroup } from "./ticket-prices.ts";
import type { PersistablePriceExport } from "./price-store.ts";
import { createXlsxWorkbook, type XlsxSheet, type XlsxValue } from "./xlsx.ts";

type Product = PersistablePriceExport["products"][string] & { ticketTypeSource?: "local" | "remote" };
export type PriceWorkbookSnapshot = Omit<PersistablePriceExport, "products"> & { products: Record<string, Product> };
type ExportProduct = Product & { group: TicketGroup };
type Minimum = { product: ExportProduct; date: string; price: number; winners: ExportProduct[] };

function dateValue(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number(value.slice(0, 4)) < 1) {
    throw new Error("每日价格的日期格式不合法，无法导出 Excel。");
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw new Error(`日期 ${value} 不合法，无法导出 Excel。`);
  return value;
}

function sourceLabel(product: Product) {
  return product.ticketTypeSource === "local" ? "本地设置" : "自动识别";
}

function compareDestination(a: ExportProduct, b: ExportProduct) {
  return a.destinationName.localeCompare(b.destinationName, "zh-Hans-CN") || a.destinationKey.localeCompare(b.destinationKey);
}

/** 按看板的可用性规则导出完整已保存快照；不发起采集、不应用页面筛选。 */
export function buildPriceWorkbook(snapshot: PriceWorkbookSnapshot, options: { exportedAt?: string } = {}): Buffer {
  if (!snapshot || snapshot.collectionStatus !== "complete" || !snapshot.products || !Array.isArray(snapshot.rows)) {
    throw new Error("只能导出已保存的完整价格数据。");
  }
  const exportedAt = options.exportedAt ?? new Date().toISOString();
  const products: ExportProduct[] = Object.entries(snapshot.products).map(([id, product]) => {
    if (!product || String(product.goodsId) !== id || !Number.isSafeInteger(product.goodsId) || product.goodsId <= 0 || typeof product.name !== "string") {
      throw new Error(`渠道 ${id} 的信息不完整，无法导出 Excel。`);
    }
    const destination = productDestination(product);
    return {
      ...product,
      destinationKey: product.destinationKey || destination.destinationKey,
      destinationName: product.destinationName || destination.destinationName,
      group: TICKET_GROUPS.includes(product.group) ? product.group : "other",
    };
  }).sort((a, b) => compareDestination(a, b) || TICKET_GROUPS.indexOf(a.group) - TICKET_GROUPS.indexOf(b.group) || a.goodsId - b.goodsId);
  const productsById = new Map(products.map(product => [product.goodsId, product]));
  const dates = new Set<string>();
  const byChannel = new Map<number, Map<string, number>>();
  const detailRows: XlsxValue[][] = [];
  for (const row of snapshot.rows) {
    const product = productsById.get(row.goodsId);
    if (!product) throw new Error(`价格明细的渠道 ${row.goodsId} 不存在，无法导出 Excel。`);
    const date = dateValue(row.date);
    dates.add(date);
    if (typeof row.mallPrice !== "number" || !Number.isFinite(row.mallPrice) || row.mallPrice < 0 || row.mallPrice > Number.MAX_SAFE_INTEGER) {
      throw new Error(`渠道 ${row.goodsId} ${date} 金额不合法，无法导出 Excel。`);
    }
    for (const field of ["valid", "stock"] as const) {
      if (row[field] !== null && row[field] !== undefined && !Number.isSafeInteger(row[field])) {
        throw new Error(`渠道 ${row.goodsId} ${date} ${field} 不合法，无法导出 Excel。`);
      }
    }
    const available = row.valid === 1 && row.includedInPrices === true && row.stock !== 0;
    detailRows.push([
      product.destinationName, TICKET_GROUP_LABELS[product.group], String(product.goodsId), product.name,
      date, row.mallPrice, row.valid, row.stock, row.includedInPrices === true ? "是" : "否", available ? "是" : "否",
    ]);
    if (!available) continue;
    let channel = byChannel.get(product.goodsId);
    if (!channel) { channel = new Map(); byChannel.set(product.goodsId, channel); }
    const previous = channel.get(date);
    if (previous === undefined || row.mallPrice < previous) channel.set(date, row.mallPrice);
  }
  const dateColumns = [...dates].sort();
  const minima = new Map<string, Minimum>();
  for (const product of products) {
    if (product.group === "other") continue;
    for (const [date, price] of byChannel.get(product.goodsId) ?? []) {
      const key = JSON.stringify([product.destinationKey, product.group, date]);
      const previous = minima.get(key);
      if (!previous || price < previous.price) minima.set(key, { product, date, price, winners: [product] });
      else if (price === previous.price) previous.winners.push(product);
    }
  }
  const summaryRows = [...minima.values()].sort((a, b) => compareDestination(a.product, b.product) ||
    TICKET_GROUPS.indexOf(a.product.group) - TICKET_GROUPS.indexOf(b.product.group) || a.date.localeCompare(b.date))
    .map(({ product, date, price, winners }) => {
      winners.sort((a, b) => a.goodsId - b.goodsId);
      return [product.destinationName, TICKET_GROUP_LABELS[product.group], date, price,
        winners.map(winner => String(winner.goodsId)).join("\n"), winners.map(winner => winner.name).join("\n")];
    });
  const sheets: XlsxSheet[] = [
    {
      name: "渠道每日最低价", freezeColumns: 5,
      columns: [
        { header: "旅游地区", width: 26 }, { header: "票种", width: 16 }, { header: "渠道ID", width: 13 },
        { header: "渠道完整名称", width: 74 }, { header: "票种来源", width: 15 },
        ...dateColumns.map(date => ({ header: date, width: 15, format: "money" as const })),
      ],
      rows: products.map(product => [product.destinationName, TICKET_GROUP_LABELS[product.group], String(product.goodsId),
        product.name, sourceLabel(product), ...dateColumns.map(date => byChannel.get(product.goodsId)?.get(date) ?? null)]),
    },
    {
      name: "每日票种最低价", freezeColumns: 4,
      columns: [{ header: "旅游地区", width: 26 }, { header: "票种", width: 16 }, { header: "日期", width: 15 },
        { header: "最低价（元）", width: 17, format: "money" }, { header: "最低价渠道ID", width: 18 }, { header: "最低价渠道完整名称", width: 90 }],
      rows: summaryRows,
    },
    {
      name: "报价明细", freezeColumns: 4,
      columns: [{ header: "旅游地区", width: 26 }, { header: "票种", width: 16 }, { header: "渠道ID", width: 13 },
        { header: "渠道完整名称", width: 74 }, { header: "日期", width: 15 }, { header: "日历价（元）", width: 17, format: "money" },
        { header: "valid", width: 10, format: "integer" }, { header: "stock", width: 10, format: "integer" },
        { header: "纳入价格表", width: 15 }, { header: "是否可用", width: 13 }],
      rows: detailRows,
    },
    {
      name: "导出说明", freezeColumns: 1, autoFilter: false,
      columns: [{ header: "项目", width: 28 }, { header: "说明", width: 120 }],
      rows: [
        ["导出范围", "已保存的完整价格快照，包含所有旅游地区、所有渠道及所有日期；不受页面筛选影响。"],
        ["数据更新时间", snapshot.fetchedAt], ["导出时间", exportedAt],
        ["价格单位", "人民币（元/张）。使用日历价 mall_price，金额为数字并显示两位小数。"],
        ["渠道数量", products.length], ["旅游地区数量", new Set(products.map(product => product.destinationKey)).size],
        ["日期范围", dateColumns.length ? `${dateColumns[0]} 至 ${dateColumns.at(-1)}` : "暂无价格日期"],
        ["明细记录数", snapshot.rows.length],
        ["可用报价规则", "仅 valid=1、includedInPrices=true 且 stock≠0 的报价参与最低价；与看板规则一致。"],
        ["库存规则", "stock=0 不参与最低价；stock=-1 及未标注库存按看板规则保留。"],
        ["票种规则", "本地票种设置优先；未设置渠道采用自动识别。无法确认的票种保留为“待设置”，可在票种设置中指定。"],
        ["空白与零元", "渠道表中的空白表示该渠道当日没有可用报价；数字 0 表示真实、有效的零元报价。"],
        ["每日票种汇总", "只输出有可用报价的地区、四种已分类票种和日期组合；待设置不参与此汇总。并列最低保留全部获胜渠道，ID 与名称按相同顺序换行列出。"],
        ["重复报价与明细", "同一渠道同一天存在多条可用报价时取最低价。报价明细保留全部快照记录，包括无效记录和库存为0的记录，便于核对。"],
      ],
    },
  ];
  return createXlsxWorkbook(sheets, exportedAt);
}
