import { actorFrom, authRoutes, originCheck, peopleRoutes, userFrom } from './auth';
import { catalogueRoutes } from './catalogue';
import { fileRoutes } from './files';
import { jobRoutes, LabelJob } from './jobs';
import { raster } from './render';
import { audit, body, type Env, fail, HttpError, id, json, rows, stmt, text } from './types';

export { LabelJob };
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    let response: Response;
    const origin = request.headers.get('origin');
    try {
      const path = new URL(request.url).pathname;
      if (request.method === 'OPTIONS') response = new Response(null, { status: 204 });
      else {
        if (path === '/api/health') return json({ service: 'oplumo-label-studio-v2', version: 2 });
        const auth = await authRoutes(request, env, path);
        if (auth) response = auth;
        else {
          originCheck(request, env);
          const u = await userFrom(request, env);
          if (path === '/api/auth/me') {
            response = json({
              ...u,
              memberships: await rows(
                env,
                "SELECT m.workspace_id,m.role,w.name FROM memberships m JOIN workspaces w ON w.id=m.workspace_id WHERE m.user_id=? AND m.is_active=1 AND w.status='active'",
                u.id,
              ),
            });
          } else if (path === '/api/platform/workspaces') {
            if (!u.is_platform_admin) fail('只有平台管理员可管理租户', 403);
            if (request.method === 'GET')
              response = json(
                await rows(
                  env,
                  'SELECT id,name,status,created_at FROM workspaces ORDER BY created_at',
                ),
              );
            else if (request.method === 'POST') {
              const b = await body(request),
                wid = id();
              await env.DB.batch([
                stmt(env, 'INSERT INTO workspaces(id,name) VALUES(?,?)', wid, text(b.name)),
                stmt(env, "INSERT INTO memberships VALUES(?,?,'qa',1)", wid, u.id),
              ]);
              response = json({ id: wid }, 201);
            } else fail('不支持的操作', 405);
          } else {
            const a = await actorFrom(request, env);
            const preview = path.match(/^\/api\/(?:targets\/[^/]+\/)?templates\/([^/]+)\/preview$/);
            if (preview && request.method === 'POST') {
              if (a.role === 'worker') fail('请从已审核的批量任务打印', 403);
              const t = await stmt(
                env,
                'SELECT design_json,status FROM templates WHERE workspace_id=? AND id=?',
                a.workspaceId,
                preview[1],
              ).first<{ design_json: string; status: string }>();
              if (!t) fail('模板不存在', 404);
              response = new Response(
                (
                  await raster(
                    {
                      doc: JSON.parse(t.design_json),
                      values: await body<Record<string, string>>(request),
                    },
                    env,
                    a.workspaceId,
                  )
                ).buffer as ArrayBuffer,
                { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'private,no-store' } },
              );
            } else if (path === '/api/fonts') response = json({ families: ['DejaVu Sans'] });
            else if (path === '/api/targets')
              response = json([
                {
                  id: 'target_pdf_download',
                  name: '导出标签 PDF',
                  format: 'pdf',
                  delivery: 'download',
                },
                {
                  id: 'target_browser_print',
                  name: '浏览器打印',
                  format: 'browser-print-page',
                  delivery: 'browser-dialog',
                },
              ]);
            else if (path === '/api/history') response = json([]);
            else if (
              path.match(/^\/api\/targets\/[^/]+\/templates\/[^/]+\/history$/) &&
              request.method === 'POST'
            ) {
              await audit(env, a, 'browser.output-request', path, await body(request));
              response = json({ ok: true, note: '仅记录浏览器动作，实体打印需在任务页确认' });
            } else if (path === '/api/audit' && request.method === 'GET') {
              if (a.role === 'worker') fail('无权访问', 403);
              response = json(
                await rows(
                  env,
                  'SELECT * FROM audit_events WHERE workspace_id=? ORDER BY created_at DESC LIMIT 200',
                  a.workspaceId,
                ),
              );
            } else
              response =
                (await peopleRoutes(request, env, a, path)) ??
                (await catalogueRoutes(request, env, a, path)) ??
                (await fileRoutes(request, env, a, path)) ??
                (await jobRoutes(request, env, a, path)) ??
                json({ error: '接口不存在' }, 404);
          }
        }
      }
    } catch (e) {
      response = json(
        { error: e instanceof HttpError ? e.message : '操作失败，请检查数据或稍后重试' },
        e instanceof HttpError ? e.status : 500,
      );
      if (!(e instanceof HttpError)) console.error('V2 request failure', e);
    }
    const headers = new Headers(response.headers);
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('Referrer-Policy', 'no-referrer');
    if (origin === env.APP_ORIGIN) {
      headers.set('Access-Control-Allow-Origin', origin);
      headers.set('Access-Control-Allow-Credentials', 'true');
      headers.set('Vary', 'Origin');
      headers.set('Access-Control-Allow-Headers', 'Content-Type,X-Workspace-ID');
      headers.set('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    }
    return new Response(response.body, { status: response.status, headers });
  },
};
