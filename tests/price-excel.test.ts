import test from "node:test";
import assert from "node:assert/strict";
import { crc32, inflateRawSync } from "node:zlib";
import { buildPriceExport, normalizeProduct } from "../lib/ticket-prices.ts";
import { applyTicketTypeOverrides } from "../lib/ticket-type-config.ts";
import { buildPriceWorkbook } from "../lib/price-excel.ts";

const exportedAt = "2026-11-12T09:10:12.000Z";
const beijing = "北京环球度假区";
const shanghai = "上海迪士尼度假区";

/** 独立解析 ZIP 中央目录并验证每个条目的 local header、大小与 CRC。 */
function unzip(buffer: Buffer) {
  assert.equal(buffer.readUInt32LE(buffer.length - 22), 0x06054b50);
  const end = buffer.length - 22;
  assert.equal(buffer.readUInt16LE(end + 4), 0);
  assert.equal(buffer.readUInt16LE(end + 6), 0);
  assert.equal(buffer.readUInt16LE(end + 8), buffer.readUInt16LE(end + 10));
  const count = buffer.readUInt16LE(end + 10);
  const directorySize = buffer.readUInt32LE(end + 12);
  const directoryStart = buffer.readUInt32LE(end + 16);
  assert.equal(directoryStart + directorySize, end);
  let pointer = directoryStart;
  const files = new Map<string, string>();
  for (let index = 0; index < count; index++) {
    assert.equal(buffer.readUInt32LE(pointer), 0x02014b50);
    assert.equal(buffer.readUInt16LE(pointer + 8), 0x0800);
    assert.equal(buffer.readUInt16LE(pointer + 10), 8);
    const checksum = buffer.readUInt32LE(pointer + 16);
    const compressedSize = buffer.readUInt32LE(pointer + 20);
    const size = buffer.readUInt32LE(pointer + 24);
    const nameLength = buffer.readUInt16LE(pointer + 28);
    const extraLength = buffer.readUInt16LE(pointer + 30);
    const commentLength = buffer.readUInt16LE(pointer + 32);
    const localOffset = buffer.readUInt32LE(pointer + 42);
    const name = buffer.subarray(pointer + 46, pointer + 46 + nameLength).toString("utf8");
    assert.equal(buffer.readUInt32LE(localOffset), 0x04034b50);
    assert.equal(buffer.readUInt16LE(localOffset + 6), 0x0800);
    assert.equal(buffer.readUInt16LE(localOffset + 8), 8);
    assert.equal(buffer.readUInt32LE(localOffset + 14), checksum);
    assert.equal(buffer.readUInt32LE(localOffset + 18), compressedSize);
    assert.equal(buffer.readUInt32LE(localOffset + 22), size);
    assert.equal(buffer.readUInt16LE(localOffset + 26), nameLength);
    const localName = buffer.subarray(localOffset + 30, localOffset + 30 + nameLength).toString("utf8");
    assert.equal(localName, name);
    const contentStart = localOffset + 30 + nameLength + buffer.readUInt16LE(localOffset + 28);
    const content = inflateRawSync(buffer.subarray(contentStart, contentStart + compressedSize));
    assert.equal(content.length, size, name);
    assert.equal(crc32(content), checksum, name);
    assert.equal(files.has(name), false);
    files.set(name, content.toString("utf8"));
    pointer += 46 + nameLength + extraLength + commentLength;
  }
  assert.equal(pointer, end);
  return files;
}

function unescapeXml(value: string) {
  return value.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'").replaceAll("&amp;", "&");
}

function sheetRows(xml: string) {
  return [...xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)].map(match => {
    const values: (string | number | undefined)[] = [];
    for (const cell of match[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      const reference = cell[1].match(/\br="([A-Z]+)\d+"/)![1];
      const column = [...reference].reduce((total, character) => total * 26 + character.charCodeAt(0) - 64, 0) - 1;
      if (cell[1].includes('t="inlineStr"')) values[column] = unescapeXml(cell[2].match(/<t\b[^>]*>([\s\S]*?)<\/t>/)![1]);
      else values[column] = Number(cell[2].match(/<v>([^<]*)<\/v>/)![1]);
    }
    return values;
  });
}

