import type { TemplateDoc } from './types.js';

/** Single-factory local workspace. Authentication/tenant routing belongs to a future service. */
export interface StudioLine {
  lineId: string;
  sku: string;
  quantity: number;
  unit: string;
}
export interface StudioOrder {
  source: string;
  orderId: string;
  revision: number;
  status: 'confirmed' | 'cancelled';
  outletId: string;
  deliveryDate: string;
  lines: StudioLine[];
}
export interface StudioRule {
  sku: string;
  unit: string;
  labelsPerUnit: number;
  templateId: string;
}
export interface StudioSettings {
  outlets: string[];
  rules: StudioRule[];
}
export interface StudioPlanLine {
  source: string;
  orderId: string;
  revision: number;
  lineId: string;
  outletId: string;
  deliveryDate: string;
  sku: string;
  quantity: number;
  unit: string;
  labels: number;
  templateId: string;
  widthMm: number;
  heightMm: number;
}
export interface StudioIssue {
  orderId: string;
  lineId: string;
  code: string;
}
export interface StudioPlan {
  deliveryDate: string;
  lines: StudioPlanLine[];
  issues: StudioIssue[];
  totalLabels: number;
  stock: { widthMm: number; heightMm: number; labels: number }[];
}
export interface StudioBatch {
  id: string;
  createdAt: string;
  approvedAt?: string;
  fingerprint: string;
  snapshot: { orders: StudioOrder[]; settings: StudioSettings; templates: TemplateDoc[] };
  plan: StudioPlan;
  status: 'review' | 'approved';
}
export interface StudioWorkspace {
  settings: StudioSettings;
  orders: StudioOrder[];
  batches: StudioBatch[];
  revisions: { receivedAt: string; order: StudioOrder }[];
}
export interface StudioBatchView extends StudioBatch {
  stale: boolean;
}
export interface StudioView extends Omit<StudioWorkspace, 'batches'> {
  batches: StudioBatchView[];
}
