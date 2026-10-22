export interface ExcelRow {
  file: string;
  sheet: string;
  row: number;
  cells: Record<string, string>;
}
export interface ExcelSheet {
  name: string;
  headers: string[];
  rows: ExcelRow[];
  error?: string;
}
export interface ExcelFile {
  name: string;
  sheets: ExcelSheet[];
}
export type BulkBinding = { column: string } | { value: string };
export interface BulkRequest {
  templateId: string;
  templateColumn: string;
  quantityColumn: string;
  bindings: Record<string, BulkBinding>;
  rows: ExcelRow[];
}
export interface BulkPreview {
  fingerprint: string;
  rows: number;
  labels: number;
  stock: { widthMm: number; heightMm: number; labels: number }[];
  previewPng: string;
}
export interface BulkRecord {
  id: string;
  createdAt: string;
  rows: number;
  labels: number;
  stock: BulkPreview['stock'];
  status: 'pdf-generated';
  format: 'pdf' | 'zip';
  files: string[];
}
