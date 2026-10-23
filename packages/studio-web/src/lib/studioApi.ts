import type { StudioBatch, StudioPlan, StudioSettings, StudioView } from '@labelprint/shared';

async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`/api/studio${path}`, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? 'Workspace request failed');
  return result as T;
}
export const studioApi = {
  view: () => request<StudioView>(''),
  settings: (value: unknown) => request<StudioSettings>('/settings', 'PUT', value),
  ingest: (value: unknown) => request<{ imported: number }>('/orders', 'POST', value),
  preview: (deliveryDate: string) => request<StudioPlan>('/preview', 'POST', { deliveryDate }),
  prepare: (deliveryDate: string) => request<StudioBatch>('/batches', 'POST', { deliveryDate }),
  approve: (id: string) =>
    request<StudioBatch>(`/batches/${encodeURIComponent(id)}/approve`, 'POST'),
};
