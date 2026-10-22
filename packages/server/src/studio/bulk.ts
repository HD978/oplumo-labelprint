import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  type BulkPreview,
  type BulkRecord,
  collectParams,
  type TemplateDoc,
} from '@labelprint/shared';
import JSZip from 'jszip';
import { PDFDocument } from 'pdf-lib';
import { renderTemplate } from '../render/raster.js';
import { StudioError } from './service.js';

interface Planned {
  source: string;
  template: TemplateDoc;
  values: Record<string, string>;
  copies: number;
}
function obj(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new StudioError('Expected an object');
  return v as Record<string, unknown>;
}
function str(v: unknown, max = 1000): string {
  if (typeof v !== 'string' || v.length > max) throw new StudioError('Invalid text');
  return v;
}
export function bulkPlan(value: unknown, templates: TemplateDoc[]) {
  const x = obj(value);
  const templateId = str(x.templateId, 128),
    templateColumn = str(x.templateColumn, 128),
    quantityColumn = str(x.quantityColumn, 128);
  const bindings = obj(x.bindings);
  if (!Array.isArray(x.rows) || !x.rows.length || x.rows.length > 500)
    throw new StudioError('Choose 1–500 data rows');
  const plan: Planned[] = [];
  const stock: BulkPreview['stock'] = [];
  let total = 0;
  for (const raw of x.rows) {
    const r = obj(raw),
      cells = obj(r.cells);
    str(r.file, 160);
    str(r.sheet, 128);
    if (!Number.isInteger(r.row) || Number(r.row) < 2) throw new StudioError('Invalid source row');
    const location = `${r.file} / ${r.sheet} / row ${r.row}`;
    const get = (key: string) => {
      if (!Object.hasOwn(cells, key)) throw new StudioError(`${location}: column missing: ${key}`);
      return str(cells[key]);
    };
    const id = templateColumn ? get(templateColumn).trim() : templateId;
    const template = templates.find((t) => t.id === id);
    if (!template) throw new StudioError(`${location}: template not found: ${id}`);
    const { widthMm, heightMm } = template.media;
    if (
      !Number.isFinite(widthMm) ||
      !Number.isFinite(heightMm) ||
      widthMm < 5 ||
      heightMm < 5 ||
      widthMm > 200 ||
      heightMm > 300
    )
      throw new StudioError(`${location}: supported label dimensions are 5–200 × 5–300 mm`);
    for (const el of template.elements) {
      if (
        !Number.isFinite(el.x) ||
        !Number.isFinite(el.y) ||
        (el.type === 'text' &&
          (!Number.isFinite(el.fontSizePt) ||
            el.fontSizePt <= 0 ||
            !Number.isFinite(el.w) ||
            !Number.isFinite(el.h) ||
            el.w <= 0 ||
            el.h <= 0))
      )
        throw new StudioError(`${location}: invalid template element: ${el.id}`);
    }
    const quantity = quantityColumn ? get(quantityColumn).trim() : '1';
    if (!/^\d+$/.test(quantity))
      throw new StudioError(`${location}: label copies must be a positive whole number`);
    const copies = Number(quantity);
    if (!Number.isSafeInteger(copies) || copies < 1 || copies > 5000)
      throw new StudioError(`${location}: label copies must be 1–5000`);
    total += copies;
    if (total > 5000) throw new StudioError('This export is limited to 5000 labels');
    const values: Record<string, string> = Object.create(null);
    for (const key of collectParams(template)) {
      const binding = Object.hasOwn(bindings, key) ? obj(bindings[key]) : undefined;
      let value = '';
      if (binding && 'column' in binding) value = get(str(binding.column, 128));
      else if (binding && 'value' in binding) value = str(binding.value);
      else throw new StudioError(`${location}: bind placeholder ${key} to a column or fixed value`);
      if (!value.trim()) throw new StudioError(`${location}: empty required field: ${key}`);
      // Prevent second-pass substitution from treating user data as a template expression.
      if (/\{\{|\}\}/.test(value))
        throw new StudioError(`${location}: placeholder tokens cannot appear in cell values`);
      values[key] = value;
    }
    plan.push({ source: location, template: structuredClone(template), values, copies });
    let group = stock.find((s) => s.widthMm === widthMm && s.heightMm === heightMm);
    if (!group) {
      group = { widthMm, heightMm, labels: 0 };
      stock.push(group);
    }
    group.labels += copies;
  }
  // The token covers every template byte, binding and source cell. A later edit requires review again.
  const fingerprint = createHash('sha256')
    .update(
      JSON.stringify({
        renderer: 'bulk-v2-size-groups',
        input: x,
        templates: plan.map((p) => p.template),
      }),
    )
    .digest('hex');
  return { plan, fingerprint, rows: plan.length, labels: total, stock };
}

