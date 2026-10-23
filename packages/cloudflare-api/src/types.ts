import type { TemplateDoc } from '@labelprint/shared';
export interface Env {
  DB: D1Database;
  FILES: R2Bucket;
  JOBS: DurableObjectNamespace;
  APP_ORIGIN: string;
  LOCAL_DEV?: string;
  BOOTSTRAP_TOKEN?: string;
  FONT_KEY?: string;
}
export interface Actor {
  id: string;
  email: string;
  name: string;
  is_platform_admin: number;
  workspaceId: string;
  role: 'qa' | 'manager' | 'worker';
}
export interface Sku {
  id: string;
  sku_code: string;
  name: string;
  name_en: string;
  category: string;
  spec: string;
  barcode: string;
  weight: string;
  size_code: string;
  expiry_days: number | null;
  extra: string;
  version: number;
  is_active: number;
}
export type Binding =
  | { source: 'sku'; field: string }
  | { source: 'batch'; field: 'productionDate' | 'batchNo' | 'outlet' }
  | { source: 'date'; value: 'production' | 'expiry'; format: 'DD/MM/YYYY' | 'YYYY-MM-DD' }
  | { source: 'fixed'; value: string };
export interface Mapping {
  bindings: Record<string, Binding>;
  defaultTemplateId?: string;
  skuTemplates?: Record<string, string>;
  quantityMultiplier: number;
}
export interface Snapshot {
  doc: TemplateDoc;
  values: Record<string, string>;
  sku: Sku;
  mappingId: string;
  mappingVersion: number;
  productionDate: string;
  batchNo: string;
  outlet: string;
  templateVersion: number;
}
export const now = () => new Date().toISOString();
export const id = () => crypto.randomUUID();
export function fail(message: string, status = 400): never {
  throw new HttpError(message, status);
}
export class HttpError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
export const json = (data: unknown, status = 200, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });
export async function hash(value: string) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (x) => x.toString(16).padStart(2, '0')).join('');
}
export function text(value: unknown, max = 200) {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    fail(`需要有效文字（最多 ${max} 字）`);
  return value.trim();
}
export function integer(value: unknown, min = 1, max = Number.MAX_SAFE_INTEGER) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max)
    fail('数值必须为有效整数');
  return value;
}
export async function body<T = Record<string, unknown>>(request: Request): Promise<T> {
  const size = Number(request.headers.get('content-length') || 0);
  if (size > 2 * 1024 * 1024) fail('请求过大', 413);
  const raw = await request.text();
  if (raw.length > 2 * 1024 * 1024) fail('请求过大', 413);
  try {
    return JSON.parse(raw) as T;
  } catch {
    fail('JSON 格式不正确');
  }
}
export function edit(actor: Actor) {
  if (actor.role === 'worker') fail('Workers 只允许查看和打印', 403);
}
export async function audit(
  env: Env,
  a: Actor,
  action: string,
  entityId: string,
  detail: unknown = {},
) {
  await env.DB.prepare('INSERT INTO audit_events VALUES(?,?,?,?,?,?,?)')
    .bind(id(), a.workspaceId || null, a.id, action, entityId, now(), JSON.stringify(detail))
    .run();
}
export function stmt(env: Env, sql: string, ...values: unknown[]) {
  return env.DB.prepare(sql).bind(...values);
}
export async function rows<T>(env: Env, sql: string, ...values: unknown[]) {
  return (await stmt(env, sql, ...values).all<T>()).results;
}
