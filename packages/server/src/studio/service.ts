import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type {
  StudioBatch,
  StudioOrder,
  StudioPlan,
  StudioSettings,
  StudioWorkspace,
  TemplateDoc,
} from '@labelprint/shared';

export class StudioError extends Error {
  constructor(
    message: string,
    public statusCode = 400,
  ) {
    super(message);
  }
}
const fail = (message: string): never => {
  throw new StudioError(message);
};
const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : fail('Expected an object');
const text = (v: unknown): string =>
  typeof v === 'string' &&
  v.trim().length > 0 &&
  v.length <= 128 &&
  ![...v].some((c) => c.charCodeAt(0) < 32)
    ? v.trim()
    : fail('Expected nonempty text (maximum 128 characters)');
const integer = (v: unknown, max = 100000): number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v > 0 && v <= max
    ? v
    : fail('Expected a bounded positive integer');
const list = (v: unknown, max: number): unknown[] =>
  Array.isArray(v) && v.length <= max ? v : fail(`Expected array (maximum ${max} entries)`);
export function date(v: unknown): string {
  const s = text(v);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(s) ||
    !Number.isFinite(Date.parse(s)) ||
    new Date(s).toISOString().slice(0, 10) !== s
  )
    fail('Invalid ISO calendar date');
  return s;
}
function unique(values: string[]) {
  if (new Set(values).size !== values.length) fail('Duplicate identifier');
}
export function parseSettings(v: unknown): StudioSettings {
  const x = object(v);
  const outlets = list(x.outlets, 200).map(text).sort();
  unique(outlets);
  const rules = list(x.rules, 2000).map((v) => {
    const r = object(v);
    return {
      sku: text(r.sku),
      unit: text(r.unit),
      labelsPerUnit: integer(r.labelsPerUnit, 10000),
      templateId: text(r.templateId),
    };
  });
  unique(rules.map((r) => JSON.stringify([r.sku, r.unit])));
  return {
    outlets,
    rules: rules.sort((a, b) =>
      JSON.stringify([a.sku, a.unit]).localeCompare(JSON.stringify([b.sku, b.unit])),
    ),
  };
}
export function parseOrders(v: unknown): StudioOrder[] {
  const orders = list(v, 1000).map((v) => {
    const x = object(v);
    const status = x.status;
    if (status !== 'confirmed' && status !== 'cancelled') fail('Invalid order status');
    const lines = list(x.lines, 1000).map((v) => {
      const l = object(v);
      return {
        lineId: text(l.lineId),
        sku: text(l.sku),
        quantity: integer(l.quantity),
        unit: text(l.unit),
      };
    });
    if (status === 'confirmed' && !lines.length) fail('Confirmed order requires lines');
    if (status === 'cancelled' && lines.length)
      fail('Cancelled order must have an empty lines array');
    unique(lines.map((l) => l.lineId));
    return {
      source: text(x.source),
      orderId: text(x.orderId),
      revision: integer(x.revision, Number.MAX_SAFE_INTEGER),
      status,
      outletId: text(x.outletId),
      deliveryDate: date(x.deliveryDate),
      lines: lines.sort((a, b) => a.lineId.localeCompare(b.lineId)),
    } as StudioOrder;
  });
  unique(orders.map((o) => JSON.stringify([o.source, o.orderId])));
  return orders;
}
const key = (o: StudioOrder) => JSON.stringify([o.source, o.orderId]);
export function mergeOrders(current: StudioOrder[], incoming: StudioOrder[]): StudioOrder[] {
  const next = new Map(current.map((o) => [key(o), o]));
  for (const order of incoming) {
    const old = next.get(key(order));
    if (
      old &&
      (order.revision < old.revision ||
        (order.revision === old.revision && JSON.stringify(order) !== JSON.stringify(old)))
    )
      throw new StudioError('Order revision conflict', 409);
    next.set(key(order), order);
  }
  if (next.size > 5000) fail('Local workspace limit: 5000 orders');
  if ([...next.values()].reduce((n, o) => n + o.lines.length, 0) > 20000)
    fail('Local workspace limit: 20000 order lines');
  return [...next.values()].sort((a, b) => key(a).localeCompare(key(b)));
}
export function planWorkspace(
  w: StudioWorkspace,
  deliveryDate: string,
  templates: TemplateDoc[],
): StudioPlan {
  const plan: StudioPlan = { deliveryDate, lines: [], issues: [], totalLabels: 0, stock: [] };
  for (const o of w.orders.filter(
    (o) => o.deliveryDate === deliveryDate && o.status === 'confirmed',
  )) {
    for (const l of o.lines) {
      const rule = w.settings.rules.find((r) => r.sku === l.sku && r.unit === l.unit);
      const template = templates.find((t) => t.id === rule?.templateId);
      let code = '';
      if (!w.settings.outlets.includes(o.outletId)) code = 'unknownOutlet';
      else if (!rule) code = 'missingRule';
      else if (!template) code = 'missingTemplate';
      else if (
        !Number.isFinite(template.media.widthMm) ||
        !Number.isFinite(template.media.heightMm) ||
        template.media.widthMm <= 0 ||
        template.media.heightMm <= 0
      )
        code = 'invalidStock';
      const labels = rule ? l.quantity * rule.labelsPerUnit : 0;
      if (!code && (!Number.isSafeInteger(labels) || labels > 100000)) code = 'quantityLimit';
      if (code || !rule || !template) {
        plan.issues.push({ orderId: o.orderId, lineId: l.lineId, code });
        continue;
      }
      plan.lines.push({
        source: o.source,
        orderId: o.orderId,
        revision: o.revision,
        lineId: l.lineId,
        outletId: o.outletId,
        deliveryDate,
        sku: l.sku,
        quantity: l.quantity,
        unit: l.unit,
        labels,
        templateId: template.id,
        widthMm: template.media.widthMm,
        heightMm: template.media.heightMm,
      });
      plan.totalLabels += labels;
    }
  }
  if (plan.totalLabels > 250000) plan.issues.push({ orderId: '', lineId: '', code: 'batchLimit' });
  for (const l of plan.lines) {
    let stock = plan.stock.find((s) => s.widthMm === l.widthMm && s.heightMm === l.heightMm);
    if (!stock) {
      stock = { widthMm: l.widthMm, heightMm: l.heightMm, labels: 0 };
      plan.stock.push(stock);
    }
    stock.labels += l.labels;
  }
  return plan;
}
function fingerprint(w: StudioWorkspace, day: string, templates: TemplateDoc[]): string {
  const orders = w.orders.filter((o) => o.deliveryDate === day);
  const ids = new Set(
    orders.flatMap((o) =>
      o.lines.flatMap((l) =>
        w.settings.rules
          .filter((r) => r.sku === l.sku && r.unit === l.unit)
          .map((r) => r.templateId),
      ),
    ),
  );
  return createHash('sha256')
    .update(
      JSON.stringify({
        orders,
        settings: w.settings,
        templates: templates.filter((t) => ids.has(t.id)).sort((a, b) => a.id.localeCompare(b.id)),
      }),
    )
    .digest('hex');
}
/** One process, one local factory, one atomic file. Not a multi-worker database. */
export class StudioService {
  private chain: Promise<unknown> = Promise.resolve();
  constructor(
    private file: string,
    private templates: () => Promise<TemplateDoc[]>,
  ) {}
  private async run<T>(
    fn: (w: StudioWorkspace, templates: TemplateDoc[]) => T,
    write = false,
  ): Promise<T> {
    const next = this.chain.then(async () => {
      let w: StudioWorkspace;
      try {
        w = JSON.parse(await fs.readFile(this.file, 'utf8'));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        w = { settings: { outlets: [], rules: [] }, orders: [], batches: [], revisions: [] };
      }
      w.revisions ??= w.orders.map((order) => ({
        receivedAt: new Date().toISOString(),
        order: structuredClone(order),
      }));
      const result = fn(w, await this.templates());
      if (write) {
        await fs.mkdir(path.dirname(this.file), { recursive: true });
        await fs.writeFile(`${this.file}.tmp`, JSON.stringify(w), 'utf8');
        await fs.rename(`${this.file}.tmp`, this.file);
      }
      return result;
    });
    this.chain = next.catch(() => undefined);
    return next;
  }
  view() {
    return this.run((w, templates) => ({
      ...w,
      batches: w.batches.map((b) => ({
        ...b,
        stale: b.fingerprint !== fingerprint(w, b.plan.deliveryDate, templates),
      })),
    }));
  }
  settings(value: unknown) {
    const settings = parseSettings(value);
    return this.run((w) => {
      w.settings = settings;
      return settings;
    }, true);
  }
  ingest(value: unknown) {
    const orders = parseOrders(value);
    return this.run((w) => {
      const merged = mergeOrders(w.orders, orders);
      const changed = orders.filter(
        (o) => !w.orders.some((old) => key(old) === key(o) && old.revision === o.revision),
      );
      if (w.revisions.length + changed.length > 20000)
        fail('Local workspace limit: 20000 revisions');
      w.revisions.push(
        ...changed.map((order) => ({
          receivedAt: new Date().toISOString(),
          order: structuredClone(order),
        })),
      );
      w.orders = merged;
      return { imported: orders.length };
    }, true);
  }
  preview(value: unknown) {
    const day = date(value);
    return this.run((w, templates) => planWorkspace(w, day, templates));
  }
  prepare(value: unknown) {
    const day = date(value);
    return this.run((w, templates) => {
      const plan = planWorkspace(w, day, templates);
      if (plan.issues.length || !plan.lines.length)
        throw new StudioError('Resolve every issue before preparing a batch', 409);
      const hash = fingerprint(w, day, templates);
      const existing = w.batches.find((b) => b.fingerprint === hash && b.plan.deliveryDate === day);
      if (existing) return existing;
      if (w.batches.length >= 1000) fail('Local workspace limit: 1000 batches');
      const batch: StudioBatch = {
        id: randomUUID(),
        createdAt: new Date().toISOString(),
        fingerprint: hash,
        snapshot: structuredClone({
          orders: w.orders.filter((o) => o.deliveryDate === day),
          settings: w.settings,
          templates: templates.filter((t) => plan.lines.some((l) => l.templateId === t.id)),
        }),
        plan,
        status: 'review',
      };
      w.batches.unshift(batch);
      return batch;
    }, true);
  }
  approve(id: string) {
    return this.run((w, templates) => {
      const batch = w.batches.find((b) => b.id === id);
      if (!batch) throw new StudioError('Batch not found', 404);
      if (batch.fingerprint !== fingerprint(w, batch.plan.deliveryDate, templates))
        throw new StudioError('Batch is stale; prepare a new batch', 409);
      if (batch.status !== 'approved') {
        batch.status = 'approved';
        batch.approvedAt = new Date().toISOString();
      }
      return batch;
    }, true);
  }
}
