/** CSV and normalized order rows for client-side label batch imports. */
export interface LabelOrderRow {
  outlet: string;
  sku: string;
  qty: number;
  /** Normalized spreadsheet column name -> cell value, used to fill template params. */
  values: Record<string, string>;
  sourceRow: number;
}

export const MAX_BATCH_LABELS = 240;

export function parseCsv(text: string): string[][] {
  const input = text.replace(/^\uFEFF/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let value = '';
  let quoted = false;

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i]!;
    if (quoted) {
      if (char === '"' && input[i + 1] === '"') {
        value += '"';
        i += 1;
      } else if (char === '"') quoted = false;
      else value += char;
    } else if (char === '"' && value.length === 0) quoted = true;
    else if (char === ',') {
      row.push(value);
      value = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && input[i + 1] === '\n') i += 1;
      row.push(value);
      rows.push(row);
      row = [];
      value = '';
    } else value += char;
  }

  if (quoted) throw new Error('CSV contains an unclosed quoted field.');
  if (value.length || row.length) {
    row.push(value);
    rows.push(row);
  }
  return rows;
}

export function normalizeColumn(value: string): string {
  return value
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '');
}

const aliases: Record<string, string> = {
  outlet: 'outlet',
  outletname: 'outlet',
  branch: 'outlet',
  branchname: 'outlet',
  location: 'outlet',
  sku: 'sku',
  itemcode: 'sku',
  productcode: 'sku',
  productsku: 'sku',
  qty: 'qty',
  quantity: 'qty',
  labelqty: 'qty',
  printqty: 'qty',
};

export function parseOrderRows(rows: string[][], maxLabels = MAX_BATCH_LABELS): LabelOrderRow[] {
  if (rows.length < 2)
    throw new Error('Import file needs a header row and at least one order row.');
  const headers = rows[0]!.map((v) => v.trim());
  const columns = headers.map(normalizeColumn);
  const indexOf = (key: string) => columns.findIndex((header) => aliases[header] === key);
  const outletIndex = indexOf('outlet');
  const skuIndex = indexOf('sku');
  const qtyIndex = indexOf('qty');
  if (outletIndex < 0 || skuIndex < 0 || qtyIndex < 0)
    throw new Error('Required columns: Outlet, SKU, and Qty.');

  const parsed: LabelOrderRow[] = [];
  let total = 0;
  for (let i = 1; i < rows.length; i += 1) {
    const cells = rows[i] ?? [];
    if (cells.every((cell) => !cell.trim())) continue;
    const outlet = cells[outletIndex]?.trim() ?? '';
    const sku = cells[skuIndex]?.trim() ?? '';
    const qtyRaw = cells[qtyIndex]?.trim() ?? '';
    const qty = Number(qtyRaw);
    const sourceRow = i + 1;
    if (!outlet || !sku) throw new Error(`Row ${sourceRow}: Outlet and SKU cannot be empty.`);
    if (!Number.isInteger(qty) || qty < 1)
      throw new Error(`Row ${sourceRow}: Qty must be a positive whole number.`);

    const values: Record<string, string> = {};
    headers.forEach((header, columnIndex) => {
      const value = cells[columnIndex]?.trim() ?? '';
      const normalized = normalizeColumn(header);
      if (normalized) values[aliases[normalized] ?? normalized] = value;
    });
    values.outlet = outlet;
    values.sku = sku;
    values.qty = String(qty);
    parsed.push({ outlet, sku, qty, values, sourceRow });
    total += qty;
    if (total > maxLabels)
      throw new Error(`This batch contains ${total} labels. The limit is ${maxLabels} per batch.`);
  }
  if (!parsed.length) throw new Error('No non-empty order rows were found.');
  return parsed;
}
