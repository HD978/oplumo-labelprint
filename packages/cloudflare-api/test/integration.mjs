import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { Log, LogLevel, Miniflare } from 'miniflare';
import { PDFDocument } from 'pdf-lib';

const root = new URL('../', import.meta.url);
const mf = new Miniflare({
  modules: true,
  cf: false, // Never fetch Cloudflare request metadata; fixtures stay offline.
  scriptPath: new URL('dist/index.js', root).pathname,
  modulesRules: [{ type: 'CompiledWasm', include: ['**/*.wasm'], fallthrough: true }],
  compatibilityDate: '2026-07-01',
  compatibilityFlags: ['nodejs_compat'],
  d1Databases: ['DB'],
  r2Buckets: ['FILES'],
  durableObjects: { JOBS: { className: 'LabelJob', useSQLite: true } },
  bindings: {
    APP_ORIGIN: 'https://studio.test',
    BOOTSTRAP_TOKEN: 'test-bootstrap-token',
    FONT_KEY: '_system/font.ttf',
  },
  log: new Log(LogLevel.ERROR),
});
const db = await mf.getD1Database('DB'),
  bucket = await mf.getR2Bucket('FILES');
try {
  await db.exec(
    (await readFile(new URL('migrations/0001_v2.sql', root), 'utf8')).replace(/\n/g, ' '),
  );
  await bucket.put(
    '_system/font.ttf',
    await readFile('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'),
  );
  const response = async (path, method = 'GET', data, auth = {}, extra = {}) =>
    mf.dispatchFetch(`https://studio.test${path}`, {
      method,
      headers: {
        Origin: 'https://studio.test',
        ...(data === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...auth,
        ...extra,
      },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
  const request = async (path, method = 'GET', data, auth = {}, status = 200, extra = {}) => {
    const r = await response(path, method, data, auth, extra);
    const result = await r.json();
    assert.equal(r.status, status, `${path}: ${JSON.stringify(result)}`);
    return result;
  };
  await request(
    '/api/bootstrap',
    'POST',
    {
      email: 'qa@example.test',
      name: 'QA',
      password: 'local-test-password',
      workspaceName: 'Factory 1',
    },
    {},
    201,
    { Authorization: 'Bearer test-bootstrap-token' },
  );
  const login = await response('/api/auth/login', 'POST', {
    email: 'qa@example.test',
    password: 'local-test-password',
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const me = await request('/api/auth/me', 'GET', undefined, { Cookie: cookie });
  const wid = me.memberships[0].workspace_id;
  const qa = { Cookie: cookie, 'X-Workspace-ID': wid };
  for (let i = 2; i <= 10; i++)
    await request('/api/platform/workspaces', 'POST', { name: `Factory ${i}` }, qa, 201);
  const tenants = await request('/api/platform/workspaces', 'GET', undefined, qa);
  assert.equal(tenants.length, 10);
  await request(
    '/api/users',
    'POST',
    {
      email: 'manager@example.test',
      name: 'Manager',
      password: 'manager-test-password',
      role: 'manager',
    },
    qa,
    201,
  );
  await request(
    '/api/users',
    'POST',
    {
      email: 'worker@example.test',
      name: 'Worker',
      password: 'worker-test-password',
      role: 'worker',
    },
    qa,
    201,
  );
  async function loginAs(email, password) {
    const r = await response('/api/auth/login', 'POST', { email, password });
    assert.equal(r.status, 200);
    return { Cookie: r.headers.get('set-cookie').split(';')[0], 'X-Workspace-ID': wid };
  }
  const manager = await loginAs('manager@example.test', 'manager-test-password'),
    worker = await loginAs('worker@example.test', 'worker-test-password');
  await request(
    '/api/users',
    'POST',
    {
      email: 'blocked@example.test',
      name: 'Blocked',
      password: 'another-test-password',
      role: 'worker',
    },
    manager,
    403,
  );
  await request('/api/skus', 'POST', { sku_code: 'BAD', name: 'Blocked' }, worker, 403);
  const other = { ...qa, 'X-Workspace-ID': tenants.find((t) => t.id !== wid).id };
  assert.deepEqual(await request('/api/skus', 'GET', undefined, other), []);
  await request(
    '/api/skus',
    'GET',
    undefined,
    { ...worker, 'X-Workspace-ID': other['X-Workspace-ID'] },
    403,
  );
  const _sku = await request(
    '/api/skus',
    'POST',
    { sku_code: '0001', name: 'TEST LABEL', expiry_days: 7, size_code: '40x20' },
    manager,
    201,
  );
  const doc = {
    id: 'template-1',
    name: '40x20 test',
    version: 1,
    media: { widthMm: 40, heightMm: 20, type: 'gap', gapMm: 2 },
    params: [],
    defaults: {},
    elements: [
      {
        id: 'name',
        type: 'text',
        x: 1,
        y: 1,
        w: 38,
        h: 7,
        fontFamily: 'DejaVu Sans',
        fontSizePt: 8,
        fontWeight: 'bold',
        align: 'center',
        valign: 'middle',
        text: '{{product}}',
      },
      {
        id: 'expiry',
        type: 'text',
        x: 1,
        y: 10,
        w: 38,
        h: 7,
        fontFamily: 'DejaVu Sans',
        fontSizePt: 7,
        fontWeight: 'normal',
        align: 'center',
        valign: 'middle',
        text: 'EXP {{expiry}}',
      },
    ],
  };
  await request('/api/templates/template-1', 'PUT', doc, manager);
  assert.equal((await request('/api/templates', 'GET', undefined, worker)).length, 0);
  await request('/api/templates/template-1/publish', 'POST', {}, manager);
  assert.equal((await request('/api/templates', 'GET', undefined, worker)).length, 1);
  await request('/api/templates/template-1', 'PUT', { ...doc, version: 1 }, worker, 403);
  const map = await request(
    '/api/mappings',
    'POST',
    {
      name: 'Mapping',
      config: {
        quantityMultiplier: 1,
        defaultTemplateId: 'template-1',
        bindings: {
          product: { source: 'sku', field: 'name' },
          expiry: { source: 'date', value: 'expiry', format: 'DD/MM/YYYY' },
        },
      },
    },
    manager,
  );
  await request(`/api/mappings/${map.id}/publish`, 'POST', {}, manager);
  const input = {
    mappingId: map.id,
    productionDate: '2026-10-23',
    batchNo: 'BATCH-1',
    outlet: 'HQ',
    lines: [{ sku_code: '0001', quantity: 3001 }],
  };
  const p = await request('/api/jobs/preview', 'POST', input, manager);
  assert.equal(p.total, 3001);
  assert.equal(p.first.expiry, '30/10/2026');
  await request('/api/jobs/preview', 'POST', input, worker, 403);
  const create = {
    input,
    fingerprint: p.fingerprint,
    outputType: 'both',
    idempotencyKey: 'job-test-one',
  };
  const job = await request('/api/jobs', 'POST', create, manager, 201);
  assert.equal(job.total_count, 3001);
  assert.equal((await request('/api/jobs', 'POST', create, manager)).id, job.id);
  await request('/api/jobs', 'POST', { ...create, outputType: 'pdf' }, manager, 409);
  await request(`/api/jobs/${job.id}`, 'GET', undefined, other, 404);
  await request(`/api/jobs/${job.id}/start`, 'POST', {}, manager);
  let current;
  for (let i = 0; i < 200; i++) {
    current = await request(`/api/jobs/${job.id}`, 'GET', undefined, manager);
    if (['completed', 'failed'].includes(current.status)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(current.status, 'completed', JSON.stringify(current));
  assert.equal(current.success_count, 3001);
  const files = await request(`/api/jobs/${job.id}/files`, 'GET', undefined, worker);
  assert(files.some((f) => f.filename.endsWith('.zpl')));
  assert(files.some((f) => f.filename.endsWith('.zip')));
  let pages = 0;
  for (const f of files.filter((f) => f.filename.endsWith('.pdf'))) {
    const res = await response(`/api/assets/${f.id}/file`, 'GET', undefined, worker);
    assert.equal(res.status, 200);
    const bytes = await res.arrayBuffer();
    const pdf = await PDFDocument.load(bytes);
    pages += pdf.getPageCount();
    for (const page of pdf.getPages()) {
      assert(Math.abs(page.getWidth() - (40 * 72) / 25.4) < 0.01);
      assert(Math.abs(page.getHeight() - (20 * 72) / 25.4) < 0.01);
    }
    if (pages === 100)
      await writeFile(new URL('test/generated-proof.pdf', root), new Uint8Array(bytes));
  }
  assert.equal(pages, 3001);
  const pdfAsset = files.find((f) => f.filename.endsWith('.pdf'));
  const inlinePdf = await response(
    `/api/assets/${pdfAsset.id}/file?inline=1`,
    'GET',
    undefined,
    worker,
  );
  assert.equal(inlinePdf.headers.get('content-type'), 'application/pdf');
  assert(inlinePdf.headers.get('content-disposition').startsWith('inline'));
  const file = files[0];
  await request(`/api/assets/${file.id}/file`, 'GET', undefined, other, 404);
  const print = {
    jobId: job.id,
    quantity: 3001,
    kind: 'original',
    printerName: 'QA Printer',
    note: 'integration manual confirmation',
    idempotencyKey: 'printed-original',
  };
  await request('/api/print', 'POST', print, worker, 201);
  await request('/api/print', 'POST', print, worker);
  await request(
    '/api/print',
    'POST',
    { ...print, kind: 'reprint', quantity: 2, idempotencyKey: 'printed-reprint' },
    worker,
    201,
  );
  const stats = await request('/api/forecast', 'GET', undefined, qa);
  assert.equal(stats.confirmed.find((r) => r.kind === 'original').labels, 3001);
  assert.equal(stats.confirmed.find((r) => r.kind === 'reprint').labels, 2);
  const draft = await request(
    '/api/imports/preview',
    'POST',
    { rows: [{ sku_code: '0001', name: 'UPDATED', expiry_days: 10 }] },
    manager,
    201,
  );
  assert.equal(draft.updated, 1);
  await request(`/api/imports/${draft.id}/apply`, 'POST', {}, manager);
  const skuRow = (await request('/api/skus', 'GET', undefined, manager))[0];
  assert.equal(skuRow.expiry_days, 10);
  const newPlan = await request(
    '/api/jobs/preview',
    'POST',
    { ...input, lines: [{ sku_code: '0001', quantity: 1 }] },
    manager,
  );
  assert.equal(newPlan.first.expiry, '02/11/2026');
  const cancelled = await request(
    '/api/jobs',
    'POST',
    {
      input: { ...input, lines: [{ sku_code: '0001', quantity: 1 }] },
      fingerprint: newPlan.fingerprint,
      outputType: 'pdf',
      idempotencyKey: 'cancel-test',
    },
    manager,
    201,
  );
  await request(`/api/jobs/${cancelled.id}/cancel`, 'POST', {}, worker);
  await request(`/api/jobs/${cancelled.id}/start`, 'POST', {}, worker, 409);
  const stalePreview = await request(
    '/api/jobs/preview',
    'POST',
    { ...input, lines: [{ sku_code: '0001', quantity: 1 }] },
    manager,
  );
  await request(`/api/skus/${skuRow.id}`, 'PUT', { ...skuRow, name: 'CHANGED AGAIN' }, manager);
  await request(
    '/api/jobs',
    'POST',
    {
      input: { ...input, lines: [{ sku_code: '0001', quantity: 1 }] },
      fingerprint: stalePreview.fingerprint,
      outputType: 'pdf',
      idempotencyKey: 'stale-test',
    },
    manager,
    409,
  );
  const malicious = await response('/api/skus', 'POST', { sku_code: 'x', name: 'x' }, manager, {
    Origin: 'https://evil.test',
  });
  assert.equal(malicious.status, 403);
  // A failure before a part is committed must be retryable without double counts.
  await bucket.delete('_system/font.ttf');
  const retryInput = { ...input, lines: [{ sku_code: '0001', quantity: 1 }] };
  const retryPlan = await request('/api/jobs/preview', 'POST', retryInput, manager);
  const retryJob = await request(
    '/api/jobs',
    'POST',
    {
      input: retryInput,
      fingerprint: retryPlan.fingerprint,
      outputType: 'pdf',
      idempotencyKey: 'retry-test',
    },
    manager,
    201,
  );
  await request(`/api/jobs/${retryJob.id}/start`, 'POST', {}, manager);
  for (let i = 0; i < 100; i++) {
    const r = await request(`/api/jobs/${retryJob.id}`, 'GET', undefined, manager);
    if (r.status === 'failed') break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(
    (await request(`/api/jobs/${retryJob.id}`, 'GET', undefined, manager)).status,
    'failed',
  );
  await bucket.put(
    '_system/font.ttf',
    await readFile('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'),
  );
  await request(`/api/jobs/${retryJob.id}/retry`, 'POST', {}, manager);
  for (let i = 0; i < 100; i++) {
    const r = await request(`/api/jobs/${retryJob.id}`, 'GET', undefined, manager);
    if (r.status === 'completed') break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const retried = await request(`/api/jobs/${retryJob.id}`, 'GET', undefined, manager);
  assert.equal(retried.status, 'completed');
  assert.equal(retried.success_count, 1);
  const originalSnapshot = await db
    .prepare('SELECT snapshot_json FROM print_job_items WHERE workspace_id=? AND job_id=?')
    .bind(wid, job.id)
    .first();
  assert.equal(JSON.parse(originalSnapshot.snapshot_json).values.expiry, '30/10/2026');
  await request('/api/export', 'POST', {}, worker, 403);
  const exported = await request('/api/export', 'POST', {}, manager, 201);
  for (let i = 0; i < 200; i++) {
    const r = await request(`/api/jobs/${exported.id}`, 'GET', undefined, manager);
    if (['completed', 'failed'].includes(r.status)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const exportJob = await request(`/api/jobs/${exported.id}`, 'GET', undefined, manager);
  assert.equal(exportJob.status, 'completed', JSON.stringify(exportJob));
  const exportFiles = await request(`/api/jobs/${exported.id}/files`, 'GET', undefined, manager);
  assert(exportFiles.length > 0);
  const master = await bucket.get(`${wid}/generated/${exported.id}/master.json`);
  const snapshot = JSON.parse(await master.text());
  assert.equal(snapshot.workspaceId, wid);
  assert(snapshot.skus.length > 0);
  assert(!('users' in snapshot));
  assert(!('sessions' in snapshot));
  console.log(
    'PASS: 10 tenants; authenticated role and file isolation; master mapping + immutable dates; 3001 labels in exact-size PDF/ZPL/ZIP shards; idempotent generation; print vs reprint totals; master diff apply; cancellation and stale preview rejection; retry after rendering failure; preserved original expiry; complete workspace export; CSRF.',
  );
} finally {
  await mf.dispose();
}
