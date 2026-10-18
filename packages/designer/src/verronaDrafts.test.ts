import { describe, expect, it } from 'vitest';
import { makeVerronaDraftTemplates } from './lib/verronaDrafts';

describe('Verrona 40×20 draft set', () => {
  it('creates twelve editable gap-label drafts with the expected fields', () => {
    const drafts = makeVerronaDraftTemplates();
    expect(drafts).toHaveLength(12);
    expect(new Set(drafts.map((doc) => doc.id)).size).toBe(12);
    for (const doc of drafts) {
      expect(doc.media).toMatchObject({ widthMm: 40, heightMm: 20, type: 'gap' });
      expect(doc.params.map((param) => param.key)).toEqual([
        'best_before',
        'ingredients',
        'barcode',
      ]);
      expect(
        doc.elements.some((element) => element.type === 'text' && element.name === 'Product name'),
      ).toBe(true);
    }
  });
});
