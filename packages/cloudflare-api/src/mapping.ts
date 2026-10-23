import { collectParams, type TemplateDoc } from '@labelprint/shared';
import { fail, integer, type Mapping, type Sku, type Snapshot, text } from './types';
export function isoDate(value: unknown) {
  const s = text(value, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) !== s)
    fail('需要有效生产日期 YYYY-MM-DD');
  return s;
}
export function addDays(date: string, days: number) {
  const d = new Date(`${isoDate(date)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + integer(days, 0, 36500));
  return d.toISOString().slice(0, 10);
}
export function formatDate(date: string, format: string) {
  if (format === 'YYYY-MM-DD') return date;
  if (format === 'DD/MM/YYYY')
    return `${date.slice(8, 10)}/${date.slice(5, 7)}/${date.slice(0, 4)}`;
  fail('日期显示格式不正确');
}
const skuFields = [
  'sku_code',
  'name',
  'name_en',
  'category',
  'spec',
  'barcode',
  'weight',
  'size_code',
];
export function validateMapping(raw: unknown): Mapping {
  const m = raw as Mapping;
  if (!m?.bindings || typeof m.bindings !== 'object' || Array.isArray(m.bindings))
    fail('缺少字段对应');
  integer(m.quantityMultiplier, 1, 100000);
  for (const [k, b] of Object.entries(m.bindings)) {
    text(k, 64);
    if (!b || !['sku', 'batch', 'date', 'fixed'].includes(b.source)) fail('数据来源不正确');
    if (b.source === 'sku' && !skuFields.includes(b.field)) fail('不支持的 SKU 字段');
    if (b.source === 'batch' && !['productionDate', 'batchNo', 'outlet'].includes(b.field))
      fail('批次字段不正确');
    if (
      b.source === 'date' &&
      (!['production', 'expiry'].includes(b.value) ||
        !['DD/MM/YYYY', 'YYYY-MM-DD'].includes(b.format))
    )
      fail('日期规则不正确');
    if (b.source === 'fixed') text(b.value, 1000);
  }
  return m;
}
export function resolveValues(
  doc: TemplateDoc,
  sku: Sku,
  mapping: Mapping,
  batch: { productionDate: string; batchNo: string; outlet: string },
) {
  const values: Record<string, string> = {};
  for (const key of collectParams(doc)) {
    const b = mapping.bindings[key];
    if (!b) fail(`缺少字段对应：${key}`);
    let value = '';
    switch (b.source) {
      case 'sku':
        value = String(sku[b.field as keyof Sku] ?? '');
        break;
      case 'batch':
        value = batch[b.field];
        break;
      case 'fixed':
        value = b.value;
        break;
      case 'date':
        if (b.value === 'expiry' && sku.expiry_days === null)
          fail(`${sku.sku_code} 尚未设定保质期`);
        value = formatDate(
          b.value === 'expiry'
            ? addDays(batch.productionDate, sku.expiry_days!)
            : batch.productionDate,
          b.format,
        );
        break;
    }
    if (!value?.trim()) fail(`${sku.sku_code} 缺少 ${key}`);
    values[key] = value;
  }
  return values;
}
export function validateDoc(doc: TemplateDoc) {
  if (
    !doc ||
    !Array.isArray(doc.elements) ||
    doc.elements.length > 200 ||
    typeof doc.name !== 'string'
  )
    fail('标签设计格式不正确');
  const { widthMm: w, heightMm: h } = doc.media ?? {};
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0 || w > 300 || h > 300)
    fail('标签尺寸须在 0–300 mm');
  if (JSON.stringify(doc).length > 500000) fail('设计过大，请先将图片上传至资料库');
  for (const e of doc.elements) {
    if (
      !Number.isFinite(e.x) ||
      !Number.isFinite(e.y) ||
      !['text', 'image', 'line', 'box', 'barcode', 'qrcode'].includes(e.type)
    )
      fail('标签元素不正确');
    if (
      e.type === 'image' &&
      !/^asset:[\w-]+$/.test(e.src) &&
      !/^data:image\/(png|jpeg);base64,[a-zA-Z0-9+/=]+$/.test(e.src)
    )
      fail('图片须上传至当前工作区，禁止外部图片地址');
  }
  return doc;
}
export function validateSku(input: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  out.sku_code = text(input.sku_code, 128);
  out.name = text(input.name, 200);
  for (const key of ['name_en', 'category', 'spec', 'barcode', 'weight', 'size_code']) {
    const v = input[key] ?? '';
    if (typeof v !== 'string' || v.length > 1000) fail(`${key} 格式不正确`);
    out[key] = v.trim();
  }
  out.expiry_days =
    input.expiry_days === null || input.expiry_days === undefined || input.expiry_days === ''
      ? null
      : integer(Number(input.expiry_days), 0, 36500);
  out.extra = '{}';
  return out;
}
export interface Planned {
  position: number;
  sku_id: string;
  copies: number;
  snapshot: Snapshot;
}
