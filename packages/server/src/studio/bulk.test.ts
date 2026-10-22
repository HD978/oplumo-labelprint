import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';
import type { BulkRequest, TemplateDoc } from '@labelprint/shared';
import ExcelJS from 'exceljs';
import Fastify from 'fastify';
import JSZip from 'jszip';
import { PDFDocument } from 'pdf-lib';
import { afterEach, describe, expect, it } from 'vitest';
import { BulkService, bulkPlan } from './bulk.js';
import { readExcel } from './excel.js';
import { registerStudio } from './routes.js';
import { StudioService } from './service.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
function template(id = 't1', width = 40, height = 20): TemplateDoc {
  return {
    id,
    name: 'Test',
    version: 1,
    media: { widthMm: width, heightMm: height, type: 'gap', gapMm: 2 },
    params: [],
    defaults: {},
    elements: [
      {
        id: 'txt',
        type: 'text',
        x: 2,
        y: 2,
        w: width - 4,
        h: 8,
        text: '{{name}}',
        fontSizePt: 12,
        fontWeight: 'normal',
        fontFamily: 'DejaVu Sans',
        align: 'left',
        valign: 'middle',
        color: '#000000',
      },
    ],
    background: '#ffffff',
  };
}
function input(): BulkRequest {
  return {
    templateId: 't1',
    templateColumn: '',
    quantityColumn: 'Copies',
    bindings: { name: { column: 'Product' } },
    rows: [
      { file: 'a.xlsx', sheet: 'Labels', row: 2, cells: { Product: 'SAMPLE ONE', Copies: '2' } },
      { file: 'b.xlsx', sheet: 'Labels', row: 2, cells: { Product: 'SAMPLE TWO', Copies: '3' } },
    ],
  };
}
async function setup() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oplumo-bulk-'));
  dirs.push(dir);
  const templates = [template(), template('t2', 70, 50)];
  const service = new BulkService(dir, async () => structuredClone(templates));
  return { dir, templates, service };
}
// These workbooks are parser test fixtures only, not user-facing spreadsheet deliverables.
async function workbook(configure: (w: ExcelJS.Workbook) => void) {
  const w = new ExcelJS.Workbook();
  configure(w);
  return Buffer.from(await w.xlsx.writeBuffer());
}

describe('Excel upload parsing', () => {
  it('reads multiple sheets, Unicode, dates, text IDs and zero-padded numeric IDs', async () => {
    const data = await workbook((w) => {
      const s = w.addWorksheet('Labels');
      s.addRow(['Product', 'Code', 'Date', 'Qty']);
      s.addRow(['猴头菇', '000123', new Date('2026-10-23T00:00:00Z'), 3]);
      s.addRow(['Bread', 12, null, 2]);
      s.getCell('B3').numFmt = '000000';
      w.addWorksheet('Other').addRows([['Product'], ['Tea']]);
      const h = w.addWorksheet('Hidden');
      h.state = 'hidden';
      h.addRows([['Product'], ['Do not import']]);
    });
    const result = await readExcel('orders.xlsx', data);
    expect(result.sheets).toHaveLength(2);
    expect(result.sheets[0].rows[0].cells).toEqual({
      Product: '猴头菇',
      Code: '000123',
      Date: '2026-10-23',
      Qty: '3',
    });
    expect(result.sheets[0].rows[1].cells.Code).toBe('000012');
    expect(result.sheets[0].rows[0].row).toBe(2);
  });
  it('uses cached formula results and blocks missing results and Excel errors', async () => {
    const cached = await workbook((w) => {
      w.addWorksheet('Labels').addRows([['Qty'], [{ formula: '1+2', result: 3 }]]);
    });
    expect((await readExcel('a.xlsx', cached)).sheets[0].rows[0].cells.Qty).toBe('3');
    for (const value of [{ formula: '1+2' }, { error: '#VALUE!' }]) {
      const data = await workbook((w) => {
        w.addWorksheet('Labels').addRows([['Qty'], [value]]);
      });
      expect((await readExcel('a.xlsx', data)).sheets[0].error).toBeTruthy();
    }
  });
  it('rejects duplicate headers, merged tables and oversized sheets without silently dropping rows', async () => {
    const duplicate = await workbook((w) => {
      w.addWorksheet('A').addRows([
        ['SKU', 'SKU'],
        ['a', 'b'],
      ]);
    });
    expect((await readExcel('a.xlsx', duplicate)).sheets[0].error).toContain('headers');
    const merged = await workbook((w) => {
      const s = w.addWorksheet('A');
      s.addRows([
        ['Name', 'Qty'],
        ['x', 1],
      ]);
      s.mergeCells('A2:B2');
    });
    expect((await readExcel('a.xlsx', merged)).sheets[0].error).toContain('Merged');
    const large = await workbook((w) => {
      const s = w.addWorksheet('A');
      s.addRow(['Name']);
      for (let i = 0; i < 501; i++) s.addRow(['x']);
    });
    expect((await readExcel('a.xlsx', large)).sheets[0].error).toContain('500');
  });
  it('rejects legacy XLS, invalid archives and oversized compressed uploads', async () => {
    await expect(readExcel('a.xls', Buffer.from('x'))).rejects.toThrow('.xlsx');
    await expect(readExcel('a.xlsx', Buffer.from('garbage'))).rejects.toThrow('archive');
    await expect(readExcel('a.xlsx', Buffer.alloc(2 * 1024 * 1024 + 1))).rejects.toThrow('2 MiB');
  });
  it('bounds actual decompression even when directory sizes lie', async () => {
    const compressed = deflateRawSync(Buffer.alloc(17 * 1024 * 1024));
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    const center = Buffer.alloc(46);
    center.writeUInt32LE(0x02014b50);
    center.writeUInt16LE(8, 10);
    center.writeUInt32LE(compressed.length, 20);
    center.writeUInt32LE(1, 24);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50);
    end.writeUInt16LE(1, 10);
    end.writeUInt32LE(local.length + compressed.length, 16);
    await expect(
      readExcel('bomb.xlsx', Buffer.concat([local, compressed, center, end])),
    ).rejects.toThrow('archive');
  });
});