export class BulkService {
  private chain: Promise<unknown> = Promise.resolve();
  constructor(
    private dir: string,
    private templates: () => Promise<TemplateDoc[]>,
  ) {}
  private async render(line: Planned) {
    try {
      return await renderTemplate(line.template, line.values, 300, true);
    } catch (e) {
      throw new StudioError(`${line.source}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  async preview(input: unknown): Promise<BulkPreview> {
    const p = bulkPlan(input, await this.templates());
    const first = p.plan[0]!;
    const rendered = await this.render(first);
    return {
      fingerprint: p.fingerprint,
      rows: p.rows,
      labels: p.labels,
      stock: p.stock,
      previewPng: `data:image/png;base64,${rendered.png.toString('base64')}`,
    };
  }
  async history(): Promise<BulkRecord[]> {
    let files: string[];
    try {
      files = await fs.readdir(this.dir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw e;
    }
    const records: BulkRecord[] = [];
    for (const f of files.filter((f) => /^[a-f0-9]{64}\.json$/.test(f)))
      records.push(JSON.parse(await fs.readFile(path.join(this.dir, f), 'utf8')).record);
    return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  generate(input: unknown, token: unknown): Promise<{ data: Uint8Array; record: BulkRecord }> {
    const run = this.chain.then(async () => {
      const p = bulkPlan(input, await this.templates());
      if (token !== p.fingerprint)
        throw new StudioError('Data or template changed; preview again before export', 409);
      await fs.mkdir(this.dir, { recursive: true });
      const file = path.join(this.dir, p.fingerprint);
      try {
        const manifest = JSON.parse(await fs.readFile(`${file}.json`, 'utf8'));
        return {
          data: await fs.readFile(`${file}.${manifest.record.format}`),
          record: manifest.record as BulkRecord,
        };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
      let renderedBytes = 0;
      let renderedPixels = 0;
      const outputs: { name: string; data: Uint8Array }[] = [];
      for (const stock of p.stock) {
        const pdf = await PDFDocument.create();
        const rendered = new Map<string, Awaited<ReturnType<typeof pdf.embedPng>>>();
        for (const line of p.plan.filter(
          (line) =>
            line.template.media.widthMm === stock.widthMm &&
            line.template.media.heightMm === stock.heightMm,
        )) {
          const cacheKey = JSON.stringify([line.template.id, line.values]);
          let image = rendered.get(cacheKey);
          if (!image) {
            const raster = await this.render(line);
            renderedPixels += raster.width * raster.height;
            if (renderedPixels > 64_000_000)
              throw new StudioError('Raster budget exceeds 64 million pixels; split the batch');
            renderedBytes += raster.png.length;
            if (renderedBytes > 32 * 1024 * 1024)
              throw new StudioError('Rendered images exceed 32 MiB; split the batch');
            image = await pdf.embedPng(raster.png);
            rendered.set(cacheKey, image);
          }
          const width = (line.template.media.widthMm * 72) / 25.4,
            height = (line.template.media.heightMm * 72) / 25.4;
          for (let n = 0; n < line.copies; n++) {
            const page = pdf.addPage([width, height]);
            page.drawImage(image, { x: 0, y: 0, width, height });
          }
        }
        pdf.setTitle(`OPLUMO ${stock.widthMm}x${stock.heightMm} mm labels`);
        pdf.setSubject(
          'One label per page. Print at actual size / 100%. Generated does not mean printed.',
        );
        outputs.push({
          name: `labels-${stock.widthMm}x${stock.heightMm}mm.pdf`,
          data: await pdf.save(),
        });
      }
      const format = outputs.length === 1 ? 'pdf' : 'zip';
      let data = outputs[0]!.data;
      if (format === 'zip') {
        const zip = new JSZip();
        for (const output of outputs) zip.file(output.name, output.data);
        data = await zip.generateAsync({ type: 'uint8array', compression: 'STORE' });
      }
      if (data.length > 64 * 1024 * 1024)
        throw new StudioError('Export exceeds 64 MiB; split the batch');
      const record: BulkRecord = {
        id: p.fingerprint,
        createdAt: new Date().toISOString(),
        rows: p.rows,
        labels: p.labels,
        stock: p.stock,
        status: 'pdf-generated',
        format,
        files: outputs.map((o) => o.name),
      };
      await fs.writeFile(`${file}.${format}.tmp`, data);
      await fs.rename(`${file}.${format}.tmp`, `${file}.${format}`);
      await fs.writeFile(`${file}.json.tmp`, JSON.stringify({ record, input, snapshot: p.plan }));
      await fs.rename(`${file}.json.tmp`, `${file}.json`);
      return { data, record };
    });
    this.chain = run.catch(() => undefined);
    return run;
  }
}