function fixture() {
  const products = [
    [101, "北京环球影城-1日成人票-提前15天预定-完整渠道A", "ADULT", 10, beijing],
    [102, "北京环球影城-1日成人票-完整渠道B", "ADULT", 10, beijing],
    [103, "北京环球影城-1日儿童票-完整渠道C", "CHILDREN", 10, beijing],
    [104, "北京环球影城-1.5日成人票-完整渠道D", "ADULT", 10, beijing],
    [105, "北京环球影城-1.5日儿童票-完整渠道E", "CHILDREN", 10, beijing],
    [106, "指定日成人票-接口为儿童需设置", "CHILDREN", 10, beijing],
    [107, "北京环球影城-1日成人票-没有价格的渠道", "ADULT", 10, beijing],
    [201, "上海迪士尼乐园1日成人票-完整渠道F", "ADULT", 20, shanghai],
    [202, "上海迪士尼乐园1日儿童票-仅无效报价", "CHILDREN", 20, shanghai],
  ].map(([id, name, ticketType, spotId, spotName]) => normalizeProduct({
    goods_id: id, goods_name: name, ticket_type: ticketType, spot_id: spotId, spot_name: spotName,
  }));
  const row = (goodsId: number, date: string, price: number, extra = {}) => ({
    goods_id: goodsId, date, mall_price: price, b2b_price: price, valid: 1, stock: -1, ...extra,
  });
  const snapshot = applyTicketTypeOverrides({
    ...buildPriceExport(products, {
      101: [row(101, "2026-11-26", 100), row(101, "2026-11-27", 1, { valid: 0 }), row(101, "2026-11-28", 1, { valid: 0 })],
      102: [row(102, "2026-11-26", 80), row(102, "2026-11-27", 0, { stock: 0 })],
      103: [row(103, "2026-11-26", 50), row(103, "2026-11-27", 0)],
      104: [row(104, "2026-11-26", 150), row(104, "2026-11-27", 1)],
      105: [row(105, "2026-11-26", 130)],
      106: [row(106, "2026-11-26", 1)],
      201: [row(201, "2026-11-26", 10), row(201, "2026-11-27", 12, { stock: null })],
      202: [row(202, "2026-11-27", 1, { valid: 0 })],
    }, { fetchedAt: "2026-11-11T08:00:00.000Z" }),
    collectionStatus: "complete", collection: { requestedProducts: products.length, completedProducts: products.length, failures: [] },
  }, { 104: "adult_1_5d" });
  snapshot.rows.find(row => row.goodsId === 104 && row.date === "2026-11-27")!.includedInPrices = false;
  const duplicate = snapshot.rows.find(row => row.goodsId === 101 && row.date === "2026-11-26")!;
  snapshot.rows.push(
    { ...duplicate, mallPrice: 80 }, { ...duplicate, mallPrice: 80 },
    { ...duplicate, mallPrice: 1, valid: 0, includedInPrices: false },
    { ...duplicate, mallPrice: 2, stock: 0 }, { ...duplicate, mallPrice: 3, includedInPrices: false },
  );
  snapshot.summary.dailyRecordCount = snapshot.rows.length;
  snapshot.summary.sourceRecordCount = snapshot.rows.length;
  snapshot.summary.priceCount = snapshot.rows.filter(row => row.includedInPrices).length;
  return snapshot;
}

