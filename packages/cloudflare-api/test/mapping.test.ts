import { emptyTemplate, makeElement } from '@labelprint/shared';
import { describe, expect, it } from 'vitest';
import {
  addDays,
  isoDate,
  resolveValues,
  validateDoc,
  validateMapping,
  validateSku,
} from '../src/mapping';
import type { Mapping, Sku } from '../src/types';

const sku = { id: 'sku', sku_code: '0001', name: '产品', expiry_days: 7 } as Sku;
const doc = emptyTemplate('test', 'test', { widthMm: 40, heightMm: 20, type: 'gap' });
doc.elements = [
  { ...makeElement('text'), type: 'text', text: '{{product}} {{expiry}} {{batch}}' } as any,
];
const mapping: Mapping = {
  quantityMultiplier: 1,
  bindings: {
    product: { source: 'sku', field: 'name' },
    expiry: { source: 'date', value: 'expiry', format: 'DD/MM/YYYY' },
    batch: { source: 'batch', field: 'batchNo' },
  },
};
describe('production mapping', () => {
  it('uses provided production date across month/leap boundaries', () => {
    expect(addDays('2028-02-28', 2)).toBe('2028-03-01');
    expect(addDays('2026-12-30', 7)).toBe('2027-01-06');
    expect(
      resolveValues(doc, sku, mapping, {
        productionDate: '2026-10-23',
        batchNo: 'B01',
        outlet: '',
      }),
    ).toEqual({ product: '产品', expiry: '30/10/2026', batch: 'B01' });
  });
  it('blocks missing shelf life, unmapped fields and invalid dates', () => {
    expect(() =>
      resolveValues(doc, { ...sku, expiry_days: null }, mapping, {
        productionDate: '2026-10-23',
        batchNo: 'B',
        outlet: '',
      }),
    ).toThrow('保质期');
    expect(() =>
      resolveValues(
        doc,
        sku,
        { ...mapping, bindings: {} },
        { productionDate: '2026-10-23', batchNo: 'B', outlet: '' },
      ),
    ).toThrow('对应');
    expect(() => isoDate('2026-02-30')).toThrow();
  });
  it('blocks external image sources, malformed mapping and negative shelf life', () => {
    expect(() =>
      validateDoc({
        ...doc,
        elements: [
          { type: 'image', x: 0, y: 0, id: 'bad', src: 'https://private.example/file' },
        ] as any,
      }),
    ).toThrow();
    expect(() => validateMapping({ ...mapping, quantityMultiplier: 0 })).toThrow();
    expect(() => validateSku({ sku_code: '0001', name: 'Test', expiry_days: -1 })).toThrow();
  });
  it('preserves SKU identifiers and zero-day shelf life', () => {
    expect(validateSku({ sku_code: '0001', name: 'Test', expiry_days: 0 }).sku_code).toBe('0001');
    expect(addDays('2026-10-23', 0)).toBe('2026-10-23');
  });
});