describe('bulk mapping and PDF pipeline', () => {
  it('maps columns, fixed values, copies and optional per-row templates', () => {
    const data = input();
    data.templateColumn = 'Template';
    data.rows[0].cells.Template = 't1';
    data.rows[1].cells.Template = 't2';
    const result = bulkPlan(data, [template(), template('t2', 70, 50)]);
    expect(result.labels).toBe(5);
    expect(result.stock).toEqual([
      { widthMm: 40, heightMm: 20, labels: 2 },
      { widthMm: 70, heightMm: 50, labels: 3 },
    ]);
    data.bindings.name = { value: 'Fixed' };
    expect(bulkPlan(data, [template(), template('t2', 70, 50)]).plan[0].values.name).toBe('Fixed');
    data.quantityColumn = '';
    expect(bulkPlan(data, [template(), template('t2', 70, 50)]).labels).toBe(2);
  });
  it('blocks missing columns, blank fields, unresolved templates, zero/decimal counts and totals above cap', () => {
    const data = input();
    for (const quantity of ['', '0', '-1', '1.5', '2ctn', '6000']) {
      data.rows[0].cells.Copies = quantity;
      expect(() => bulkPlan(data, [template()])).toThrow();
    }
    data.rows[0].cells.Copies = '4999';
    expect(() => bulkPlan(data, [template()])).toThrow('5000');
    data.rows[0].cells.Copies = '2';
    data.bindings.name = { column: 'Missing' };
    expect(() => bulkPlan(data, [template()])).toThrow('column missing');
    data.bindings.name = { value: '' };
    expect(() => bulkPlan(data, [template()])).toThrow('empty');
    data.bindings.name = { value: '{{bad}}' };
    expect(() => bulkPlan(data, [template()])).toThrow('tokens');
    data.templateId = 'missing';
    expect(() => bulkPlan(data, [template()])).toThrow('template not found');
  });
  it('generates exact page counts/dimensions, reuses identical requests and survives restart', async () => {
    const { service, templates, dir } = await setup();
    const data = input();
    data.templateColumn = 'Template';
    data.rows[0].cells.Template = 't1';
    data.rows[1].cells.Template = 't2';
    const preview = await service.preview(data);
    expect(preview.previewPng).toMatch(/^data:image\/png;base64,/);
    const [first, second] = await Promise.all([
      service.generate(data, preview.fingerprint),
      service.generate(data, preview.fingerprint),
    ]);
    expect(Buffer.from(first.data).equals(Buffer.from(second.data))).toBe(true);
    expect(first.record.format).toBe('zip');
    const zip = await JSZip.loadAsync(first.data);
    const smallBytes = await zip.file('labels-40x20mm.pdf')!.async('uint8array');
    const largeBytes = await zip.file('labels-70x50mm.pdf')!.async('uint8array');
    const small = await PDFDocument.load(smallBytes),
      large = await PDFDocument.load(largeBytes);
    expect(small.getPageCount()).toBe(2);
    expect(large.getPageCount()).toBe(3);
    expect(small.getPage(0).getWidth()).toBeCloseTo((40 * 72) / 25.4, 5);
    expect(small.getPage(1).getHeight()).toBeCloseTo((20 * 72) / 25.4, 5);
    expect(large.getPage(0).getWidth()).toBeCloseTo((70 * 72) / 25.4, 5);
    expect(large.getPage(2).getHeight()).toBeCloseTo((50 * 72) / 25.4, 5);
    const restarted = new BulkService(dir, async () => templates);
    expect(await restarted.history()).toHaveLength(1);
    expect((await restarted.generate(data, preview.fingerprint)).record.createdAt).toBe(
      first.record.createdAt,
    );
    const manifest = JSON.parse(
      await readFile(path.join(dir, `${preview.fingerprint}.json`), 'utf8'),
    );
    expect(manifest.snapshot[0].values.name).toBe('SAMPLE ONE');
    expect(manifest.record.status).toBe('pdf-generated');
    // Temporary QA proof for Poppler visual inspection, never published as a customer label.
    await writeFile('/tmp/oplumo-bulk-proof.pdf', smallBytes);
    await writeFile('/tmp/oplumo-bulk-proof-large.pdf', largeBytes);
  });
  it('exports a 100x150 mm stock PDF without an A4 carrier or crop margins', async () => {
    const { service, templates } = await setup();
    templates[0] = template('t1', 100, 150);
    const data = input();
    data.rows = data.rows.slice(0, 1);
    data.rows[0].cells.Copies = '1';
    const p = await service.preview(data);
    const generated = await service.generate(data, p.fingerprint);
    expect(generated.record.format).toBe('pdf');
    const pdf = await PDFDocument.load(generated.data);
    expect(pdf.getPageCount()).toBe(1);
    expect(pdf.getPage(0).getWidth()).toBeCloseTo((100 * 72) / 25.4, 5);
    expect(pdf.getPage(0).getHeight()).toBeCloseTo((150 * 72) / 25.4, 5);
  });
  it('requires a new preview after source rows, counts, bindings or template artwork change', async () => {
    const { service, templates } = await setup();
    const data = input();
    const p = await service.preview(data);
    data.rows[1].cells.Product = 'Changed';
    await expect(service.generate(data, p.fingerprint)).rejects.toThrow('preview again');
    data.rows[1].cells.Product = 'SAMPLE TWO';
    templates[0].name = 'Artwork edited';
    await expect(service.generate(data, p.fingerprint)).rejects.toThrow('preview again');
    expect(await service.history()).toHaveLength(0);
  });
  it('does not release PDFs when a later row has an invalid barcode', async () => {
    const { service, templates } = await setup();
    templates[0].elements = [
      {
        id: 'b',
        type: 'barcode',
        value: '{{name}}',
        symbology: 'ean13',
        x: 2,
        y: 2,
        w: 30,
        h: 12,
        showText: true,
      },
    ];
    const data = input();
    data.rows[0].cells.Product = '5901234123457';
    data.rows[1].cells.Product = 'INVALID';
    const p = await service.preview(data);
    await expect(service.generate(data, p.fingerprint)).rejects.toThrow('barcode');
    expect(await service.history()).toHaveLength(0);
  });
  it('validates raw XLSX through HTTP and gates PDF export on a matching preview', async () => {
    const { service, dir } = await setup();
    const app = Fastify();
    await registerStudio(
      app,
      new StudioService(path.join(dir, 'workspace.json'), async () => []),
      service,
    );
    try {
      const bytes = await workbook((w) => {
        w.addWorksheet('A').addRows([
          ['Product', 'Copies'],
          ['Bread', 2],
        ]);
      });
      const parsed = await app.inject({
        method: 'POST',
        url: '/api/studio/excel/read?name=orders.xlsx',
        headers: { 'content-type': 'application/octet-stream' },
        payload: bytes,
      });
      expect(parsed.statusCode).toBe(200);
      expect(parsed.json().sheets[0].rows[0].cells.Product).toBe('Bread');
      const p = await app.inject({
        method: 'POST',
        url: '/api/studio/bulk/preview',
        payload: input(),
      });
      expect(p.statusCode).toBe(200);
      const pdf = await app.inject({
        method: 'POST',
        url: '/api/studio/bulk/pdf',
        payload: { input: input(), fingerprint: p.json().fingerprint },
      });
      expect(pdf.headers['content-type']).toContain('application/pdf');
      expect(pdf.rawPayload.subarray(0, 4).toString()).toBe('%PDF');
      const stale = await app.inject({
        method: 'POST',
        url: '/api/studio/bulk/pdf',
        payload: { input: input(), fingerprint: 'wrong' },
      });
      expect(stale.statusCode).toBe(409);
      const malformed = await app.inject({
        method: 'POST',
        url: '/api/studio/bulk/preview',
        headers: { 'content-type': 'application/json' },
        payload: '{',
      });
      expect(malformed.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});
