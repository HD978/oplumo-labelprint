import { type Actor, audit, body, type Env, fail, hash, id, json, rows, stmt, text } from './types';

const encode = (x: Uint8Array) => Array.from(x, (b) => b.toString(16).padStart(2, '0')).join('');
const decode = (x: string) => Uint8Array.from(x.match(/../g) ?? [], (h) => Number.parseInt(h, 16));
export async function passwordHash(
  password: string,
  salt = encode(crypto.getRandomValues(new Uint8Array(16))),
) {
  if (password.length < 12 || password.length > 128) fail('密码须为 12–128 个字符');
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: decode(salt), iterations: 100000, hash: 'SHA-256' },
    key,
    256,
  );
  return `pbkdf2$100000$${salt}$${encode(new Uint8Array(bits))}`;
}
async function verify(password: string, stored: string) {
  if (!stored.startsWith('pbkdf2$100000$')) return false;
  try {
    const got = await passwordHash(password, stored.split('$')[2]);
    let diff = got.length ^ stored.length;
    for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ stored.charCodeAt(i);
    return diff === 0;
  } catch {
    return false;
  }
}
export function originCheck(request: Request, env: Env) {
  if (
    !['GET', 'HEAD', 'OPTIONS'].includes(request.method) &&
    request.headers.get('origin') !== env.APP_ORIGIN
  )
    fail('请求来源未授权', 403);
}
const cookie = (env: Env, value: string, age = 43200) =>
  `oplumo_session=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${age}${env.LOCAL_DEV === 'true' ? '' : '; Secure'}`;
