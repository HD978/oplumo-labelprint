import { strToU8, zipSync } from 'fflate';
import { plan } from './catalogue';
import { renderPart } from './render';
import {
  type Actor,
  audit,
  body,
  type Env,
  edit,
  fail,
  hash,
  id,
  integer,
  json,
  now,
  rows,
  type Snapshot,
  stmt,
  text,
} from './types';

interface Job {
  id: string;
  workspace_id: string;
  status: string;
  kind: string;
  total_count: number;
  success_count: number;
  output_type: string;
  result_r2_keys: string;
  input_hash: string;
}
export async function jobRoutes(request: Request, env: Env, a: Actor, path: string) {
  const w = a.workspaceId;
  if (path === '/api/jobs/preview' && request.method === 'POST') {
    edit(a);
    const p = await plan(env, a, await body(request));
    return json({
      total: p.total,
      stock: p.stock,
      fingerprint: p.fingerprint,
      first: p.lines[0]?.snapshot.values,
    });
  }
  if (path === '/api/jobs' && request.method === 'GET')
    return json(
      await rows(
        env,
        'SELECT * FROM print_jobs WHERE workspace_id=? ORDER BY created_at DESC LIMIT 100',
        w,
      ),
    );
  if (path === '/api/jobs' && request.method === 'POST') {
    edit(a);
    const b = await body(request);
    const key = text(b.idempotencyKey, 128),
      inputHash = await hash(
        JSON.stringify({ input: b.input, outputType: b.outputType, fingerprint: b.fingerprint }),
      );
    const old = await stmt(
      env,
      'SELECT * FROM print_jobs WHERE workspace_id=? AND idempotency_key=?',
      w,
      key,
    ).first<Job>();
    if (old) {
      if (old.input_hash !== inputHash) fail('相同请求编号对应不同内容', 409);
      return json(old);
    }
    const p = await plan(env, a, b.input as Record<string, unknown>);
    if (p.fingerprint !== b.fingerprint) fail('主档或模板已改变，请重新核对', 409);
    if (!['pdf', 'zpl', 'both'].includes(String(b.outputType))) fail('输出格式不正确');
    const uid = id(),
      time = now();
    const encodedLines = JSON.stringify(p.lines);
    if (new TextEncoder().encode(encodedLines).length > 8 * 1024 * 1024)
      fail('任务快照过大，请按 SKU 分批提交');
    const statements = [
      stmt(
        env,
        "INSERT INTO print_jobs(id,workspace_id,kind,status,input_hash,idempotency_key,output_type,total_count,created_by,created_at,updated_at) VALUES(?,?,'labels','review',?,?,?,?,?,?,?)",
        uid,
        w,
        inputHash,
        key,
        b.outputType,
        p.total,
        a.id,
        time,
        time,
      ),
    ];
    let chunk: typeof p.lines = [],
      chunkBytes = 0;
    const flush = () => {
      if (!chunk.length) return;
      statements.push(
        stmt(
          env,
          `INSERT INTO print_job_items(workspace_id,job_id,position,sku_id,copies,snapshot_json) SELECT ?,?,json_extract(value,'$.position'),json_extract(value,'$.sku_id'),json_extract(value,'$.copies'),json_extract(value,'$.snapshot') FROM json_each(?)`,
          w,
          uid,
          JSON.stringify(chunk),
        ),
      );
      chunk = [];
      chunkBytes = 0;
    };
    for (const line of p.lines) {
      const size = new TextEncoder().encode(JSON.stringify(line)).length;
      if (chunk.length && chunkBytes + size > 512 * 1024) flush();
      chunk.push(line);
      chunkBytes += size;
    }
    flush();
    try {
      await env.DB.batch(statements);
    } catch (error) {
      const existing = await stmt(
        env,
        'SELECT * FROM print_jobs WHERE workspace_id=? AND idempotency_key=?',
        w,
        key,
      ).first<Job>();
      if (existing?.input_hash === inputHash) return json(existing);
      throw error;
    }

    await audit(env, a, 'job.review', uid, { labels: p.total });
    return json(
      await stmt(env, 'SELECT * FROM print_jobs WHERE workspace_id=? AND id=?', w, uid).first(),
      201,
    );
  }
  const jm = path.match(/^\/api\/jobs\/([^/]+)(?:\/(start|cancel|retry|files))?$/);
  if (jm) {
    const j = await stmt(
      env,
      'SELECT * FROM print_jobs WHERE workspace_id=? AND id=?',
      w,
      jm[1],
    ).first<Job>();
    if (!j) fail('任务不存在', 404);
    if (request.method === 'GET') {
      if (jm[2] === 'files' && j.status !== 'completed') fail('任务尚未完成', 409);
      if (jm[2] === 'files')
        return json(
          await rows(
            env,
            'SELECT id,filename,size_bytes FROM assets WHERE workspace_id=? AND r2_key>=? AND r2_key<? ORDER BY filename',
            w,
            `${w}/generated/${j.id}/`,
            `${w}/generated/${j.id}/\uffff`,
          ),
        );
      return json(j);
    }
    if (request.method === 'POST' && ['start', 'cancel', 'retry'].includes(jm[2] ?? '')) {
      if (jm[2] === 'retry') edit(a);
      if (jm[2] === 'cancel' && ['completed', 'cancelled'].includes(j.status)) return json(j);
      if (jm[2] === 'start' && j.status !== 'review' && j.status !== 'pending')
        fail('此任务不能启动', 409);
      if (jm[2] === 'retry' && j.status !== 'failed') fail('仅失败任务可以重试', 409);
      if (jm[2] !== 'cancel' && j.status === 'review') {
        const items = await rows<{ snapshot_json: string }>(
          env,
          'SELECT snapshot_json FROM print_job_items WHERE workspace_id=? AND job_id=?',
          w,
          j.id,
        );
        const currentTemplates = new Map(
          (
            await rows<{ id: string; version: number; status: string }>(
              env,
              'SELECT id,version,status FROM templates WHERE workspace_id=?',
              w,
            )
          ).map((x) => [x.id, x]),
        );
        const currentSkus = new Map(
          (
            await rows<{ id: string; version: number; is_active: number }>(
              env,
              'SELECT id,version,is_active FROM skus WHERE workspace_id=?',
              w,
            )
          ).map((x) => [x.id, x]),
        );
        const currentMappings = new Map(
          (
            await rows<{ id: string; version: number; status: string }>(
              env,
              'SELECT id,version,status FROM mappings WHERE workspace_id=?',
              w,
            )
          ).map((x) => [x.id, x]),
        );
        for (const item of items) {
          const snap = JSON.parse(item.snapshot_json) as Snapshot;
          const template = currentTemplates.get(snap.doc.id),
            sku = currentSkus.get(snap.sku.id),
            mapping = currentMappings.get(snap.mappingId);
          if (
            !template ||
            template.version !== snap.templateVersion ||
            template.status !== 'published' ||
            !sku ||
            !sku.is_active ||
            sku.version !== snap.sku.version ||
            !mapping ||
            mapping.version !== snap.mappingVersion ||
            mapping.status !== 'published'
          )
            fail('核对后资料已更改，请创建新任务', 409);
        }
      }
      const stub = env.JOBS.get(env.JOBS.idFromName(`${w}:${j.id}`));
      const res = await stub.fetch('https://job/control', {
        method: 'POST',
        body: JSON.stringify({ workspaceId: w, jobId: j.id, action: jm[2] }),
      });
      if (!res.ok) fail(await res.text(), 409);
      await audit(env, a, `job.${jm[2]}`, j.id);
      return json({ ok: true });
    }
  }
  if (path === '/api/print' && request.method === 'GET')
    return json(
      await rows(
        env,
        'SELECT * FROM print_records WHERE workspace_id=? ORDER BY created_at DESC LIMIT 200',
        w,
      ),
    );
  if (path === '/api/print' && request.method === 'POST') {
    const b = await body(request),
      jobId = text(b.jobId),
      kind = text(b.kind);
    if (!['original', 'reprint', 'test', 'waste'].includes(kind)) fail('打印类型不正确');
    const quantity = integer(b.quantity);
    const j = await stmt(
      env,
      "SELECT total_count FROM print_jobs WHERE workspace_id=? AND id=? AND status='completed'",
      w,
      jobId,
    ).first<{ total_count: number }>();
    if (!j) fail('只允许确认已完成的生成任务');
    if (quantity > j.total_count) fail('确认数量不能超过该任务生成量');
    const idem = text(b.idempotencyKey),
      uid = id();
    const old = await stmt(
      env,
      'SELECT * FROM print_records WHERE workspace_id=? AND idempotency_key=?',
      w,
      idem,
    ).first<Record<string, unknown>>();
    if (old) {
      if (old.job_id !== jobId || old.kind !== kind || old.quantity !== quantity)
        fail('重复编号内容不同', 409);
      return json(old);
    }
    await stmt(
      env,
      'INSERT INTO print_records VALUES(?,?,?,?,?,?,?,?,?,?)',
      uid,
      w,
      jobId,
      kind,
      quantity,
      text(b.printerName),
      typeof b.note === 'string' ? b.note : '',
      a.id,
      idem,
      now(),
    ).run();
    await audit(env, a, 'print.confirm', uid, { jobId, kind, quantity });
    return json({ id: uid }, 201);
  }
  if (path === '/api/forecast' && request.method === 'GET') {
    return json({
      generated: await rows(
        env,
        "SELECT substr(created_at,1,10) day,SUM(total_count) labels FROM print_jobs WHERE workspace_id=? AND status='completed' AND kind='labels' GROUP BY day ORDER BY day DESC LIMIT 90",
        w,
      ),
      confirmed: await rows(
        env,
        'SELECT substr(created_at,1,10) day,kind,SUM(quantity) labels FROM print_records WHERE workspace_id=? GROUP BY day,kind ORDER BY day DESC LIMIT 360',
        w,
      ),
      note: '人工确认出纸；原印、补印、测试和损耗分别统计，不代表销量预测',
    });
  }
  if (path === '/api/export' && request.method === 'POST') {
    edit(a);
    const uid = id(),
      time = now();
    await stmt(
      env,
      "INSERT INTO print_jobs(id,workspace_id,kind,status,input_hash,idempotency_key,output_type,created_by,created_at,updated_at) VALUES(?,?,'export','pending',?,?,'zip',?,?,?)",
      uid,
      w,
      uid,
      uid,
      a.id,
      time,
      time,
    ).run();
    await env.JOBS.get(env.JOBS.idFromName(`${w}:${uid}`)).fetch('https://job/control', {
      method: 'POST',
      body: JSON.stringify({ workspaceId: w, jobId: uid, action: 'start' }),
    });
    await audit(env, a, 'workspace.export', uid);
    return json({ id: uid }, 201);
  }
}
// One durable coordinator per tenant/job. Each deterministic part is committed with
// its progress in one D1 transaction. Alarm retries may repeat R2 puts, never counts.
export class LabelJob {
  constructor(
    private state: DurableObjectState,
    private env: Env,
  ) {}
  async fetch(request: Request) {
    const b = (await request.json()) as { workspaceId: string; jobId: string; action: string };
    return this.state.blockConcurrencyWhile(async () => {
      const job = await stmt(
        this.env,
        'SELECT * FROM print_jobs WHERE workspace_id=? AND id=?',
        b.workspaceId,
        b.jobId,
      ).first<Job>();
      if (!job) return new Response('任务不存在', { status: 404 });
      await this.state.storage.put('identity', { workspaceId: b.workspaceId, jobId: b.jobId });
      if (b.action === 'cancel') {
        if (job.status !== 'completed') {
          await stmt(
            this.env,
            "UPDATE print_jobs SET status='cancelled',updated_at=? WHERE workspace_id=? AND id=?",
            now(),
            b.workspaceId,
            b.jobId,
          ).run();
          await this.state.storage.deleteAlarm();
        }
        return json({ ok: true });
      }
      if (!['review', 'pending', 'failed', 'processing'].includes(job.status))
        return new Response('任务状态不允许启动', { status: 409 });
      await stmt(
        this.env,
        "UPDATE print_jobs SET status='pending',error_message=NULL,updated_at=? WHERE workspace_id=? AND id=?",
        now(),
        b.workspaceId,
        b.jobId,
      ).run();
      await this.state.storage.setAlarm(Date.now() + 100);
      return json({ ok: true });
    });
  }
  async alarm() {
    await this.state.blockConcurrencyWhile(async () => {
      const identity = await this.state.storage.get<{ workspaceId: string; jobId: string }>(
        'identity',
      );
      if (!identity) return;
      const { workspaceId: w, jobId: jid } = identity;
      const env = this.env;
      const j = await stmt(
        env,
        'SELECT * FROM print_jobs WHERE workspace_id=? AND id=?',
        w,
        jid,
      ).first<Job>();
      if (!j || ['completed', 'cancelled'].includes(j.status)) return;
      try {
        await stmt(
          env,
          "UPDATE print_jobs SET status='processing',updated_at=? WHERE workspace_id=? AND id=?",
          now(),
          w,
          jid,
        ).run();
        if (j.kind === 'export') {
          await this.exportStep(j);
          return;
        }
        const position = (await this.state.storage.get<{
          row: number;
          offset: number;
          part: number;
        }>('cursor')) ?? { row: 0, offset: 0, part: 0 };
        const item = await stmt(
          env,
          'SELECT * FROM print_job_items WHERE workspace_id=? AND job_id=? AND position=?',
          w,
          jid,
          position.row,
        ).first<{ copies: number; snapshot_json: string }>();
        if (!item) {
          const parts = await rows<{ keys_json: string }>(
            env,
            'SELECT keys_json FROM job_parts WHERE workspace_id=? AND job_id=? ORDER BY part',
            w,
            jid,
          );
          await this.finish(
            j,
            parts.flatMap((p) => JSON.parse(p.keys_json)),
          );
          return;
        }
        const committed = await stmt(
          env,
          'SELECT labels FROM job_parts WHERE workspace_id=? AND job_id=? AND part=?',
          w,
          jid,
          position.part,
        ).first();
        const copies = Math.min(100, item.copies - position.offset);
        if (!committed) {
          const output = await renderPart(
            [{ snapshot: JSON.parse(item.snapshot_json), copies }],
            env,
            w,
            j.output_type,
          );
          const archive = zipSync(Object.fromEntries(output.map((o) => [o.name, o.bytes])), {
            level: 0,
          });
          output.push({ name: 'labels.zip', bytes: archive, type: 'application/zip' });
          const keys: string[] = [];
          const assetStatements: D1PreparedStatement[] = [];
          for (const o of output) {
            const key = `${w}/generated/${jid}/part-${String(position.part).padStart(6, '0')}-${o.name}`;
            await env.FILES.put(key, o.bytes, { httpMetadata: { contentType: o.type } });
            keys.push(key);
            assetStatements.push(
              stmt(
                env,
                'INSERT OR IGNORE INTO assets VALUES(?,?,?,?,?,?,?,?)',
                await hash(key),
                w,
                key.split('/').pop(),
                key,
                o.name.split('.').pop(),
                o.bytes.length,
                now(),
                'system',
              ),
            );
          }
          await env.DB.batch([
            stmt(
              env,
              'INSERT INTO job_parts VALUES(?,?,?,?,?)',
              w,
              jid,
              position.part,
              copies,
              JSON.stringify(keys),
            ),
            ...assetStatements,
            stmt(
              env,
              'UPDATE print_jobs SET success_count=success_count+?,updated_at=? WHERE workspace_id=? AND id=?',
              copies,
              now(),
              w,
              jid,
            ),
          ]);
        }
        const offset = position.offset + copies;
        await this.state.storage.put('cursor', {
          row: offset === item.copies ? position.row + 1 : position.row,
          offset: offset === item.copies ? 0 : offset,
          part: position.part + 1,
        });
        await this.state.storage.setAlarm(Date.now() + 100);
      } catch (e) {
        await stmt(
          env,
          "UPDATE print_jobs SET status='failed',error_message=?,updated_at=? WHERE workspace_id=? AND id=?",
          String((e as Error).message).slice(0, 1000),
          now(),
          w,
          jid,
        ).run();
      }
    });
  }
  private async finish(j: Job, keys: string[]) {
    await stmt(
      this.env,
      "UPDATE print_jobs SET status='completed',result_r2_keys=?,updated_at=?,finished_at=? WHERE workspace_id=? AND id=?",
      JSON.stringify(keys),
      now(),
      now(),
      j.workspace_id,
      j.id,
    ).run();
  }
  private async exportStep(j: Job) {
    const env = this.env,
      w = j.workspace_id;
    let snapshot = await this.state.storage.get<{
      assets: { r2_key: string; size_bytes: number; filename: string }[];
      index: number;
      part: number;
      keys: string[];
    }>('export');
    if (!snapshot) {
      const tables = [
        'workspaces',
        'label_sizes',
        'skus',
        'templates',
        'template_versions',
        'mappings',
        'mapping_versions',
        'template_rules',
        'assets',
        'print_jobs',
        'print_job_items',
        'job_parts',
        'print_records',
        'audit_events',
      ];
      const data: Record<string, unknown> = {
        format: 'oplumo-workspace-v2',
        exportedAt: now(),
        workspaceId: w,
      };
      for (const table of tables)
        data[table] = await rows(
          env,
          `SELECT * FROM ${table} WHERE ${table === 'workspaces' ? 'id' : 'workspace_id'}=?`,
          w,
        );
      const exportIds = new Set(
        (data.print_jobs as Job[]).filter((job) => job.kind === 'export').map((job) => job.id),
      );
      const assets = (
        data.assets as { r2_key: string; size_bytes: number; filename: string }[]
      ).filter((asset) => !exportIds.has(asset.r2_key.split('/')[2]!));
      data.assets = assets;
      data.excludedDerivedBackups = true;
      if (env.FONT_KEY) {
        const font = await env.FILES.head(env.FONT_KEY);
        if (font) {
          assets.push({ r2_key: env.FONT_KEY, size_bytes: font.size, filename: 'render-font.ttf' });
          data.fontKey = env.FONT_KEY;
        }
      }
      const key = `${w}/generated/${j.id}/master.json`;
      await env.FILES.put(key, JSON.stringify(data), {
        httpMetadata: { contentType: 'application/json' },
      });
      snapshot = {
        assets: [{ r2_key: key, size_bytes: 0, filename: 'master.json' }, ...assets],
        index: 0,
        part: 0,
        keys: [],
      };
      await this.state.storage.put('export', snapshot);
    }
    const files: Record<string, Uint8Array> = {};
    let bytes = 0,
      index = snapshot.index;
    while (index < snapshot.assets.length) {
      const a = snapshot.assets[index]!;
      if (bytes && bytes + a.size_bytes > 15 * 1024 * 1024) break;
      if (a.size_bytes > 20 * 1024 * 1024) fail('导出包含大于 20MB 的单文件，需使用对象备份流程');
      const obj = await env.FILES.get(a.r2_key);
      if (!obj) fail(`导出缺失文件：${a.filename}`);
      const data = new Uint8Array(await obj.arrayBuffer());
      files[a.r2_key] = data;
      bytes += data.length;
      index++;
    }
    files['part-manifest.json'] = strToU8(
      JSON.stringify({
        workspaceId: w,
        part: snapshot.part,
        from: snapshot.index,
        to: index,
        files: Object.keys(files),
      }),
    );
    const key = `${w}/generated/${j.id}/workspace-part-${snapshot.part}.zip`;
    const zip = zipSync(files, { level: 0 });
    await env.FILES.put(key, zip, { httpMetadata: { contentType: 'application/zip' } });
    await stmt(
      env,
      'INSERT OR IGNORE INTO assets VALUES(?,?,?,?,?,?,?,?)',
      await hash(key),
      w,
      key.split('/').pop(),
      key,
      'zip',
      zip.length,
      now(),
      'system',
    ).run();
    snapshot = { ...snapshot, index, part: snapshot.part + 1, keys: [...snapshot.keys, key] };
    await this.state.storage.put('export', snapshot);
    if (index === snapshot.assets.length) {
      await this.finish(j, snapshot.keys);
    } else await this.state.storage.setAlarm(Date.now() + 100);
  }
}
