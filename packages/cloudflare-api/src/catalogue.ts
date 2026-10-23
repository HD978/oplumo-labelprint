import type { TemplateDoc } from '@labelprint/shared';
import {
  isoDate,
  type Planned,
  resolveValues,
  validateDoc,
  validateMapping,
  validateSku,
} from './mapping';
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
  type Sku,
  stmt,
  text,
} from './types';
export async function catalogueRoutes(request: Request, env: Env, a: Actor, path: string) {
  const w = a.workspaceId;
  if (path === '/api/skus' && request.method === 'GET') {
    const p = new URL(request.url).searchParams;
    return json(
      await rows(
        env,
        'SELECT * FROM skus WHERE workspace_id=? AND sku_code>? ORDER BY sku_code LIMIT 200',
        w,
        p.get('after') ?? '',
      ),
    );
  }
  if (path === '/api/skus' && request.method === 'POST') {
    edit(a);
    const b = await body(request);
    const s = validateSku(b),
      uid = id();
    await stmt(
      env,
      'INSERT INTO skus(id,workspace_id,sku_code,name,name_en,category,spec,barcode,weight,size_code,expiry_days,extra,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
      uid,
      w,
      ...Object.values(s),
      now(),
    ).run();
    await audit(env, a, 'sku.create', uid);
    return json({ id: uid }, 201);
  }
  const sku = path.match(/^\/api\/skus\/([^/]+)$/);
  if (sku && request.method === 'PUT') {
    edit(a);
    const b = await body(request),
      s = validateSku(b);
    const result = await stmt(
      env,
      'UPDATE skus SET sku_code=?,name=?,name_en=?,category=?,spec=?,barcode=?,weight=?,size_code=?,expiry_days=?,extra=?,version=version+1,updated_at=? WHERE workspace_id=? AND id=? AND version=?',
      ...Object.values(s),
      now(),
      w,
      sku[1],
      integer(b.version),
    ).run();
    if (!result.meta.changes) fail('资料已被修改，请刷新', 409);
    await audit(env, a, 'sku.update', sku[1]!);
    return json({ ok: true });
  }
  if (path === '/api/sizes' && request.method === 'GET')
    return json(await rows(env, 'SELECT * FROM label_sizes WHERE workspace_id=?', w));
  if (path === '/api/sizes' && request.method === 'POST') {
    edit(a);
    const b = await body(request);
    const width = Number(b.width_mm),
      height = Number(b.height_mm);
    if (!(width > 0 && height > 0 && width <= 300 && height <= 300)) fail('尺寸不正确');
    const uid = id();
    await stmt(
      env,
      'INSERT INTO label_sizes VALUES(?,?,?,?,?,?,?,?)',
      uid,
      w,
      text(b.code),
      width,
      height,
      Number(b.gap_mm ?? 2),
      integer(Number(b.dpi ?? 300), 203, 300),
    ).run();
    return json({ id: uid }, 201);
  }
  if (path === '/api/templates' && request.method === 'GET') {
    const docs = await rows<{ design_json: string; status: string; version: number }>(
      env,
      `SELECT design_json,status,version FROM templates WHERE workspace_id=?${a.role === 'worker' ? " AND status='published'" : ''} ORDER BY name`,
      w,
    );
    return json(
      docs.map((t) => ({
        ...JSON.parse(t.design_json),
        version: t.version,
        publicationStatus: t.status,
      })),
    );
  }
  const tm = path.match(/^\/api\/templates\/([^/]+)(?:\/(versions|publish|restore))?$/);
  if (tm) {
    const tid = tm[1]!;
    const existing = await stmt(
      env,
      'SELECT * FROM templates WHERE workspace_id=? AND id=?',
      w,
      tid,
    ).first<{ design_json: string; version: number; status: string }>();
    if (request.method === 'GET') {
      if (!existing || (a.role === 'worker' && existing.status !== 'published'))
        fail('模板不存在', 404);
      if (tm[2] === 'versions')
        return json(
          await rows(
            env,
            'SELECT version,created_by,created_at FROM template_versions WHERE workspace_id=? AND template_id=? ORDER BY version DESC',
            w,
            tid,
          ),
        );
      return json({
        ...JSON.parse(existing.design_json),
        version: existing.version,
        publicationStatus: existing.status,
      });
    }
    edit(a);
    if (tm[2] === 'publish' && request.method === 'POST') {
      if (!existing) fail('模板不存在', 404);
      await stmt(
        env,
        "UPDATE templates SET status='published' WHERE workspace_id=? AND id=?",
        w,
        tid,
      ).run();
      await audit(env, a, 'template.publish', tid);
      return json({ ok: true });
    }
    if (
      (request.method === 'PUT' && !tm[2]) ||
      (request.method === 'POST' && tm[2] === 'restore')
    ) {
      let b = await body<TemplateDoc & { baseVersion?: number; restoreVersion?: number }>(request);
      if (tm[2] === 'restore') {
        const saved = await stmt(
          env,
          'SELECT design_json FROM template_versions WHERE workspace_id=? AND template_id=? AND version=?',
          w,
          tid,
          b.restoreVersion,
        ).first<{ design_json: string }>();
        if (!saved) fail('历史版本不存在', 404);
        b = { ...JSON.parse(saved.design_json), version: b.version };
      }
      const doc = validateDoc(b);
      if (existing && doc.version !== existing.version) fail('模板已被更改，请刷新', 409);
      const version = (existing?.version ?? 0) + 1;
      const design = JSON.stringify({ ...doc, id: tid, version });
      const timestamp = now();
      const q = existing
        ? stmt(
            env,
            "UPDATE templates SET name=?,design_json=?,version=?,status='draft',updated_at=? WHERE workspace_id=? AND id=? AND version=?",
            doc.name,
            design,
            version,
            timestamp,
            w,
            tid,
            existing.version,
          )
        : stmt(
            env,
            'INSERT INTO templates(id,workspace_id,name,design_json,version,updated_at) VALUES(?,?,?,?,?,?)',
            tid,
            w,
            doc.name,
            design,
            version,
            timestamp,
          );
      await env.DB.batch([
        q,
        stmt(
          env,
          'INSERT INTO template_versions VALUES(?,?,?,?,?,?)',
          w,
          tid,
          version,
          design,
          a.id,
          timestamp,
        ),
      ]);
      await audit(env, a, 'template.save', tid, { version });
      return json({ ...doc, id: tid, version, publicationStatus: 'draft' });
    }
    if (request.method === 'DELETE') {
      await stmt(
        env,
        "UPDATE templates SET status='archived' WHERE workspace_id=? AND id=?",
        w,
        tid,
      ).run();
      return json({ ok: true });
    }
  }
  if (path === '/api/mappings' && request.method === 'GET')
    return json(await rows(env, 'SELECT * FROM mappings WHERE workspace_id=?', w));
  if (path === '/api/mappings' && request.method === 'POST') {
    edit(a);
    const b = await body(request);
    const config = validateMapping(b.config),
      uid = typeof b.id === 'string' ? b.id : id();
    const old = await stmt(
      env,
      'SELECT version FROM mappings WHERE workspace_id=? AND id=?',
      w,
      uid,
    ).first<{ version: number }>();
    if (old && b.version !== old.version) fail('对应规则已更改', 409);
    const v = (old?.version ?? 0) + 1,
      time = now(),
      serialized = JSON.stringify(config);
    await env.DB.batch([
      old
        ? stmt(
            env,
            "UPDATE mappings SET name=?,config_json=?,version=?,status='draft',updated_at=? WHERE workspace_id=? AND id=? AND version=?",
            text(b.name),
            serialized,
            v,
            time,
            w,
            uid,
            old.version,
          )
        : stmt(
            env,
            'INSERT INTO mappings(id,workspace_id,name,config_json,updated_at) VALUES(?,?,?,?,?)',
            uid,
            w,
            text(b.name),
            serialized,
            time,
          ),
      stmt(
        env,
        'INSERT INTO mapping_versions VALUES(?,?,?,?,?,?)',
        w,
        uid,
        v,
        serialized,
        a.id,
        time,
      ),
    ]);
    await audit(env, a, 'mapping.save', uid, { version: v });
    return json({ id: uid, version: v });
  }
  const pub = path.match(/^\/api\/mappings\/([^/]+)\/publish$/);
  if (pub && request.method === 'POST') {
    edit(a);
    await stmt(
      env,
      "UPDATE mappings SET status='published' WHERE workspace_id=? AND id=?",
      w,
      pub[1],
    ).run();
    await audit(env, a, 'mapping.publish', pub[1]!);
    return json({ ok: true });
  }
  if (path === '/api/rules' && request.method === 'GET')
    return json(
      await rows(env, 'SELECT * FROM template_rules WHERE workspace_id=? ORDER BY priority,id', w),
    );
  if (path === '/api/rules' && request.method === 'POST') {
    edit(a);
    const b = await body(request),
      uid = id();
    await stmt(
      env,
      'INSERT INTO template_rules VALUES(?,?,?,?,?,?,?)',
      uid,
      w,
      text(b.template_id),
      integer(b.priority, 0, 999999),
      b.match_category || null,
      b.match_size_code || null,
      b.match_sku_prefix || null,
    ).run();
    await audit(env, a, 'rule.create', uid);
    return json({ id: uid }, 201);
  }
}
export async function plan(env: Env, a: Actor, input: Record<string, unknown>) {
  const w = a.workspaceId;
  const mappingRow = await stmt(
    env,
    "SELECT * FROM mappings WHERE workspace_id=? AND id=? AND status='published'",
    w,
    text(input.mappingId),
  ).first<{ id: string; version: number; config_json: string }>();
  if (!mappingRow) fail('请选择已发布的 Master Mapping');
  const mapping = validateMapping(JSON.parse(mappingRow.config_json));
  const productionDate = isoDate(input.productionDate),
    batchNo = text(input.batchNo),
    outlet = typeof input.outlet === 'string' ? input.outlet : '';
  const requested = input.lines as { sku_code: string; quantity: number }[];
  if (!Array.isArray(requested) || !requested.length || requested.length > 5000)
    fail('每次提交 1–5000 行，可分批提交；标签张数不设旧版总量限制');
  const codes = new Set<string>();
  const docs = await rows<{ id: string; design_json: string; version: number }>(
    env,
    "SELECT id,design_json,version FROM templates WHERE workspace_id=? AND status='published'",
    w,
  );
  const rules = await rows<{
    template_id: string;
    match_category: string | null;
    match_size_code: string | null;
    match_sku_prefix: string | null;
  }>(env, 'SELECT * FROM template_rules WHERE workspace_id=? ORDER BY priority,id', w);
  const skuRows = await rows<Sku>(
    env,
    'SELECT * FROM skus WHERE workspace_id=? AND is_active=1',
    w,
  );
  const byCode = new Map(skuRows.map((s) => [s.sku_code, s]));
  const results: Planned[] = [];
  let total = 0;
  for (const line of requested) {
    const code = text(line.sku_code, 128);
    if (codes.has(code)) fail(`SKU 重复：${code}`);
    codes.add(code);
    const sku = byCode.get(code);
    if (!sku) fail(`找不到有效 SKU：${code}`);
    const tid =
      mapping.skuTemplates?.[code] ??
      rules.find(
        (r) =>
          (!r.match_category || r.match_category === sku.category) &&
          (!r.match_size_code || r.match_size_code === sku.size_code) &&
          (!r.match_sku_prefix || code.startsWith(r.match_sku_prefix)),
      )?.template_id ??
      mapping.defaultTemplateId;
    if (!tid) fail(`${code} 没有模板对应，系统不会猜测`);
    const saved = docs.find((d) => d.id === tid);
    if (!saved) fail(`${code} 对应模板尚未发布`);
    const doc = validateDoc(JSON.parse(saved.design_json));
    const copies = integer(integer(line.quantity) * mapping.quantityMultiplier);
    total = integer(total + copies);
    results.push({
      position: results.length,
      sku_id: sku.id,
      copies,
      snapshot: {
        doc,
        sku,
        values: resolveValues(doc, sku, mapping, { productionDate, batchNo, outlet }),
        mappingId: mappingRow.id,
        mappingVersion: mappingRow.version,
        productionDate,
        batchNo,
        outlet,
        templateVersion: saved.version,
      },
    });
  }
  const fingerprint = await hash(JSON.stringify(results));
  const stock: Record<string, number> = {};
  for (const p of results) {
    const key = `${p.snapshot.doc.media.widthMm}x${p.snapshot.doc.media.heightMm}`;
    stock[key] = (stock[key] ?? 0) + p.copies;
  }
  return { lines: results, total, stock, fingerprint };
}
