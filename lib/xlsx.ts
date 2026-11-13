import { crc32, deflateRawSync } from "node:zlib";

export type XlsxValue = string | number | boolean | null | undefined;
export interface XlsxColumn {
  header: string;
  width: number;
  format?: "money" | "integer";
}
export interface XlsxSheet {
  name: string;
  columns: XlsxColumn[];
  rows: XlsxValue[][];
  freezeColumns?: number;
  autoFilter?: boolean;
}

const xmlDeclaration = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const spreadsheetNs = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const relationshipNs = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const packageRelationshipNs = "http://schemas.openxmlformats.org/package/2006/relationships";

function escapeXml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

/** ST_Xstring 转义：保留控制字符和字面量 _xHHHH_，同时保证 XML 1.0 合法。 */
function cellText(value: string) {
  if (value.length > 32767) throw new Error("Excel 单元格文本超过 32767 字符上限，无法完整导出。");
  const escapedLiterals = value.replace(/_x[0-9a-fA-F]{4}_/g, match => `_x005F_${match.slice(1)}`);
  const validXml = Array.from(escapedLiterals, character => {
    const code = character.codePointAt(0)!;
    if ((code < 0x20 && code !== 0x9 && code !== 0xa && code !== 0xd) ||
        (code >= 0xd800 && code <= 0xdfff) || code === 0xfffe || code === 0xffff) {
      return `_x${code.toString(16).toUpperCase().padStart(4, "0")}_`;
    }
    return character;
  }).join("");
  return escapeXml(validXml);
}

function columnName(number: number) {
  let name = "";
  while (number > 0) {
    number--;
    name = String.fromCharCode(65 + number % 26) + name;
    number = Math.floor(number / 26);
  }
  return name;
}

function rowHeight(values: XlsxValue[], columns: XlsxColumn[]) {
  const lines = values.reduce((maximum, value, index) => {
    if (typeof value !== "string") return maximum;
    const width = Math.max(4, columns[index].width - 2);
    const count = value.split(/\r\n|\r|\n/).reduce((sum, line) => {
      const characters = Array.from(line).reduce((size, character) => size + (character.codePointAt(0)! > 255 ? 2 : 1), 0);
      return sum + Math.max(1, Math.ceil(characters / width));
    }, 0);
    return Math.max(maximum, count);
  }, 1);
  return Math.min(409, Math.max(26, lines * 16 + 8));
}

function renderCell(value: XlsxValue, reference: string, style: number) {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`Excel 单元格 ${reference} 的数字不是有限数值。`);
    return `<c r="${reference}" s="${style}"><v>${value}</v></c>`;
  }
  if (typeof value === "boolean") return `<c r="${reference}" s="${style}" t="b"><v>${value ? 1 : 0}</v></c>`;
  if (typeof value !== "string") throw new Error(`Excel 单元格 ${reference} 的内容类型不受支持。`);
  // 无论文本以 =、+、- 或 @ 开头，都明确写为字符串，绝不生成公式节点。
  return `<c r="${reference}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${cellText(value)}</t></is></c>`;
}

function worksheet(sheet: XlsxSheet) {
  if (!sheet.columns.length || sheet.columns.length > 16384 || sheet.rows.length + 1 > 1048576) {
    throw new Error(`工作表 ${sheet.name} 超出 Excel 行列数量限制。`);
  }
  const frozen = sheet.freezeColumns ?? 0;
  if (!Number.isInteger(frozen) || frozen < 0 || frozen > sheet.columns.length) throw new Error("冻结列数不合法。");
  for (const column of sheet.columns) {
    if (!Number.isFinite(column.width) || column.width < 1 || column.width > 255) throw new Error("Excel 列宽不合法。");
  }
  const lastCell = `${columnName(sheet.columns.length)}${sheet.rows.length + 1}`;
  const pane = frozen ? "bottomRight" : "bottomLeft";
  const firstScrollableCell = `${columnName(frozen + 1)}2`;
  const header = `<row r="1" ht="34" customHeight="1">${sheet.columns.map((column, index) => renderCell(column.header, `${columnName(index + 1)}1`, 1)).join("")}</row>`;
  const rows = sheet.rows.map((values, index) => {
    if (values.length > sheet.columns.length) throw new Error(`工作表 ${sheet.name} 的第 ${index + 2} 行超出列数。`);
    return `<row r="${index + 2}" ht="${rowHeight(values, sheet.columns)}" customHeight="1">${values.map((value, column) => {
      const style = sheet.columns[column].format === "money" ? 2 : sheet.columns[column].format === "integer" ? 3 : 0;
      return renderCell(value, `${columnName(column + 1)}${index + 2}`, style);
    }).join("")}</row>`;
  }).join("");
  return xmlDeclaration + `<worksheet xmlns="${spreadsheetNs}">` +
    `<dimension ref="A1:${lastCell}"/><sheetViews><sheetView workbookViewId="0" showGridLines="0">` +
    `<pane${frozen ? ` xSplit="${frozen}"` : ""} ySplit="1" topLeftCell="${firstScrollableCell}" activePane="${pane}" state="frozen"/>` +
    `<selection pane="${pane}" activeCell="${firstScrollableCell}" sqref="${firstScrollableCell}"/></sheetView></sheetViews>` +
    '<sheetFormatPr defaultRowHeight="26"/><cols>' + sheet.columns.map((column, index) =>
      `<col min="${index + 1}" max="${index + 1}" width="${column.width}" customWidth="1"/>`).join("") +
    `</cols><sheetData>${header}${rows}</sheetData>` +
    (sheet.autoFilter === false ? "" : `<autoFilter ref="A1:${lastCell}"/>`) +
    '<pageMargins left="0.3" right="0.3" top="0.5" bottom="0.5" header="0.2" footer="0.2"/></worksheet>';
}

