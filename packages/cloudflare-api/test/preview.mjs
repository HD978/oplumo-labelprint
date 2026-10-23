// Disposable interactive QA fixture, not a production server. The only auto-login
// is a genuine session for synthetic local test data. No external account is used.

import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Log, LogLevel, Miniflare } from 'miniflare';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const app = path.resolve(root, '../studio-web/dist');
const origin = 'http://terminal.local:4173';
const mf = new Miniflare({
  modules: true,
  cf: false, // Never fetch Cloudflare request metadata; fixtures stay offline.
  scriptPath: path.join(root, 'dist/index.js'),
  modulesRules: [{ type: 'CompiledWasm', include: ['**/*.wasm'], fallthrough: true }],
  compatibilityDate: '2026-07-01',
  compatibilityFlags: ['nodejs_compat'],
  d1Databases: ['DB'],
  r2Buckets: ['FILES'],
  durableObjects: { JOBS: { className: 'LabelJob', useSQLite: true } },
  bindings: {
    APP_ORIGIN: origin,
    LOCAL_DEV: 'true',
    BOOTSTRAP_TOKEN: 'disposable-qa-fixture',
    FONT_KEY: '_system/font.ttf',
  },
  log: new Log(LogLevel.ERROR),
});
const db = await mf.getD1Database('DB'),
  bucket = await mf.getR2Bucket('FILES');
await db.exec(
  (await readFile(path.join(root, 'migrations/0001_v2.sql'), 'utf8')).replace(/\n/g, ' '),
);
await bucket.put(
  '_system/font.ttf',
  await readFile('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'),
);
async function api(route, body, auth = {}) {
  const r = await mf.dispatchFetch(origin + route, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw Error(`${route} ${r.status}`);
  return r;
}
await api(
  '/api/bootstrap',
  {
    email: 'qa@factory.example',
    password: 'disposable-qa-password',
    name: 'QA 演示账号',
    workspaceName: 'OPLUMO 测试工厂',
  },
  { Authorization: 'Bearer disposable-qa-fixture' },
);
const login = await api('/api/auth/login', {
  email: 'qa@factory.example',
  password: 'disposable-qa-password',
});
const sessionCookie = login.headers.get('set-cookie').split(';')[0];
createServer(async (req, res) => {
  try {
    if (req.url.startsWith('/api/')) {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = Buffer.concat(chunks);
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers))
        if (v) headers.set(k, Array.isArray(v) ? v.join(',') : v);
      const r = await mf.dispatchFetch(origin + req.url, {
        method: req.method,
        headers,
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : body,
      });
      res.writeHead(r.status, Object.fromEntries(r.headers));
      res.end(Buffer.from(await r.arrayBuffer()));
      return;
    }
    const u = new URL(req.url, origin);
    let file = path.resolve(app, '.' + decodeURIComponent(u.pathname));
    if (!file.startsWith(app)) throw Error('Invalid path');
    try {
      if (!(await stat(file)).isFile()) file = path.join(app, 'index.html');
    } catch {
      file = path.join(app, 'index.html');
    }
    const ext = path.extname(file),
      mime =
        {
          '.html': 'text/html',
          '.js': 'application/javascript',
          '.css': 'text/css',
          '.mjs': 'application/javascript',
          '.png': 'image/png',
        }[ext] ?? 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': mime,
      ...(ext === '.html'
        ? { 'Set-Cookie': sessionCookie + '; HttpOnly; SameSite=Lax; Path=/' }
        : {}),
    });
    res.end(await readFile(file));
  } catch (e) {
    res.writeHead(500);
    res.end(String(e.message));
  }
}).listen(Number(process.env.PORT ?? 4173), '0.0.0.0', () =>
  console.log('Disposable V2 QA preview ready'),
);
