import {
  defaultMediaProfiles,
  emptyTemplate,
  makeElement,
  type TemplateDoc,
} from '@labelprint/shared';

/** Draft starter set based on the 12 filenames visible in the supplied BarTender screenshot. */
const products = [
  ['BELGIUM-CHOCOLATE-BUN', 'BELGIUM CHOCOLATE BUN'],
  ['BUTTERY-MINI-CROISSANT', 'BUTTERY MINI CROISSANT'],
  ['CALIFORNIA-RAISIN-BUN', 'CALIFORNIA RAISIN BUN'],
  ['CHEDDAR-CHEESE-BUN', 'CHEDDAR CHEESE BUN'],
  ['DOUBLE-CHEESE-TOAST', 'DOUBLE CHEESE TOAST'],
  ['HOKKAIDO-WHITE-TOAST', 'HOKKAIDO WHITE TOAST'],
  ['MARBLE-CHOCOLATE-TOAST', 'MARBLE CHOCOLATE TOAST'],
  ['NISHIO-MATCHA-RED-BEAN-TOAST', 'NISHIO MATCHA RED BEAN TOAST'],
  ['ORIGINAL-CLASSIC-TOAST', 'ORIGINAL CLASSIC TOAST'],
  ['PURPLE-RICE-WHOLEGRAIN-TOAST', 'PURPLE RICE WHOLEGRAIN TOAST'],
  ['WHOLEMEAL-BUN', 'WHOLEMEAL BUN'],
  ['WHOLEMEAL-TOAST', 'WHOLEMEAL TOAST'],
] as const;

export function makeVerronaDraftTemplates(): TemplateDoc[] {
  const media = defaultMediaProfiles()[0]!;
  return products.map(([slug, product]) => {
    const doc = emptyTemplate(
      `verrona-40x20-${slug.toLowerCase()}`,
      `DRAFT · ${product} · 40×20`,
      media,
    );
    doc.params = [
      { key: 'best_before', label: 'Best before', type: 'date' },
      { key: 'ingredients', label: 'Ingredients', multiline: true },
      { key: 'barcode', label: 'Barcode', type: 'text' },
    ];
    const title = makeElement('text');
    if (title.type === 'text')
      Object.assign(title, {
        id: `${doc.id}-product`,
        name: 'Product name',
        x: 1.5,
        y: 1.5,
        w: 37,
        h: 8,
        text: product,
        fontFamily: 'Arial',
        fontSizePt: 8,
        fontWeight: 'bold',
        align: 'center',
        valign: 'middle',
      });
    const dateLabel = makeElement('text');
    if (dateLabel.type === 'text')
      Object.assign(dateLabel, {
        id: `${doc.id}-date-label`,
        name: 'Best before label',
        x: 1.5,
        y: 12,
        w: 18,
        h: 5,
        text: 'BEST BEFORE:',
        fontFamily: 'Arial',
        fontSizePt: 5,
        fontWeight: 'normal',
        align: 'left',
        valign: 'middle',
      });
    const dateValue = makeElement('text');
    if (dateValue.type === 'text')
      Object.assign(dateValue, {
        id: `${doc.id}-date-value`,
        name: 'Best before date',
        x: 20,
        y: 12,
        w: 18.5,
        h: 5,
        text: '{{best_before}}',
        fontFamily: 'Arial',
        fontSizePt: 5,
        fontWeight: 'normal',
        align: 'right',
        valign: 'middle',
      });
    doc.elements = [title, dateLabel, dateValue];
    doc.defaults = { best_before: '', ingredients: '', barcode: '' };
    return doc;
  });
}
