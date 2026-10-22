import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { StudioOrder, TemplateDoc } from '@labelprint/shared';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { registerStudio } from './routes.js';
import { date, parseOrders, parseSettings, StudioService } from './service.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
const day = '2026-12-01';
const order = (revision = 1): StudioOrder => ({
  source: 'manual',
  orderId: 'O1',
  revision,
  status: 'confirmed',
  outletId: 'A',
  deliveryDate: day,
  lines: [{ lineId: 'L1', sku: 'S', quantity: 3, unit: 'CTN' }],
});
const settings = {
  outlets: ['A'],
  rules: [{ sku: 'S', unit: 'CTN', labelsPerUnit: 6, templateId: 't' }],
};
async function setup() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'studio-'));
  dirs.push(dir);
  const templates = [
    { id: 't', name: 'Test', media: { widthMm: 70, heightMm: 50 }, elements: [] },
  ] as unknown as TemplateDoc[];
  const file = path.join(dir, 'studio.json');
  const service = new StudioService(file, async () => structuredClone(templates));
  await service.settings(settings);
  await service.ingest([order()]);
  return { service, templates, file };
}

describe('studio validation', () => {
  it('rejects malformed dates, units, quantities and duplicated identities', () => {
    for (const v of ['2026-02-30', '2026-13-01', 'not-a-date']) expect(() => date(v)).toThrow();
    for (const v of [null, {}, [1]]) expect(() => parseOrders(v)).toThrow();
    for (const quantity of [0, -1, 1.5, Infinity, '3', 100001])
      expect(() =>
        parseOrders([{ ...order(), lines: [{ ...order().lines[0], quantity }] }]),
      ).toThrow();
    expect(() =>
      parseOrders([{ ...order(), lines: [order().lines[0], order().lines[0]] }]),
    ).toThrow();
    expect(() => parseOrders([order(), order(2)])).toThrow();
    expect(() =>
      parseSettings({ ...settings, rules: [...settings.rules, ...settings.rules] }),
    ).toThrow();
    expect(() => parseSettings({ ...settings, outlets: ['A', 'A'] })).toThrow();
    expect(() => parseOrders([{ ...order(), status: 'cancelled' }])).toThrow();
    expect(() => parseOrders([{ ...order(), lines: [] }])).toThrow();
  });
});
describe('durable local workspace', () => {
  it('calculates confirmed conversion and stock totals and persists across service restart', async () => {
    const { service, file, templates } = await setup();
    const plan = await service.preview(day);
    expect(plan.totalLabels).toBe(18);
    expect(plan.stock).toEqual([{ widthMm: 70, heightMm: 50, labels: 18 }]);
    const batch = await service.prepare(day);
    await service.approve(batch.id);
    const restarted = new StudioService(file, async () => templates);
    const view = await restarted.view();
    expect(view.orders).toHaveLength(1);
    expect(view.revisions).toHaveLength(1);
    expect(view.batches[0].snapshot.orders[0].revision).toBe(1);
    expect(view.batches[0].snapshot.templates[0].id).toBe('t');
    expect(view.batches[0].status).toBe('approved');
    expect(view.batches[0].stale).toBe(false);
  });
  it('handles concurrent replay and prepare/approve without duplicate batches', async () => {
    const { service } = await setup();
    await Promise.all(Array.from({ length: 10 }, () => service.ingest([order()])));
    const batches = await Promise.all(Array.from({ length: 10 }, () => service.prepare(day)));
    expect(new Set(batches.map((b) => b.id)).size).toBe(1);
    const approvals = await Promise.all(
      Array.from({ length: 10 }, () => service.approve(batches[0].id)),
    );
    expect(new Set(approvals.map((b) => b.approvedAt)).size).toBe(1);
    expect((await service.view()).orders).toHaveLength(1);
  });
  it('rejects old and conflicting revisions atomically and recovers after failure', async () => {
    const { service } = await setup();
    await service.ingest([order(2)]);
    await expect(service.ingest([{ ...order(3), orderId: 'O2' }, order(1)])).rejects.toThrow(
      'conflict',
    );
    expect((await service.view()).orders).toHaveLength(1);
    await expect(
      service.ingest([{ ...order(2), lines: [{ ...order().lines[0], quantity: 9 }] }]),
    ).rejects.toThrow('conflict');
    await service.ingest([order(3)]);
    expect((await service.view()).orders[0].revision).toBe(3);
  });
  it('normalizes order field and line ordering before detecting replay', async () => {
    const { service } = await setup();
    const o = order();
    await service.ingest([
      {
        lines: o.lines,
        deliveryDate: o.deliveryDate,
        outletId: o.outletId,
        status: o.status,
        revision: o.revision,
        orderId: o.orderId,
        source: o.source,
      },
    ]);
    expect((await service.view()).orders).toHaveLength(1);
  });
  it('invalidates snapshots after order amendment and cancellation without deleting their original plan', async () => {
    const { service } = await setup();
    const batch = await service.prepare(day);
    await service.approve(batch.id);
    await service.ingest([{ ...order(2), status: 'cancelled', lines: [] }]);
    expect((await service.preview(day)).lines).toHaveLength(0);
    expect((await service.view()).batches[0].stale).toBe(true);
    await expect(service.approve(batch.id)).rejects.toThrow('stale');
    expect((await service.view()).batches[0].plan.totalLabels).toBe(18);
    expect((await service.view()).revisions.map((r) => r.order.status)).toEqual([
      'confirmed',
      'cancelled',
    ]);
    await expect(service.prepare(day)).rejects.toThrow();
  });
  it('invalidates approval on template artwork changes even if counts are identical', async () => {
    const { service, templates } = await setup();
    const batch = await service.prepare(day);
    templates[0].name = 'Changed artwork';
    expect((await service.view()).batches[0].stale).toBe(true);
    await expect(service.approve(batch.id)).rejects.toThrow('stale');
    expect((await service.prepare(day)).id).not.toBe(batch.id);
  });
  it('invalidates on rule edits and new orders for the selected date', async () => {
    const { service } = await setup();
    const first = await service.prepare(day);
    await service.settings({ ...settings, rules: [{ ...settings.rules[0], labelsPerUnit: 2 }] });
    await expect(service.approve(first.id)).rejects.toThrow('stale');
    const second = await service.prepare(day);
    expect(second.plan.totalLabels).toBe(6);
    await service.ingest([{ ...order(), orderId: 'O2' }]);
    await expect(service.approve(second.id)).rejects.toThrow('stale');
  });
  it('blocks unknown outlets, missing rules/templates and overlarge counts', async () => {
    const { service, templates } = await setup();
    await service.settings({ ...settings, outlets: [] });
    expect((await service.preview(day)).issues[0].code).toBe('unknownOutlet');
    await service.settings({ ...settings, rules: [] });
    expect((await service.preview(day)).issues[0].code).toBe('missingRule');
    await service.settings(settings);
    templates.splice(0);
    expect((await service.preview(day)).issues[0].code).toBe('missingTemplate');
    await expect(service.prepare(day)).rejects.toThrow();
  });
  it('enforces per-line and batch label caps', async () => {
    const { service } = await setup();
    await service.ingest([{ ...order(2), lines: [{ ...order().lines[0], quantity: 20000 }] }]);
    expect((await service.preview(day)).issues[0].code).toBe('quantityLimit');
    await service.ingest([
      {
        ...order(3),
        lines: [1, 2, 3].map((n) => ({ ...order().lines[0], lineId: String(n), quantity: 15000 })),
      },
    ]);
    expect((await service.preview(day)).issues[0].code).toBe('batchLimit');
    await expect(service.prepare(day)).rejects.toThrow();
  });
  it('does not silently replace corrupt persisted data', async () => {
    const { service, file } = await setup();
    await writeFile(file, 'not json');
    await expect(service.view()).rejects.toThrow();
    await expect(service.ingest([order(2)])).rejects.toThrow();
  });
  it('exposes validation and conflict statuses through HTTP and never exposes a studio print endpoint', async () => {
    const { service } = await setup();
    const app = Fastify();
    await registerStudio(app, service);
    try {
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/studio/orders',
            payload: [{ ...order(), revision: 0 }],
          })
        ).statusCode,
      ).toBe(400);
      const prepared = await app.inject({
        method: 'POST',
        url: '/api/studio/batches',
        payload: { deliveryDate: day },
      });
      expect(prepared.statusCode).toBe(200);
      const b = prepared.json();
      await service.ingest([order(2)]);
      expect(
        (await app.inject({ method: 'POST', url: `/api/studio/batches/${b.id}/approve` }))
          .statusCode,
      ).toBe(409);
      expect(
        (await app.inject({ method: 'POST', url: `/api/studio/batches/${b.id}/print` })).statusCode,
      ).toBe(404);
      expect((await app.inject('/api/studio')).json().batches[0].stale).toBe(true);
    } finally {
      await app.close();
    }
  });
});
