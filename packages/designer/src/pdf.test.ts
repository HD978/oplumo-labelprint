import { describe, expect, it } from 'vitest';
import { buildImagePdf } from './lib/pdf';

describe('batch PDF writer', () => {
  it('writes one correctly referenced image object per rendered label page', () => {
    const pdf = new TextDecoder().decode(
      buildImagePdf({
        jpeg: new Uint8Array([1]),
        imageWidth: 320,
        imageHeight: 160,
        pageWidthMm: 40,
        pageHeightMm: 20,
        pages: [
          { jpeg: new Uint8Array([1]), imageWidth: 320, imageHeight: 160 },
          { jpeg: new Uint8Array([2]), imageWidth: 320, imageHeight: 160 },
        ],
      }),
    );

    expect(pdf).toContain('/Count 2');
    expect(pdf).toContain('/Kids [6 0 R 8 0 R]');
    expect(pdf).toContain('/XObject << /Im0 3 0 R >>');
    expect(pdf).toContain('/XObject << /Im0 4 0 R >>');
    expect(pdf.match(/\/Subtype \/Image/g)).toHaveLength(2);
  });

  it('preserves the existing single-label copies workflow', () => {
    const pdf = new TextDecoder().decode(
      buildImagePdf({
        jpeg: new Uint8Array([1]),
        imageWidth: 320,
        imageHeight: 160,
        pageWidthMm: 40,
        pageHeightMm: 20,
        copies: 3,
      }),
    );
    expect(pdf).toContain('/Count 3');
  });
});
