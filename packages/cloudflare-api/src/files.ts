import { validateSku } from './mapping';
import {
  type Actor,
  audit,
  body,
  type Env,
  edit,
  fail,
  hash,
  id,
  json,
  now,
  rows,
  stmt,
} from './types';
export async function fileRoutes(request: Request, env: Env, a: Actor, path: string) {
  const w = a.workspaceId;
  if (path === '/api/assets' && request.method === 'GET')
    return json(
      await rows(
        env,
        'SELECT id,filename,file_type,size_bytes,created_at FROM assets WHERE workspace_id=? ORDER BY created_at DESC LIMIT 500',
        w,
      ),
    );
  if (path === '/api/assets' && request.method === 'POST') {
    edit(a);
    const length = Number(request.headers.get('content-length'));
    if (length > 21 * 1024 * 1024) fail('上传超过 20 MB', 413);
    const form = await request.formData();
    const f = form.get('file');
    if (!f || typeof f === 'string' || f.size > 20 * 1024 * 1024) fail('请选择不超过 20 MB 的文件');
    const ext = f.name.split('.').pop()?.toLowerCase() ?? '';
    if (!['pdf', 'png', 'jpg', 'jpeg', 'btw', 'json', 'xlsx', 'docx', 'ttf'].includes(ext))
      fail('文件格式不支持');
    const uid = id(),
      key = `${w}/originals/${uid}.${ext}`;
    await env.FILES.put(key, f.stream(), {
      httpMetadata: { contentType: f.type || 'application/octet-stream' },
    });
    await stmt(
      env,
      'INSERT INTO assets VALUES(?,?,?,?,?,?,?,?)',
      uid,
      w,
      f.name,
      key,
      ext,
      f.size,
      now(),
      a.id,
    ).run();
    await audit(env, a, 'asset.upload', uid);
    return json({ id: uid, src: `asset:${uid}` }, 201);
  }
  const asset = path.match(/^\/api\/assets\/([^/]+)\/file$/);
  if (asset && request.method === 'GET') {
    const f = await stmt(
      env,
      'SELECT * FROM assets WHERE workspace_id=? AND id=?',
      w,
      asset[1],
    ).first<{ r2_key: string; filename: string; file_type: string }>();
    if (!f) fail('文件不存在', 404);
    const parts = f.r2_key.split('/');
    if (parts[1] === 'generated') {
      const job = await stmt(
        env,
        'SELECT status FROM print_jobs WHERE workspace_id=? AND id=?',
        w,
        parts[2],
      ).first<{ status: string }>();
      if (job?.status !== 'completed') fail('任务尚未完成，不提供部分文件', 409);
    }
    const obj = await env.FILES.get(f.r2_key);
    if (!obj) fail('文件原稿不存在', 404);
    const safe = ['png', 'jpg', 'jpeg'].includes(f.file_type);
    const inlinePdf =
      f.file_type === 'pdf' &&
      f.r2_key.split('/')[1] === 'generated' &&
      new URL(request.url).searchParams.get('inline') === '1';
    return new Response(obj.body, {
      headers: {
        'Content-Type': safe
          ? `image/${f.file_type === 'png' ? 'png' : 'jpeg'}`
          : inlinePdf
            ? 'application/pdf'
            : 'application/octet-stream',
        'Content-Disposition': `${safe || inlinePdf ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.filename)}`,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, no-store',
      },
    });
  }
  if (path === '/api/imports/preview' && request.method === 'POST') {
    edit(a);
    const b = await body(request);
    if (!Array.isArray(b.rows) || !b.rows.length || b.rows.length > 500)
      fail('每次主档导入 1–500 行');
    const seen = new Set();
    const normalized = b.rows.map((r: Record<string, unknown>) => {
      const s = validateSku(r);
      if (seen.has(s.sku_code)) fail(`重复 SKU：${s.sku_code}`);
      seen.add(s.sku_code);
      return s;
    });
    const current = await rows<{ sku_code: string; id: string; version: number }>(
      env,
      'SELECT * FROM skus WHERE workspace_id=? ORDER BY sku_code',
      w,
    );
    const review = normalized.map((s) => {
      const old = current.find((c) => c.sku_code === s.sku_code);
      return {
        row: s,
        id: old?.id ?? id(),
        version: old?.version ?? 0,
        change: old
          ? Object.entries(s).some(
              ([key, value]) =>
                JSON.stringify((old as unknown as Record<string, unknown>)[key]) !==
                JSON.stringify(value),
            )
            ? 'update'
            : 'unchanged'
          : 'new',
      };
    });
    const uid = id(),
      fingerprint = await hash(JSON.stringify(current));
    await stmt(
      env,
      'INSERT INTO imports VALUES(?,?,?,?,?,?,?)',
      uid,
      w,
      JSON.stringify(review),
      'review',
      fingerprint,
      a.id,
      now(),
    ).run();
    return json(
      {
        id: uid,
        new: review.filter((r) => r.change === 'new').length,
        updated: review.filter((r) => r.change === 'update').length,
        unchanged: review.filter((r) => r.change === 'unchanged').length,
        rows: review,
      },
      201,
    );
  }
  const im = path.match(/^\/api\/imports\/([^/]+)\/apply$/);
  if (im && request.method === 'POST') {
    edit(a);
    const saved = await stmt(
      env,
      'SELECT * FROM imports WHERE workspace_id=? AND id=?',
      w,
      im[1],
    ).first<{ status: string; rows_json: string; base_hash: string }>();
    if (!saved) fail('导入记录不存在', 404);
    if (saved.status === 'applied') return json({ ok: true, reused: true });
    const current = await rows(env, 'SELECT * FROM skus WHERE workspace_id=? ORDER BY sku_code', w);
    if ((await hash(JSON.stringify(current))) !== saved.base_hash)
      fail('主档已改变，请重新上传核对', 409);
    const review = JSON.parse(saved.rows_json) as {
      id: string;
      version: number;
      row: Record<string, unknown>;
      change: string;
    }[];
    const q: D1PreparedStatement[] = [];
    const guard = () => {
      const gid = id();
      q.push(
        stmt(env, 'INSERT INTO mutation_checks VALUES(?,changes(),1)', gid),
        stmt(env, 'DELETE FROM mutation_checks WHERE id=?', gid),
      );
    };
    q.push(
      stmt(
        env,
        "UPDATE imports SET status='applied' WHERE workspace_id=? AND id=? AND status='review'",
        w,
        im[1],
      ),
    );
    guard();
    for (const r of review) {
      if (r.change === 'unchanged') continue;
      const s = validateSku(r.row);
      q.push(
        r.change === 'new'
          ? stmt(
              env,
              'INSERT INTO skus(id,workspace_id,sku_code,name,name_en,category,spec,barcode,weight,size_code,expiry_days,extra,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
              r.id,
              w,
              ...Object.values(s),
              now(),
            )
          : stmt(
              env,
              'UPDATE skus SET sku_code=?,name=?,name_en=?,category=?,spec=?,barcode=?,weight=?,size_code=?,expiry_days=?,extra=?,version=version+1,updated_at=? WHERE workspace_id=? AND id=? AND version=?',
              ...Object.values(s),
              now(),
              w,
              r.id,
              r.version,
            ),
      );
      guard();
    }
    await env.DB.batch(q);
    await audit(env, a, 'import.apply', im[1]!, { rows: review.length });
    return json({ ok: true });
  }
}