test("标准xlsx ZIP可解压且CRC完整，四个工作表有冻结筛选、换行与两位数值样式", () => {
  const source = fixture();
  const previous = structuredClone(source);
  const workbook = buildPriceWorkbook(source, { exportedAt });
  assert.ok(Buffer.isBuffer(workbook));
  assert.deepEqual(source, previous);
  assert.deepEqual(buildPriceWorkbook(source, { exportedAt }), workbook);
  const files = unzip(workbook);
  assert.equal(files.size, 11);
  assert.ok(files.has("[Content_Types].xml"));
  assert.ok(files.has("_rels/.rels"));
  assert.ok(files.has("xl/_rels/workbook.xml.rels"));
  const workbookXml = files.get("xl/workbook.xml")!;
  assert.deepEqual([...workbookXml.matchAll(/<sheet name="([^"]+)"/g)].map(match => match[1]), ["渠道每日最低价", "每日票种最低价", "报价明细", "导出说明"]);
  assert.match(files.get("xl/worksheets/sheet1.xml")!, /xSplit="5" ySplit="1" topLeftCell="F2"/);
  assert.match(files.get("xl/worksheets/sheet2.xml")!, /xSplit="4" ySplit="1"/);
  assert.match(files.get("xl/worksheets/sheet3.xml")!, /xSplit="4" ySplit="1"/);
  assert.match(files.get("xl/worksheets/sheet1.xml")!, /<autoFilter ref="A1:H10"\/>/);
  assert.match(files.get("xl/styles.xml")!, /numFmtId="164" formatCode="0.00"/);
  assert.match(files.get("xl/styles.xml")!, /wrapText="1"/);
  assert.match(files.get("xl/worksheets/sheet1.xml")!, /<c r="F2" s="2"><v>80<\/v><\/c>/);
  assert.match(files.get("docProps/core.xml")!, /2026-11-12T09:10:12.000Z/);
  const notes = sheetRows(files.get("xl/worksheets/sheet4.xml")!);
  assert.ok(notes.some(row => row[0] === "数据更新时间" && row[1] === source.fetchedAt));
  assert.ok(notes.some(row => row[0] === "导出时间" && row[1] === exportedAt));
  assert.ok(notes.some(row => String(row[1]).includes("不受页面筛选影响")));
});

test("每渠道每日取最低可用价，零元保留，库存0/valid0/未纳入记录不参与且无价渠道不丢", () => {
  const source = fixture();
  const files = unzip(buildPriceWorkbook(source, { exportedAt }));
  const rows = sheetRows(files.get("xl/worksheets/sheet1.xml")!);
  assert.deepEqual(rows[0], ["旅游地区", "票种", "渠道ID", "渠道完整名称", "票种来源", "2026-11-26", "2026-11-27", "2026-11-28"]);
  assert.equal(rows.length, Object.keys(source.products).length + 1);
  const channel = (id: number) => rows.find(row => row[2] === String(id))!;
  assert.equal(channel(101)[5], 80);
  assert.equal(channel(101)[6], undefined);
  assert.equal(channel(102)[6], undefined);
  assert.equal(channel(103)[6], 0);
  assert.equal(channel(104)[6], undefined);
  assert.equal(channel(104)[4], "本地设置");
  assert.equal(channel(106)[1], "待设置");
  assert.equal(channel(106)[5], 1);
  assert.deepEqual(channel(107).slice(5), []);
  assert.equal(channel(107)[3], source.products[107].name);
  assert.equal(channel(201)[6], 12);
  assert.equal(channel(202)[6], undefined);
  assert.ok(rows.slice(1).every(row => row[7] === undefined));
});

test("每日四票种最低价按地区隔离，并列最低保留所有ID与完整名称，待设置不混入", () => {
  const source = fixture();
  const files = unzip(buildPriceWorkbook(source, { exportedAt }));
  const rows = sheetRows(files.get("xl/worksheets/sheet2.xml")!).slice(1);
  const adult = rows.find(row => row[0] === beijing && row[1] === "1日成人" && row[2] === "2026-11-26")!;
  assert.equal(adult[3], 80);
  assert.equal(adult[4], "101\n102");
  assert.equal(adult[5], `${source.products[101].name}\n${source.products[102].name}`);
  assert.equal(rows.find(row => row[0] === shanghai && row[1] === "1日成人" && row[2] === "2026-11-26")?.[3], 10);
  assert.equal(rows.find(row => row[0] === beijing && row[1] === "1日儿童" && row[2] === "2026-11-27")?.[3], 0);
  assert.equal(rows.find(row => row[0] === beijing && row[1] === "1.5日成人")?.[3], 150);
  assert.equal(rows.find(row => row[0] === beijing && row[1] === "1.5日儿童")?.[3], 130);
  assert.equal(rows.some(row => row[1] === "待设置" || row[2] === "2026-11-28"), false);
  assert.equal(rows.some(row => row[0] === beijing && row[1] === "1日成人" && row[2] === "2026-11-27"), false);
});

test("报价明细保留全部原记录和无效状态，人工改票种后的Excel服从本地类别", () => {
  const source = applyTicketTypeOverrides(fixture(), { 106: "adult_1_5d" });
  const files = unzip(buildPriceWorkbook(source, { exportedAt }));
  const details = sheetRows(files.get("xl/worksheets/sheet3.xml")!).slice(1);
  assert.equal(details.length, source.rows.length);
  for (const [index, row] of source.rows.entries()) {
    assert.equal(details[index][2], String(row.goodsId));
    assert.equal(details[index][4], row.date);
    assert.equal(details[index][5], row.mallPrice);
    assert.equal(details[index][6] ?? null, row.valid);
    assert.equal(details[index][7] ?? null, row.stock);
    assert.equal(details[index][9], row.valid === 1 && row.includedInPrices === true && row.stock !== 0 ? "是" : "否");
  }
  const channel = sheetRows(files.get("xl/worksheets/sheet1.xml")!).find(row => row[2] === "106")!;
  assert.equal(channel[1], "1.5日成人");
  assert.equal(channel[4], "本地设置");
  const summary = sheetRows(files.get("xl/worksheets/sheet2.xml")!).find(row => row[0] === beijing && row[1] === "1.5日成人" && row[2] === "2026-11-26")!;
  assert.equal(summary[3], 1);
  assert.equal(summary[4], "106");
});

test("完整名称以inlineStr安全保存，XML字符、控制字符和字面量OOXML转义不形成公式", () => {
  const source = fixture();
  source.products[101].name = '=HYPERLINK("https://example.invalid", "标题") <>&\' _x0041_ \u0000\u0001\u000b\ufffe\ud800🎫';
  source.products[102].name = "+SUM(1,2)";
  source.products[103].name = "@SUM(1,2)";
  source.products[104].name = "-SUM(1,2)";
  const files = unzip(buildPriceWorkbook(source, { exportedAt }));
  const matrix = files.get("xl/worksheets/sheet1.xml")!;
  assert.match(matrix, /t="inlineStr"><is><t xml:space="preserve">=HYPERLINK/);
  assert.match(matrix, /&lt;&gt;&amp;&apos;/);
  assert.match(matrix, /_x005F_x0041_/);
  assert.match(matrix, /_x0000__x0001__x000B__xFFFE__xD800_🎫/);
  assert.equal(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/u.test(matrix), false);
  assert.equal([...files.values()].some(xml => /<f(?:\s|>)/.test(xml)), false);
  assert.equal([...files.keys()].some(name => /externalLinks|vbaProject/.test(name)), false);
});

test("金额异常、无效日期、孤立明细和partial快照拒绝导出，避免生成误导性数据", () => {
  for (const price of [NaN, Infinity, -1]) {
    const source = fixture();
    source.rows[0].mallPrice = price;
    assert.throws(() => buildPriceWorkbook(source, { exportedAt }), /金额不合法/);
  }
  const invalidDate = fixture();
  invalidDate.rows[0].date = "2026-02-30";
  assert.throws(() => buildPriceWorkbook(invalidDate, { exportedAt }), /日期.*不合法/);
  const orphan = fixture();
  orphan.rows[0].goodsId = 999999;
  assert.throws(() => buildPriceWorkbook(orphan, { exportedAt }), /渠道 999999 不存在/);
  const partial = fixture();
  partial.collectionStatus = "partial";
  assert.throws(() => buildPriceWorkbook(partial, { exportedAt }), /完整价格数据/);
  assert.throws(() => buildPriceWorkbook(fixture(), { exportedAt: "not-a-date" }), /导出时间不合法/);
});

test("完整空快照导出四张合法工作表，不编造价格、日期和渠道", () => {
  const source = { ...buildPriceExport([], {}), collectionStatus: "complete", collection: { requestedProducts: 0, completedProducts: 0, failures: [] } };
  const files = unzip(buildPriceWorkbook(source, { exportedAt }));
  assert.equal(sheetRows(files.get("xl/worksheets/sheet1.xml")!).length, 1);
  assert.equal(sheetRows(files.get("xl/worksheets/sheet1.xml")!)[0].length, 5);
  assert.equal(sheetRows(files.get("xl/worksheets/sheet2.xml")!).length, 1);
  assert.equal(sheetRows(files.get("xl/worksheets/sheet3.xml")!).length, 1);
  assert.match(files.get("xl/worksheets/sheet4.xml")!, /暂无价格日期/);
});