export async function authRoutes(request: Request, env: Env, path: string) {
  if (path === '/api/bootstrap' && request.method === 'POST') {
    if (
      !env.BOOTSTRAP_TOKEN ||
      request.headers.get('authorization') !== `Bearer ${env.BOOTSTRAP_TOKEN}`
    )
      fail('未授权', 401);
    const b = await body(request);
    const email = text(b.email).toLowerCase();
    const ph = await passwordHash(text(b.password, 128));
    const uid = id(),
      wid = id();
    const statements = [
      stmt(
        env,
        'INSERT INTO users(id,email,name,password_hash,is_platform_admin) SELECT ?,?,?,?,1 WHERE NOT EXISTS (SELECT 1 FROM users)',
        uid,
        email,
        text(b.name),
        ph,
      ),
      stmt(
        env,
        'INSERT INTO workspaces(id,name) SELECT ?,? WHERE EXISTS(SELECT 1 FROM users WHERE id=?)',
        wid,
        text(b.workspaceName),
        uid,
      ),
      stmt(
        env,
        "INSERT INTO memberships SELECT ?,?,'qa',1 WHERE EXISTS(SELECT 1 FROM users WHERE id=?)",
        wid,
        uid,
        uid,
      ),
    ];
    statements[2] = stmt(
      env,
      "INSERT INTO memberships SELECT ?,?,'qa',1 WHERE EXISTS(SELECT 1 FROM users WHERE id=?)",
      wid,
      uid,
      uid,
    );
    await env.DB.batch(statements);
    if (!(await stmt(env, 'SELECT id FROM users WHERE id=?', uid).first()))
      fail('平台已初始化', 409);
    return json({ workspaceId: wid, userId: uid }, 201);
  }
  if (path === '/api/auth/login' && request.method === 'POST') {
    originCheck(request, env);
    const b = await body(request);
    const email = text(b.email).toLowerCase(),
      password = text(b.password, 128);
    const key = await hash(`${request.headers.get('cf-connecting-ip') ?? 'local'}:${email}`);
    const ts = Date.now();
    await stmt(
      env,
      'INSERT INTO login_limits VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN expires_at<? THEN 1 ELSE attempts+1 END,expires_at=CASE WHEN expires_at<? THEN excluded.expires_at ELSE expires_at END',
      key,
      ts + 900000,
      ts,
      ts,
    ).run();
    const limit = await stmt(env, 'SELECT attempts FROM login_limits WHERE key=?', key).first<{
      attempts: number;
    }>();
    if (limit!.attempts > 10) fail('尝试过多，请稍后再试', 429);
    const user = await stmt(env, 'SELECT * FROM users WHERE email=? AND is_active=1', email).first<{
      id: string;
      password_hash: string;
    }>();
    const dummy = `pbkdf2$100000$00000000000000000000000000000000$${'0'.repeat(64)}`;
    const valid = await verify(password, user?.password_hash ?? dummy);
    if (!user || !valid) fail('账号或密码不正确', 401);
    const token = encode(crypto.getRandomValues(new Uint8Array(32)));
    await stmt(
      env,
      'INSERT INTO sessions VALUES(?,?,?)',
      await hash(token),
      user.id,
      ts + 43200000,
    ).run();
    return json({ ok: true }, 200, { 'Set-Cookie': cookie(env, token) });
  }
  if (path === '/api/auth/logout' && request.method === 'POST') {
    originCheck(request, env);
    const token = request.headers.get('cookie')?.match(/(?:^|;\s*)oplumo_session=([^;]+)/)?.[1];
    if (token) await stmt(env, 'DELETE FROM sessions WHERE token_hash=?', await hash(token)).run();
    return json({ ok: true }, 200, { 'Set-Cookie': cookie(env, '', 0) });
  }
}
export async function userFrom(request: Request, env: Env) {
  const token = request.headers.get('cookie')?.match(/(?:^|;\s*)oplumo_session=([^;]+)/)?.[1];
  if (!token) fail('请登录', 401);
  const u = await stmt(
    env,
    'SELECT u.id,u.email,u.name,u.is_platform_admin FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND u.is_active=1',
    await hash(token),
    Date.now(),
  ).first<Omit<Actor, 'workspaceId' | 'role'>>();
  if (!u) fail('登录已过期', 401);
  return u;
}
export async function actorFrom(request: Request, env: Env): Promise<Actor> {
  const u = await userFrom(request, env);
  const workspaceId =
    request.headers.get('X-Workspace-ID') ?? new URL(request.url).searchParams.get('workspace');
  if (!workspaceId) fail('请选择工作区', 400);
  const m = await stmt(
    env,
    "SELECT m.role FROM memberships m JOIN workspaces w ON w.id=m.workspace_id WHERE m.workspace_id=? AND m.user_id=? AND m.is_active=1 AND w.status='active'",
    workspaceId,
    u.id,
  ).first<{ role: Actor['role'] }>();
  if (!m) fail('无权访问此工作区', 403);
  return { ...u, workspaceId, role: m.role };
}
export async function peopleRoutes(request: Request, env: Env, a: Actor, path: string) {
  if (path === '/api/users' && request.method === 'GET')
    return json(
      await rows(
        env,
        'SELECT u.id,u.email,u.name,m.role,m.is_active FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=?',
        a.workspaceId,
      ),
    );
  if (path === '/api/users' && request.method === 'POST') {
    if (a.role !== 'qa') fail('只有 QA 可以添加人员', 403);
    const b = await body(request);
    const role = text(b.role);
    if (!['qa', 'manager', 'worker'].includes(role)) fail('角色不正确');
    const email = text(b.email).toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(email)) fail('邮箱不正确');
    if (await stmt(env, 'SELECT id FROM users WHERE email=?', email).first())
      fail('账号已存在；此版本不自动跨租户邀请已有账号', 409);
    const uid = id();
    await env.DB.batch([
      stmt(
        env,
        'INSERT INTO users(id,email,name,password_hash) VALUES(?,?,?,?)',
        uid,
        email,
        text(b.name),
        await passwordHash(text(b.password, 128)),
      ),
      stmt(env, 'INSERT INTO memberships VALUES(?,?,?,1)', a.workspaceId, uid, role),
    ]);
    await audit(env, a, 'user.create', uid, { role });
    return json({ id: uid }, 201);
  }
  const match = path.match(/^\/api\/users\/([^/]+)$/);
  if (match && request.method === 'PATCH') {
    if (a.role !== 'qa') fail('只有 QA 可以管理人员', 403);
    if (match[1] === a.id) fail('不能更改自己权限');
    const b = await body(request);
    const role = text(b.role);
    if (!['qa', 'manager', 'worker'].includes(role)) fail('角色不正确');
    await stmt(
      env,
      'UPDATE memberships SET role=?,is_active=? WHERE workspace_id=? AND user_id=?',
      role,
      b.is_active === false ? 0 : 1,
      a.workspaceId,
      match[1],
    ).run();
    await audit(env, a, 'user.update', match[1]!, b);
    return json({ ok: true });
  }
}