function styles() {
  return xmlDeclaration + `<styleSheet xmlns="${spreadsheetNs}">` +
    '<numFmts count="1"><numFmt numFmtId="164" formatCode="0.00"/></numFmts>' +
    '<fonts count="2"><font><sz val="11"/><color rgb="FF263E39"/><name val="Calibri"/></font>' +
    '<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font></fonts>' +
    '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>' +
    '<fill><patternFill patternType="solid"><fgColor rgb="FF15675C"/><bgColor indexed="64"/></patternFill></fill></fills>' +
    '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="4">' +
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>' +
    '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>' +
    '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="right" vertical="top" wrapText="1"/></xf>' +
    '<xf numFmtId="1" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="right" vertical="top" wrapText="1"/></xf>' +
    '</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';
}

/** 普通 ZIP（无需 ZIP64）；所有条目一次性写出 CRC、压缩长度和中央目录。 */
function zip(files: { name: string; content: string }[], timestamp: Date) {
  if (files.length > 65535) throw new Error("Excel ZIP 文件数量过多。");
  const year = Math.max(1980, Math.min(2107, timestamp.getUTCFullYear()));
  const dosDate = (year - 1980) << 9 | (timestamp.getUTCMonth() + 1) << 5 | timestamp.getUTCDate();
  const dosTime = timestamp.getUTCHours() << 11 | timestamp.getUTCMinutes() << 5 | Math.floor(timestamp.getUTCSeconds() / 2);
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, "utf8");
    const content = Buffer.from(file.content, "utf8");
    const compressed = deflateRawSync(content, { level: 6 });
    const checksum = crc32(content);
    if (name.length > 65535 || content.length > 0xffffffff || compressed.length > 0xffffffff || offset > 0xffffffff) {
      throw new Error("Excel 文件超过普通 ZIP 格式上限。");
    }
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    localParts.push(local, name, compressed);
    centralParts.push(central, name);
    offset += local.length + name.length + compressed.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  if (offset > 0xffffffff || centralDirectory.length > 0xffffffff) throw new Error("Excel 文件超过普通 ZIP 格式上限。");
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

/** 只生成必要的标准 OOXML 部件；无公式、宏、外部链接或运行时第三方依赖。 */
export function createXlsxWorkbook(sheets: XlsxSheet[], exportedAt = new Date().toISOString()): Buffer {
  const timestamp = new Date(exportedAt);
  if (!Number.isFinite(timestamp.getTime())) throw new Error("Excel 导出时间不合法。");
  if (!sheets.length) throw new Error("Excel 至少需要一张工作表。");
  const names = new Set<string>();
  for (const sheet of sheets) {
    if (!sheet.name || sheet.name.length > 31 || /[\[\]:*?/\\\u0000-\u001f]/.test(sheet.name) || /^'|'$/.test(sheet.name) || names.has(sheet.name.toLowerCase())) {
      throw new Error("Excel 工作表名称无效或重复。");
    }
    names.add(sheet.name.toLowerCase());
  }
  const files = [
    { name: "[Content_Types].xml", content: xmlDeclaration + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
      '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
      sheets.map((_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("") + '</Types>' },
    { name: "_rels/.rels", content: xmlDeclaration + `<Relationships xmlns="${packageRelationshipNs}">` +
      `<Relationship Id="rId1" Type="${relationshipNs}/officeDocument" Target="xl/workbook.xml"/>` +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
      `<Relationship Id="rId3" Type="${relationshipNs}/extended-properties" Target="docProps/app.xml"/></Relationships>` },
    { name: "docProps/core.xml", content: xmlDeclaration + '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
      '<dc:creator>每日票价</dc:creator><cp:lastModifiedBy>每日票价</cp:lastModifiedBy>' +
      `<dcterms:created xsi:type="dcterms:W3CDTF">${timestamp.toISOString()}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${timestamp.toISOString()}</dcterms:modified></cp:coreProperties>` },
    { name: "docProps/app.xml", content: xmlDeclaration + '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">' +
      '<Application>每日票价</Application><HeadingPairs><vt:vector size="2" baseType="variant"><vt:variant><vt:lpstr>Worksheets</vt:lpstr></vt:variant><vt:variant>' +
      `<vt:i4>${sheets.length}</vt:i4></vt:variant></vt:vector></HeadingPairs><TitlesOfParts><vt:vector size="${sheets.length}" baseType="lpstr">` +
      sheets.map(sheet => `<vt:lpstr>${escapeXml(sheet.name)}</vt:lpstr>`).join("") + '</vt:vector></TitlesOfParts></Properties>' },
    { name: "xl/workbook.xml", content: xmlDeclaration + `<workbook xmlns="${spreadsheetNs}" xmlns:r="${relationshipNs}"><bookViews><workbookView/></bookViews><sheets>` +
      sheets.map((sheet, index) => `<sheet name="${escapeXml(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join("") + '</sheets></workbook>' },
    { name: "xl/_rels/workbook.xml.rels", content: xmlDeclaration + `<Relationships xmlns="${packageRelationshipNs}">` +
      sheets.map((_, index) => `<Relationship Id="rId${index + 1}" Type="${relationshipNs}/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join("") +
      `<Relationship Id="rId${sheets.length + 1}" Type="${relationshipNs}/styles" Target="styles.xml"/></Relationships>` },
    { name: "xl/styles.xml", content: styles() },
    ...sheets.map((sheet, index) => ({ name: `xl/worksheets/sheet${index + 1}.xml`, content: worksheet(sheet) })),
  ];
  return zip(files, timestamp);
}
