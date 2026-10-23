import { reactive } from 'vue';
export interface Me {
  id: string;
  name: string;
  email: string;
  is_platform_admin: number;
  memberships: { workspace_id: string; name: string; role: 'qa' | 'manager' | 'worker' }[];
}
export const account = reactive({
  me: null as Me | null,
  workspace: localStorage.getItem('oplumo.workspace') ?? '',
  loading: true,
});
const nativeFetch = window.fetch.bind(window);
export function installApi() {
  window.fetch = async (input, init) => {
    if (typeof input !== 'string' || !input.startsWith('/api/')) return nativeFetch(input, init);
    const headers = new Headers(init?.headers);
    if (account.workspace) headers.set('X-Workspace-ID', account.workspace);
    let data = init?.body;
    if (typeof data === 'string' && /\/api\/templates\//.test(input)) {
      const doc = JSON.parse(data);
      for (const e of doc.elements ?? []) {
        if (e.type === 'image' && e.src.startsWith('/api/assets/'))
          e.src = `asset:${e.src.split('/')[3]}`;
      }
      data = JSON.stringify(doc);
    }
    const response = await nativeFetch(input, {
      ...init,
      headers,
      body: data,
      credentials: 'include',
    });
    if (input === '/api/templates' && response.ok) {
      const docs = await response.json();
      for (const doc of docs)
        for (const e of doc.elements ?? []) {
          if (e.type === 'image' && e.src.startsWith('asset:'))
            e.src = `/api/assets/${e.src.slice(6)}/file?workspace=${encodeURIComponent(account.workspace)}`;
        }
      return new Response(JSON.stringify(docs), {
        status: response.status,
        headers: response.headers,
      });
    }
    return response;
  };
}
export async function api<T = any>(path: string, method = 'GET', data?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: data === undefined ? {} : { 'Content-Type': 'application/json' },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? '请求失败');
  return result;
}
export async function who() {
  try {
    account.me = await api<Me>('/api/auth/me');
    if (!account.me.memberships.some((m) => m.workspace_id === account.workspace))
      account.workspace = account.me.memberships[0]?.workspace_id ?? '';
    localStorage.setItem('oplumo.workspace', account.workspace);
  } catch {
    account.me = null;
  } finally {
    account.loading = false;
  }
}
export const role = () =>
  account.me?.memberships.find((m) => m.workspace_id === account.workspace)?.role;
export function fileUrl(id: string) {
  return `/api/assets/${id}/file?workspace=${encodeURIComponent(account.workspace)}`;
}

export function requestId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 15) | 64;
  bytes[8] = (bytes[8]! & 63) | 128;
  const h = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
