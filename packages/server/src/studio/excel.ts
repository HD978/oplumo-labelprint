import { inflateRawSync } from 'node:zlib';
import type { ExcelFile, ExcelRow } from '@labelprint/shared';
import ExcelJS from 'exceljs';
import { StudioError } from './service.js';

/** Bound actual decompressed ZIP entries before ExcelJS materializes the workbook. */
function checkZip(data: Buffer) {
  let end = -1;
  for (let n = data.length - 22; n >= Math.max(0, data.length - 65557); n--) {
    if (data.readUInt32LE(n) === 0x06054b50 && n + 22 + data.readUInt16LE(n + 20) === data.length) {
      end = n;
      break;
    }
  }
  if (end < 0) throw new StudioError('Invalid XLSX archive');
  const count = data.readUInt16LE(end + 10);
  let cursor = data.readUInt32LE(end + 16);
  let expanded = 0;
  if (
    data.readUInt16LE(end + 4) !== 0 ||
    data.readUInt16LE(end + 6) !== 0 ||
    !count ||
    count > 1000 ||
    cursor >= end
  )
    throw new StudioError('Unsupported or oversized XLSX archive');
  for (let n = 0; n < count; n++) {
    if (cursor + 46 > end || data.readUInt32LE(cursor) !== 0x02014b50)
      throw new StudioError('Invalid XLSX directory');
    const flags = data.readUInt16LE(cursor + 8),
      method = data.readUInt16LE(cursor + 10),
      size = data.readUInt32LE(cursor + 20),
      declared = data.readUInt32LE(cursor + 24),
      local = data.readUInt32LE(cursor + 42);
    if (
      (flags & 1) !== 0 ||
      ![0, 8].includes(method) ||
      declared > 16 * 1024 * 1024 ||
      local + 30 >= cursor ||
      data.readUInt32LE(local) !== 0x04034b50
    )
      throw new StudioError('Unsupported or oversized XLSX entry');
    const start = local + 30 + data.readUInt16LE(local + 26) + data.readUInt16LE(local + 28);
    if (start + size > data.length || expanded + declared > 32 * 1024 * 1024)
      throw new StudioError('Expanded XLSX exceeds 32 MiB');
    const bytes = data.subarray(start, start + size);
    const output =
      method === 8 ? inflateRawSync(bytes, { maxOutputLength: 16 * 1024 * 1024 }) : bytes;
    expanded += output.length;
    if (output.length !== declared || expanded > 32 * 1024 * 1024)
      throw new StudioError('Invalid XLSX entry size');
    cursor +=
      46 +
      data.readUInt16LE(cursor + 28) +
      data.readUInt16LE(cursor + 30) +
      data.readUInt16LE(cursor + 32);
  }
}
function cellText(cell: ExcelJS.Cell): string {
  if (cell.isMerged) throw new StudioError('Merged cells are not supported; use a flat table');
  let value = cell.value;
  if (value && typeof value === 'object' && ('formula' in value || 'sharedFormula' in value)) {
    const result = (value as ExcelJS.CellFormulaValue).result;
    if (result === undefined)
      throw new StudioError('Formula has no cached result; recalculate and save in Excel');
    value = result;
  }
  if (value && typeof value === 'object' && 'error' in value)
    throw new StudioError(`Excel error: ${value.error}`);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  let text = '';
  if (value && typeof value === 'object' && 'richText' in value)
    text = value.richText.map((v) => v.text).join('');
  else if (value && typeof value === 'object' && 'hyperlink' in value) text = value.text;
  else if (value === null || value === undefined) text = '';
  else if (typeof value === 'number') {
    if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER)
      throw new StudioError('Numeric identifier exceeds Excel precision; store it as text');
    text =
      Number.isInteger(value) && /^0+$/.test(cell.numFmt ?? '')
        ? String(value).padStart(cell.numFmt.length, '0')
        : String(value);
  } else if (typeof value === 'object') throw new StudioError('Unsupported Excel cell value');
  else text = String(value);
  if (text.length > 1000) throw new StudioError('Cell text exceeds 1000 characters');
  return text;
}
export async function readExcel(name: string, data: Buffer): Promise<ExcelFile> {
  if (typeof name !== 'string' || !name || name.length > 160 || !/\.xlsx$/i.test(name))
    throw new StudioError('Only .xlsx workbooks are supported');
  if (!Buffer.isBuffer(data) || data.length > 2 * 1024 * 1024 || !data.length)
    throw new StudioError('Each workbook must be 2 MiB or smaller');
  try {
    checkZip(data);
  } catch (e) {
    if (e instanceof StudioError) throw e;
    throw new StudioError('Invalid or oversized XLSX archive');
  }
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(data as never);
  } catch {
    throw new StudioError('Cannot read XLSX workbook');
  }
  const sheets = workbook.worksheets.filter((s) => s.state === 'visible');
  if (!sheets.length || sheets.length > 10)
    throw new StudioError('Workbook must have 1–10 visible worksheets');
  let cells = 0;
  return {
    name,
    sheets: sheets.map((sheet) => {
      try {
        if (sheet.rowCount > 501 || sheet.columnCount > 64)
          throw new StudioError('Maximum 500 data rows and 64 columns per sheet');
        const headers: string[] = [];
        for (let c = 1; c <= sheet.columnCount; c++)
          headers.push(cellText(sheet.getCell(1, c)).trim());
        if (!headers.length || headers.some((h) => !h) || new Set(headers).size !== headers.length)
          throw new StudioError('First row must contain unique, nonempty column headers');
        const rows: ExcelRow[] = [];
        for (let r = 2; r <= sheet.rowCount; r++) {
          const values = headers.map((_, c) => cellText(sheet.getCell(r, c + 1)));
          if (values.every((v) => !v.trim())) continue;
          cells += values.length;
          if (cells > 20000) throw new StudioError('Workbook exceeds 20,000 populated table cells');
          rows.push({
            file: name,
            sheet: sheet.name,
            row: r,
            cells: Object.fromEntries(headers.map((h, c) => [h, values[c] ?? ''])),
          });
        }
        return { name: sheet.name, headers, rows };
      } catch (e) {
        return {
          name: sheet.name,
          headers: [],
          rows: [],
          error: e instanceof Error ? e.message : String(e),
        };
      }
    }),
  };
}
