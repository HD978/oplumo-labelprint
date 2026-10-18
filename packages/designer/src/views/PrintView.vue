<script setup lang="ts">
import type { PrintTargetConfig } from '@labelprint/shared';
import {
  type LabelOrderRow,
  MAX_BATCH_LABELS,
  normalizeColumn,
  parseCsv,
  parseOrderRows,
} from '@labelprint/shared';
import {
  Copy,
  Eye,
  FileSpreadsheet,
  Maximize2,
  Printer as PrinterIcon,
  Settings,
  TerminalSquare,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-vue-next';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import IconButton from '../components/IconButton.vue';
import TargetSettingsDialog from '../components/TargetSettingsDialog.vue';
import { api } from '../lib/api';
import { t } from '../lib/i18n';
import { makeImagePdfBlob, pdfFileName } from '../lib/pdf';
import {
  loadHistory,
  printNow,
  printParams,
  printTemplate,
  saveTarget,
  selectPrintTemplate,
  state,
} from '../lib/store';
import { connectTsplWebBluetooth, type WebBluetoothSendProgress } from '../lib/webBluetooth';
import { connectTsplWebUsb } from '../lib/webUsb';

const frameEl = ref<HTMLDivElement | null>(null);
const previewUrl = ref('');
const previewBlob = ref<Blob | null>(null);
const previewKey = ref('');
const previewNatural = ref({ w: 0, h: 0 });
const frameSize = ref({ w: 0, h: 0 });
const previewZoom = ref<'fit' | number>('fit');
const busy = ref(false);
const msg = ref('');
const bluetoothProgress = ref<WebBluetoothSendProgress | null>(null);
const targetsOpen = ref(false);
const curlOpen = ref(false);
const curlCopied = ref(false);
const selectedCurlOrigin = ref('');
const customCurlOrigin = ref('');
const batchInput = ref<HTMLInputElement | null>(null);
const batchRows = ref<LabelOrderRow[]>([]);
const batchFileName = ref('');
const batchError = ref('');
const batchBusy = ref(false);
let debounce: ReturnType<typeof setTimeout> | undefined;
let ro: ResizeObserver | undefined;

const MIN_PREVIEW_ZOOM = 2;
const MAX_PREVIEW_ZOOM = 160;
const PREVIEW_ZOOM_STEP = 4;
// Screen previews and PDFs use a high-resolution raster. Physical TSPL jobs continue
// to render at the printer's configured DPI in the server print pipeline.
const PREVIEW_DPI = 600;
const fitPreviewPxPerMm = computed(() => {
  const tmpl = printTemplate.value;
  if (!tmpl) return 8;
  const availableW = Math.max(1, frameSize.value.w);
  const availableH = Math.max(1, frameSize.value.h);
  const naturalW = previewNatural.value.w || tmpl.media.widthMm * 8;
  const naturalH = previewNatural.value.h || tmpl.media.heightMm * 8;
  const scale = Math.max(0.1, Math.min(availableW / naturalW, availableH / naturalH));
  return Math.max(
    MIN_PREVIEW_ZOOM,
    Math.min(MAX_PREVIEW_ZOOM, (naturalW * scale) / tmpl.media.widthMm),
  );
});
const previewStyle = computed(() => {
  const tmpl = printTemplate.value;
  if (!tmpl) return {};
  if (previewZoom.value !== 'fit') {
    return { width: `${tmpl.media.widthMm * previewZoom.value}px` };
  }
  const availableW = Math.max(1, frameSize.value.w);
  const availableH = Math.max(1, frameSize.value.h);
  const naturalW = previewNatural.value.w || tmpl.media.widthMm * 8;
  const naturalH = previewNatural.value.h || tmpl.media.heightMm * 8;
  const scale = Math.max(0.1, Math.min(availableW / naturalW, availableH / naturalH));
  return { width: `${Math.floor(naturalW * scale)}px` };
});
const zoomLabel = computed(() =>
  previewZoom.value === 'fit' ? t('print.zoomFit') : `${previewZoom.value}px/mm`,
);
const bluetoothProgressPercent = computed(() => {
  const p = bluetoothProgress.value;
  if (!p?.totalBytes) return 0;
  return Math.max(0, Math.min(100, Math.round((p.sentBytes / p.totalBytes) * 100)));
});
const bluetoothProgressLabel = computed(() => {
  const p = bluetoothProgress.value;
  if (!p) return '';
  return t('print.bluetoothProgress', { sent: p.sentBytes, total: p.totalBytes });
});
const selectedTarget = computed<PrintTargetConfig | null>(
  () => state.targets.find((p) => p.id === state.printTargetId) ?? state.targets[0] ?? null,
);
const selectedTargetIsClient = computed(() => isClientTarget(selectedTarget.value));
const batchLabelCount = computed(() => batchRows.value.reduce((sum, row) => sum + row.qty, 0));
const curlHostOptions = computed(() => {
  const current = currentOrigin();
  const opts = [{ value: current, label: t('print.cliHostCurrent', { host: current }) }];
  try {
    const u = new URL(current);
    const suffix = u.port ? `:${u.port}` : '';
    const loopback = `${u.protocol}//127.0.0.1${suffix}`;
    if (loopback !== current)
      opts.push({ value: loopback, label: t('print.cliHostLoopback', { host: loopback }) });
  } catch {
    // Keep the current-origin option only.
  }
  return opts;
});
const curlOrigin = computed(() => {
  if (selectedCurlOrigin.value === '__custom')
    return normalizeOrigin(customCurlOrigin.value || currentOrigin());
  return selectedCurlOrigin.value || currentOrigin();
});
const curlCommand = computed(() => {
  const target = selectedTarget.value;
  const templateId = state.printTemplateId;
  const json = JSON.stringify(state.printValues, null, 2);
  return [
    'curl -X POST',
    shellQuote(`${curlOrigin.value}${printPath(target?.id ?? '', templateId, state.printCopies)}`),
    "-H 'Content-Type: application/json'",
    `--data ${shellQuote(json)}`,
  ].join(' \\\n  ');
});

function paramLabel(k: string): string {
  const d = printTemplate.value?.params.find((p) => p.key === k);
  return d?.label ? `${d.label} (${k})` : k;
}
function isMultiline(k: string): boolean {
  return !!printTemplate.value?.params.find((p) => p.key === k)?.multiline;
}
function isClientTarget(target: PrintTargetConfig | null | undefined): boolean {
  return (
    target?.delivery === 'download' ||
    target?.delivery === 'browser-dialog' ||
    target?.delivery === 'web-bluetooth' ||
    target?.delivery === 'web-usb'
  );
}
function onSelect(e: Event): void {
  selectPrintTemplate((e.target as HTMLSelectElement).value);
}
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
function currentOrigin(): string {
  return typeof window === 'undefined' ? 'http://localhost:5179' : window.location.origin;
}
function normalizeOrigin(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, '');
  if (!trimmed) return currentOrigin();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed;
  const protocol = typeof window === 'undefined' ? 'http:' : window.location.protocol;
  return `${protocol}//${trimmed}`;
}
function printPath(targetId: string, templateId: string, copies: number): string {
  return `/api/targets/${encodeURIComponent(targetId)}/templates/${encodeURIComponent(templateId)}/print?copies=${encodeURIComponent(copies || 1)}`;
}
function previewPath(targetId: string | undefined, templateId: string, dpi = PREVIEW_DPI): string {
  const path = !targetId
    ? `/api/templates/${encodeURIComponent(templateId)}/preview`
    : `/api/targets/${encodeURIComponent(targetId)}/templates/${encodeURIComponent(templateId)}/preview`;
  return `${path}?dpi=${dpi}`;
}
function renderJobPath(targetId: string, templateId: string, copies: number): string {
  return `/api/targets/${encodeURIComponent(targetId)}/templates/${encodeURIComponent(templateId)}/render-job?copies=${encodeURIComponent(copies || 1)}`;
}
function currentPreviewKey(): string {
  return `${selectedTarget.value?.id ?? ''}|${state.printTemplateId}|${JSON.stringify(state.printValues)}`;
}
function setPreviewBlob(blob: Blob): void {
  if (previewUrl.value) URL.revokeObjectURL(previewUrl.value);
  previewBlob.value = blob;
  previewKey.value = currentPreviewKey();
  previewUrl.value = URL.createObjectURL(blob);
  previewNatural.value = { w: 0, h: 0 };
}
function onPreviewLoad(e: Event): void {
  const img = e.target as HTMLImageElement;
  previewNatural.value = { w: img.naturalWidth, h: img.naturalHeight };
}
function zoom(delta: number): void {
  const current = previewZoom.value === 'fit' ? fitPreviewPxPerMm.value : previewZoom.value;
  const next = Math.round((current + delta * PREVIEW_ZOOM_STEP) / 2) * 2;
  previewZoom.value = Math.max(MIN_PREVIEW_ZOOM, Math.min(MAX_PREVIEW_ZOOM, next));
}
async function copyCurl(): Promise<void> {
  await navigator.clipboard.writeText(curlCommand.value);
  curlCopied.value = true;
  setTimeout(() => (curlCopied.value = false), 1200);
}

async function requestPreviewBlob(): Promise<Blob> {
  if (!state.printTemplateId) throw new Error(t('error.noTemplateSelected'));
  const res = await fetch(previewPath(selectedTarget.value?.id, state.printTemplateId), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(state.printValues),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.blob();
}

function spreadsheetCellText(value: unknown): string {
  if (value == null) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object') {
    const cell = value as { text?: string; result?: unknown; richText?: { text: string }[] };
    if (typeof cell.text === 'string') return cell.text;
    if (Array.isArray(cell.richText)) return cell.richText.map((part) => part.text).join('');
    if ('result' in cell) return spreadsheetCellText(cell.result);
  }
  return String(value);
}

async function importBatchFile(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  batchError.value = '';
  batchRows.value = [];
  batchFileName.value = '';
  batchBusy.value = true;
  try {
    let table: string[][];
    if (/\.csv$/i.test(file.name)) table = parseCsv(await file.text());
    else if (/\.xlsx$/i.test(file.name)) {
      const { readSheet } = await import('read-excel-file/browser');
      table = (await readSheet(file)).map((row) => row.map(spreadsheetCellText));
    } else throw new Error('Choose a .csv or .xlsx file.');
    batchRows.value = parseOrderRows(table, MAX_BATCH_LABELS);
    batchFileName.value = file.name;
    state.printValues = valuesForBatchRow(batchRows.value[0]!);
    await refreshPreview();
  } catch (e) {
    batchError.value = (e as Error).message;
  } finally {
    batchBusy.value = false;
    input.value = '';
  }
}

function valuesForBatchRow(row: LabelOrderRow): Record<string, string> {
  const values = { ...row.values };
  for (const key of printParams.value) {
    const definition = printTemplate.value?.params.find((param) => param.key === key);
    const value =
      row.values[normalizeColumn(key)] ??
      (definition?.label ? row.values[normalizeColumn(definition.label)] : undefined);
    if (value !== undefined) values[key] = value;
  }
  return values;
}

async function renderBatchPages(): Promise<
  Array<{ jpeg: Uint8Array; imageWidth: number; imageHeight: number }>
> {
  const templateId = state.printTemplateId;
  const target = selectedTarget.value;
  const template = printTemplate.value;
  if (!templateId || !template || !target) throw new Error(t('error.noTemplateSelected'));

  const rendered: Array<{ jpeg: Uint8Array; imageWidth: number; imageHeight: number } | undefined> =
    new Array(batchRows.value.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < batchRows.value.length) {
      const index = cursor++;
      const row = batchRows.value[index]!;
      const res = await fetch(previewPath(target.id, templateId), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(valuesForBatchRow(row)),
      });
      if (!res.ok) throw new Error(await res.text());
      const raster = await previewAsJpeg(await res.blob());
      rendered[index] = {
        jpeg: raster.jpeg,
        imageWidth: raster.width,
        imageHeight: raster.height,
      };
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, batchRows.value.length) }, worker));
  return batchRows.value.flatMap((row, index) =>
    Array.from({ length: row.qty }, () => rendered[index]!),
  );
}

async function recordBatchPrint(target: PrintTargetConfig): Promise<void> {
  for (const row of batchRows.value) {
    await api.recordClientPrint(target.id, state.printTemplateId, valuesForBatchRow(row), row.qty);
  }
  await loadHistory();
}

async function downloadBatchPdf(): Promise<void> {
  if (!batchRows.value.length || batchLabelCount.value > MAX_BATCH_LABELS) return;
  batchBusy.value = true;
  batchError.value = '';
  try {
    const pages = await renderBatchPages();
    const template = printTemplate.value!;
    const pdf = makeImagePdfBlob({
      ...pages[0]!,
      pageWidthMm: template.media.widthMm,
      pageHeightMm: template.media.heightMm,
      pages,
    });
    downloadBlob(
      pdf,
      pdfFileName(`${template.name}-${batchFileName.value.replace(/\.[^.]+$/, '')}`),
    );
    const target = state.targets.find(
      (item) => item.format === 'pdf' && item.delivery === 'download',
    );
    if (target) await recordBatchPrint(target);
    msg.value = `${pages.length} label pages generated.`;
  } catch (e) {
    batchError.value = (e as Error).message;
  } finally {
    batchBusy.value = false;
  }
}

async function printBatch(): Promise<void> {
  if (!batchRows.value.length || batchLabelCount.value > MAX_BATCH_LABELS) return;
  const target = state.targets.find((item) => item.delivery === 'browser-dialog');
  if (!target) {
    batchError.value = 'Add a Browser print dialog target before printing a batch.';
    return;
  }
  batchBusy.value = true;
  batchError.value = '';
  try {
    const pages = await renderBatchPages();
    const template = printTemplate.value!;
    const urls = pages.map((page) => {
      const bytes = page.jpeg.buffer.slice(
        page.jpeg.byteOffset,
        page.jpeg.byteOffset + page.jpeg.byteLength,
      ) as ArrayBuffer;
      return URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' }));
    });
    const frame = document.createElement('iframe');
    frame.style.position = 'fixed';
    frame.style.left = '-10000px';
    frame.style.top = '0';
    frame.style.width = '1px';
    frame.style.height = '1px';
    frame.style.border = '0';
    frame.setAttribute('aria-hidden', 'true');
    document.body.appendChild(frame);
    const doc = frame.contentDocument;
    if (!doc) throw new Error(t('print.browserPrintFailed'));
    const pageHtml = urls
      .map((url) => `<section class="page"><img alt="" src="${htmlEscape(url)}"></section>`)
      .join('');
    doc.open();
    doc.write(`<!doctype html><html><head><meta charset="utf-8"><title>${htmlEscape(template.name)}</title><style>
@page{size:${template.media.widthMm}mm ${template.media.heightMm}mm;margin:0}html,body{margin:0;padding:0;background:#fff}.page{width:${template.media.widthMm}mm;height:${template.media.heightMm}mm;overflow:hidden;page-break-after:always;break-after:page}.page:last-child{page-break-after:auto;break-after:auto}img{display:block;width:100%;height:100%;object-fit:fill}
</style></head><body>${pageHtml}</body></html>`);
    doc.close();
    await waitForPrintImages(doc);
    const cleanup = () => {
      urls.forEach((url) => {
        URL.revokeObjectURL(url);
      });
      frame.remove();
    };
    frame.contentWindow?.addEventListener('afterprint', () => setTimeout(cleanup, 500), {
      once: true,
    });
    setTimeout(cleanup, 60_000);
    frame.contentWindow?.focus();
    frame.contentWindow?.print();
    state.status = `${pages.length} label pages sent to the browser print dialog.`;
    await recordBatchPrint(target);
    msg.value = state.status;
  } catch (e) {
    batchError.value = (e as Error).message;
  } finally {
    batchBusy.value = false;
  }
}

async function ensurePreviewBlob(): Promise<Blob> {
  if (previewBlob.value && previewKey.value === currentPreviewKey()) return previewBlob.value;
  const blob = await requestPreviewBlob();
  setPreviewBlob(blob);
  return blob;
}

async function refreshPreview(): Promise<void> {
  if (!state.printTemplateId) return;
  busy.value = true;
  msg.value = '';
  try {
    setPreviewBlob(await requestPreviewBlob());
  } catch (e) {
    msg.value = t('print.previewFailed', { message: (e as Error).message });
  } finally {
    busy.value = false;
  }
}

function loadImage(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(t('print.imageLoadFailed')));
    };
    img.src = url;
  });
}

async function previewAsJpeg(
  blob: Blob,
): Promise<{ jpeg: Uint8Array; width: number; height: number }> {
  const img = await loadImage(blob);
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error(t('print.canvasUnavailable'));
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(img, 0, 0);
  const jpegBlob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error(t('print.pdfEncodeFailed')))),
      'image/jpeg',
      0.98,
    );
  });
  return {
    jpeg: new Uint8Array(await jpegBlob.arrayBuffer()),
    width: canvas.width,
    height: canvas.height,
  };
}

function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function downloadPdf(target: PrintTargetConfig): Promise<void> {
  const tmpl = printTemplate.value;
  if (!tmpl) throw new Error(t('error.noTemplateSelected'));
  const raster = await previewAsJpeg(await ensurePreviewBlob());
  const pdf = makeImagePdfBlob({
    jpeg: raster.jpeg,
    imageWidth: raster.width,
    imageHeight: raster.height,
    pageWidthMm: tmpl.media.widthMm,
    pageHeightMm: tmpl.media.heightMm,
    copies: state.printCopies,
  });
  downloadBlob(pdf, pdfFileName(tmpl.name));
  state.status = t('status.pdfDownloaded', { target: target.name });
  await recordClientPrint(target);
}

async function downloadTspl(target: PrintTargetConfig): Promise<void> {
  const tmpl = printTemplate.value;
  if (!tmpl) throw new Error(t('error.noTemplateSelected'));
  const res = await requestRenderedJob(target);
  downloadBlob(await res.blob(), `${pdfFileName(tmpl.name).replace(/\.pdf$/i, '')}.tspl`);
  state.status = t('status.tsplDownloaded', { target: target.name });
  await recordClientPrint(target);
}

async function requestRenderedJob(target: PrintTargetConfig): Promise<Response> {
  if (!state.printTemplateId) throw new Error(t('error.noTemplateSelected'));
  const res = await fetch(renderJobPath(target.id, state.printTemplateId, state.printCopies), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(state.printValues),
  });
  if (!res.ok) throw new Error(await res.text());
  return res;
}

async function printWebBluetoothTspl(target: PrintTargetConfig): Promise<void> {
  const connection = await connectTsplWebBluetooth(target);
  try {
    const res = await requestRenderedJob(target);
    const job = new Uint8Array(await res.arrayBuffer());
    const sent = await connection.write(job, (progress) => {
      bluetoothProgress.value = progress;
      msg.value = t('print.bluetoothProgress', {
        sent: progress.sentBytes,
        total: progress.totalBytes,
      });
    });
    state.status = t('status.bluetoothSent', {
      target: target.name,
      bytes: sent.bytes,
      device: sent.deviceName,
    });
    await recordClientPrint(target, { bytes: sent.bytes });
  } finally {
    connection.close();
  }
}

async function printWebUsbTspl(target: PrintTargetConfig): Promise<void> {
  const connection = await connectTsplWebUsb(target);
  try {
    const res = await requestRenderedJob(target);
    const job = new Uint8Array(await res.arrayBuffer());
    const sent = await connection.write(job);
    await rememberWebUsbDevice(target, connection.deviceInfo);
    state.status = t('status.webUsbSent', {
      target: target.name,
      bytes: sent.bytes,
      device: sent.deviceName,
    });
    await recordClientPrint(target, { bytes: sent.bytes });
  } finally {
    await connection.close();
  }
}

async function recordClientPrint(
  target: PrintTargetConfig,
  opts: { bytes?: number } = {},
): Promise<void> {
  if (!state.printTemplateId) return;
  try {
    await api.recordClientPrint(
      target.id,
      state.printTemplateId,
      state.printValues,
      state.printCopies,
      opts,
    );
    await loadHistory();
  } catch (e) {
    console.warn('Failed to record browser-managed print', e);
  }
}

async function rememberWebUsbDevice(
  target: PrintTargetConfig,
  info: { vendorId: number; productId: number; serialNumber?: string },
): Promise<void> {
  if (
    target.webUsbVendorId === info.vendorId &&
    target.webUsbProductId === info.productId &&
    target.webUsbSerialNumber === info.serialNumber
  ) {
    return;
  }
  await saveTarget({
    ...target,
    webUsbVendorId: info.vendorId,
    webUsbProductId: info.productId,
    webUsbSerialNumber: info.serialNumber,
  });
}

function htmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function waitForPrintImages(doc: Document): Promise<void> {
  const images = Array.from(doc.images);
  return Promise.all(
    images.map((img) =>
      img.complete
        ? Promise.resolve()
        : new Promise<void>((resolve, reject) => {
            img.onload = () => resolve();
            img.onerror = () => reject(new Error(t('print.imageLoadFailed')));
          }),
    ),
  ).then(() => undefined);
}

async function openBrowserPrint(target: PrintTargetConfig): Promise<void> {
  const tmpl = printTemplate.value;
  if (!tmpl) throw new Error(t('error.noTemplateSelected'));
  const blobUrl = URL.createObjectURL(await ensurePreviewBlob());
  const frame = document.createElement('iframe');
  frame.style.position = 'fixed';
  frame.style.left = '-10000px';
  frame.style.top = '0';
  frame.style.width = '1px';
  frame.style.height = '1px';
  frame.style.border = '0';
  frame.setAttribute('aria-hidden', 'true');
  document.body.appendChild(frame);

  const copies = Math.max(1, Math.min(999, Math.floor(state.printCopies || 1)));
  const page = `<section class="page"><img alt="" src="${htmlEscape(blobUrl)}"></section>`;
  const doc = frame.contentDocument;
  if (!doc) throw new Error(t('print.browserPrintFailed'));
  doc.open();
  doc.write(`<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${htmlEscape(tmpl.name)}</title>
<style>
@page { size: ${tmpl.media.widthMm}mm ${tmpl.media.heightMm}mm; margin: 0; }
html, body { margin: 0; padding: 0; background: #fff; }
.page { width: ${tmpl.media.widthMm}mm; height: ${tmpl.media.heightMm}mm; overflow: hidden; page-break-after: always; break-after: page; }
.page:last-child { page-break-after: auto; break-after: auto; }
img { display: block; width: 100%; height: 100%; object-fit: fill; }
</style>
</head>
<body>${Array.from({ length: copies }, () => page).join('')}</body>
</html>`);
  doc.close();

  await waitForPrintImages(doc);
  const cleanup = () => {
    URL.revokeObjectURL(blobUrl);
    frame.remove();
  };
  frame.contentWindow?.addEventListener('afterprint', () => setTimeout(cleanup, 500), {
    once: true,
  });
  setTimeout(cleanup, 60_000);
  frame.contentWindow?.focus();
  frame.contentWindow?.print();
  state.status = t('status.browserPrintOpened', { target: target.name });
  await recordClientPrint(target);
}

async function doPrint(): Promise<void> {
  busy.value = true;
  msg.value = '';
  bluetoothProgress.value = null;
  try {
    const target = selectedTarget.value;
    if (!target) throw new Error(t('error.noTargetSelected'));
    if (target.format === 'pdf' && target.delivery === 'download') await downloadPdf(target);
    else if (target.format === 'browser-print-page') await openBrowserPrint(target);
    else if (target.format === 'tspl-bitmap' && target.delivery === 'download')
      await downloadTspl(target);
    else if (target.format === 'tspl-bitmap' && target.delivery === 'web-bluetooth')
      await printWebBluetoothTspl(target);
    else if (target.format === 'tspl-bitmap' && target.delivery === 'web-usb')
      await printWebUsbTspl(target);
    else await printNow();
    msg.value = state.status;
  } catch (e) {
    msg.value = t('print.failed', { message: (e as Error).message });
  } finally {
    busy.value = false;
  }
}

// Auto-preview on template change and (debounced) on value edits.
watch(
  () => `${state.printTemplateId}|${JSON.stringify(state.printValues)}`,
  () => {
    if (!state.printTemplateId) return;
    clearTimeout(debounce);
    debounce = setTimeout(refreshPreview, 350);
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  if (previewUrl.value) URL.revokeObjectURL(previewUrl.value);
  ro?.disconnect();
});
onMounted(() => {
  selectedCurlOrigin.value = currentOrigin();
  ro = new ResizeObserver((entries) => {
    const box = entries[0]?.contentRect;
    if (box) frameSize.value = { w: box.width, h: box.height };
  });
  if (frameEl.value) ro.observe(frameEl.value);
});
</script>

<template>
  <div class="print">
    <aside class="form">
      <div class="form-head">
        <h2>{{ t('print.title') }}</h2>
        <span class="muted">{{ t('print.subtitle') }}</span>
      </div>

      <label class="template-picker block">{{ t('print.template') }}
        <select :value="state.printTemplateId" @change="onSelect">
          <option v-if="!state.templates.length" value="">{{ t('print.noTemplates') }}</option>
          <option v-for="t in state.templates" :key="t.id" :value="t.id">{{ t.name }}</option>
        </select>
      </label>

      <section class="batch-import">
        <div class="batch-heading">
          <h3>{{ t('print.batchTitle') }}</h3>
          <button type="button" class="ghost subtle" :disabled="batchBusy || !state.printTemplateId" @click="batchInput?.click()">
            <FileSpreadsheet :size="14" /> {{ t('print.batchImport') }}
          </button>
          <input ref="batchInput" class="batch-file" type="file" accept=".csv,.xlsx" @change="importBatchFile" />
        </div>
        <p v-if="!batchRows.length && !batchError" class="muted batch-note">{{ t('print.batchEmpty') }}</p>
        <p v-if="batchFileName" class="muted batch-file-name">{{ batchFileName }}</p>
        <p v-if="batchRows.length" class="muted batch-note">
          {{ t('print.batchCount', { rows: batchRows.length, labels: batchLabelCount }) }}
        </p>
        <div v-if="batchRows.length" class="batch-list">
          <div v-for="(row, index) in batchRows.slice(0, 5)" :key="`${row.sourceRow}-${index}`" class="batch-row">
            <span>{{ row.outlet }}</span><span>{{ row.sku }}</span><strong>×{{ row.qty }}</strong>
          </div>
          <div v-if="batchRows.length > 5" class="muted batch-more">+ {{ batchRows.length - 5 }} more order rows</div>
        </div>
        <div v-if="batchRows.length" class="batch-actions">
          <button type="button" :disabled="batchBusy" @click="downloadBatchPdf">
            <FileSpreadsheet :size="14" /> {{ t('print.batchPdf') }}
          </button>
          <button type="button" class="primary" :disabled="batchBusy" @click="printBatch">
            <PrinterIcon :size="14" /> {{ t('print.batchPrint') }}
          </button>
        </div>
        <p v-if="batchBusy" class="muted batch-note">{{ t('print.batchBusy') }}</p>
        <p v-if="batchError" class="batch-error" role="alert">{{ batchError }}</p>
      </section>

      <div class="params-region">
        <h3>{{ t('print.params') }}</h3>
        <div class="param-scroll">
          <p v-if="!printParams.length" class="muted">{{ t('print.noParams') }}</p>
          <label v-for="k in printParams" :key="k" class="block">
            {{ paramLabel(k) }}
            <textarea v-if="isMultiline(k)" class="multi" rows="3" v-model="state.printValues[k]"></textarea>
            <input v-else v-model="state.printValues[k]" />
          </label>
        </div>
      </div>

      <div class="print-controls">
        <div class="grid2">
          <label>{{ t('print.target') }}
            <select v-model="state.printTargetId">
              <option v-if="!state.targets.length" value="">{{ t('print.noTargets') }}</option>
              <option v-for="p in state.targets" :key="p.id" :value="p.id">{{ p.name }}</option>
            </select>
          </label>
          <label>{{ t('print.copies') }} <input type="number" min="1" v-model.number="state.printCopies" /></label>
        </div>
        <div class="secondary-actions">
          <button type="button" class="ghost subtle" @click="targetsOpen = true">
            <Settings :size="14" /> {{ t('print.manageTargets') }}
          </button>
          <button
            type="button"
            class="ghost subtle"
            :disabled="!state.printTemplateId || !selectedTarget || selectedTargetIsClient"
            :title="selectedTargetIsClient ? t('print.cliClientUnavailable') : ''"
            @click="curlOpen = true"
          >
            <TerminalSquare :size="14" /> {{ t('print.showCurl') }}
          </button>
        </div>

        <div class="actions">
          <button :disabled="busy" @click="refreshPreview"><Eye :size="15" /> {{ t('print.refreshPreview') }}</button>
          <button class="primary" :disabled="busy || !state.printTemplateId || !selectedTarget" @click="doPrint">
            <PrinterIcon :size="15" /> {{ t('common.print') }}
          </button>
        </div>
        <p v-if="msg" class="msg mono">{{ msg }}</p>
      </div>
    </aside>

    <section class="previewpane">
      <div class="preview-head">
        <div>
          <h2>{{ t('print.previewTitle') }}</h2>
          <p class="muted">{{ t('print.previewDescription') }}</p>
        </div>
        <div class="preview-tools">
          <span v-if="busy" class="busy">{{ t('print.generating') }}</span>
          <div v-if="bluetoothProgress" class="send-progress" role="status" :aria-label="bluetoothProgressLabel">
            <span class="mono">{{ bluetoothProgressLabel }}</span>
            <span class="progress-track">
              <span class="progress-fill" :style="{ width: `${bluetoothProgressPercent}%` }"></span>
            </span>
          </div>
          <div class="command-group">
            <IconButton :icon="ZoomOut" :label="t('print.zoomOut')" @click="zoom(-1)" />
            <span class="zoom mono">{{ zoomLabel }}</span>
            <IconButton :icon="ZoomIn" :label="t('print.zoomIn')" @click="zoom(1)" />
            <IconButton :icon="Maximize2" :label="t('print.zoomFit')" :active="previewZoom === 'fit'" @click="previewZoom = 'fit'" />
          </div>
        </div>
      </div>
      <div ref="frameEl" class="frame" :class="{ fit: previewZoom === 'fit', zoomed: previewZoom !== 'fit' }">
        <img v-if="previewUrl" :src="previewUrl" class="preview" :style="previewStyle" @load="onPreviewLoad" />
        <span v-else class="muted ph">{{ t('print.previewPlaceholder') }}</span>
      </div>
    </section>

    <TargetSettingsDialog :open="targetsOpen" @close="targetsOpen = false" />

    <div v-if="curlOpen" class="curl-overlay" @pointerdown.self="curlOpen = false">
      <section class="curl-dialog" role="dialog" aria-modal="true" :aria-label="t('print.curlTitle')">
        <header class="curl-head">
          <div class="curl-title">
            <TerminalSquare :size="18" :stroke-width="2" />
            <div>
            <h2>{{ t('print.curlTitle') }}</h2>
            <p class="muted">{{ t('print.curlDescription') }}</p>
            </div>
          </div>
          <button type="button" class="ghost curl-close" :aria-label="t('common.close')" @click="curlOpen = false">
            <X :size="17" />
          </button>
        </header>
        <div class="curl-options">
          <label class="host-select">{{ t('print.cliHost') }}
            <select v-model="selectedCurlOrigin">
              <option v-for="opt in curlHostOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
              <option value="__custom">{{ t('print.cliHostCustom') }}</option>
            </select>
          </label>
          <label v-if="selectedCurlOrigin === '__custom'" class="host-custom">{{ t('print.cliHostCustom') }}
            <input v-model="customCurlOrigin" :placeholder="t('print.cliHostPlaceholder')" />
          </label>
        </div>
        <section class="curl-code">
          <header>
            <span class="mono">curl</span>
            <button type="button" class="ghost copy-code" @click="copyCurl">
              <Copy :size="14" /> {{ curlCopied ? t('print.copiedCurl') : t('print.copyCurl') }}
            </button>
          </header>
          <pre class="curl mono">{{ curlCommand }}</pre>
        </section>
      </section>
    </div>
  </div>
</template>

<style scoped>
.print {
  flex: 1;
  display: grid;
  grid-template-columns: minmax(320px, 380px) minmax(0, 1fr);
  min-height: 0;
  overflow: hidden;
  gap: 20px;
  padding: 22px 24px;
  align-items: stretch;
}
.form {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 0;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 0;
  overflow: hidden;
  box-shadow: 0 1px 2px rgba(24, 32, 51, 0.04);
}
.form-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
  padding: 16px 16px 4px;
}
.form-head h2,
.preview-head h2 {
  margin: 0;
  font-size: 18px;
  line-height: 1.2;
}
.form-head span {
  font-size: 11px;
  text-align: right;
  max-width: 130px;
}
.template-picker {
  flex: none;
  padding: 0 16px;
}
.batch-import {
  flex: none;
  margin: 0 16px;
  padding: 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--panel-muted);
}
.batch-heading,
.batch-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.batch-heading h3 {
  margin: 0;
  font-size: 12px;
}
.batch-heading button,
.batch-actions button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  flex: 1;
  font-size: 11px;
}
.batch-heading button { flex: none; }
.batch-file { display: none; }
.batch-note,
.batch-file-name,
.batch-more {
  margin: 7px 0 0;
  font-size: 11px;
  line-height: 1.4;
}
.batch-file-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.batch-list {
  max-height: 108px;
  overflow: auto;
  margin-top: 7px;
  border-top: 1px solid var(--border);
}
.batch-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto;
  gap: 7px;
  padding: 5px 0;
  border-bottom: 1px solid var(--border);
  font-size: 11px;
}
.batch-row span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.batch-row strong { white-space: nowrap; }
.batch-actions { margin-top: 9px; }
.batch-error {
  margin: 8px 0 0;
  color: var(--danger, #b42318);
  font-size: 11px;
}
.params-region {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  border-top: 1px solid var(--border);
  padding: 12px 0 0;
}
.params-region h3 {
  flex: none;
  margin: 0;
  padding: 0 16px 8px;
  font-size: 11px;
  text-transform: uppercase;
  color: var(--muted);
}
.param-scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 0 16px 0;
}
.print-controls {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 16px 16px;
  border-top: 1px solid var(--border);
}
.grid2 {
  display: grid;
  grid-template-columns: 1fr 90px;
  gap: 10px;
}
.block {
  display: block;
  margin-top: 8px;
}
.block:first-child {
  margin-top: 0;
}
.multi {
  resize: vertical;
  min-height: 54px;
}
.actions {
  display: flex;
  gap: 10px;
  padding-top: 2px;
}
.actions button {
  flex: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
}
.secondary-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.subtle {
  min-height: 28px;
  padding: 4px 8px;
  color: var(--muted);
  font-size: 12px;
}
.msg {
  font-size: 11px;
  background: var(--panel-subtle);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 8px;
  word-break: break-all;
}
.previewpane {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
  min-height: 0;
}
.preview-head {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  align-items: flex-start;
  min-width: 0;
}
.preview-head p {
  margin: 5px 0 0;
}
.busy {
  color: var(--accent);
  background: var(--accent-soft);
  border: 1px solid var(--accent-border);
  border-radius: 999px;
  padding: 3px 9px;
  font-size: 12px;
  white-space: nowrap;
}
.preview-tools {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
  flex-wrap: wrap;
}
.send-progress {
  width: 210px;
  display: grid;
  gap: 4px;
  color: var(--text-soft);
  font-size: 11px;
}
.progress-track {
  display: block;
  height: 5px;
  overflow: hidden;
  background: var(--panel-subtle);
  border: 1px solid var(--border);
  border-radius: 999px;
}
.progress-fill {
  display: block;
  height: 100%;
  background: var(--accent);
  transition: width 120ms linear;
}
.command-group {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: none;
  padding: 3px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 8px;
}
.zoom {
  min-width: 68px;
  text-align: center;
  color: var(--muted);
  font-size: 11px;
}
/* Frame is intentionally a different colour from the label so the white paper edge
   is unambiguous — no white padding that could be mistaken for label margin. */
.frame {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  align-self: stretch;
  max-width: 100%;
  background:
    linear-gradient(var(--canvas-grid) 1px, transparent 1px),
    linear-gradient(90deg, var(--canvas-grid) 1px, transparent 1px),
    var(--canvas-bg);
  background-size: 24px 24px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.frame.zoomed {
  overflow: auto;
  align-items: flex-start;
  justify-content: flex-start;
}
.preview {
  flex: none;
  display: block;
  height: auto;
  max-width: none;
  image-rendering: pixelated;
  background: var(--paper);
  box-shadow: var(--shadow-paper);
  margin: auto;
}
.ph {
  margin: auto;
  padding: 28px 34px;
  background: var(--panel);
  border: 1px dashed var(--border-strong);
  border-radius: var(--radius);
}
.curl-overlay {
  position: fixed;
  inset: 0;
  z-index: 82;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 18px;
  background: rgba(15, 23, 42, 0.46);
}
.curl-dialog {
  width: min(760px, 94vw);
  max-height: 90vh;
  display: flex;
  flex-direction: column;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: 0 24px 70px rgba(15, 23, 42, 0.34);
  overflow: hidden;
}
.curl-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 16px 13px;
  border-bottom: 1px solid var(--border);
}
.curl-title {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  min-width: 0;
}
.curl-title > svg {
  margin-top: 2px;
  color: var(--accent);
  flex: none;
}
.curl-close {
  width: 30px;
  height: 30px;
  padding: 0;
  flex: none;
}
.curl-head h2 {
  margin: 0;
  font-size: 16px;
}
.curl-head p {
  margin: 4px 0 0;
}
.curl-options {
  display: grid;
  grid-template-columns: minmax(220px, 1fr) minmax(220px, 1fr);
  gap: 10px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
  background: var(--panel-subtle);
}
.host-select,
.host-custom {
  min-width: 0;
}
.curl-code {
  display: flex;
  min-height: 0;
  flex-direction: column;
  background: var(--field);
}
.curl-code header {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 42px;
  padding: 8px 12px 8px 16px;
  border-bottom: 1px solid var(--border);
  color: var(--muted);
}
.copy-code {
  margin-left: auto;
  min-height: 28px;
  padding: 4px 8px;
  color: var(--text-soft);
}
.curl {
  margin: 0;
  padding: 16px;
  flex: 1;
  min-height: 180px;
  max-height: 48vh;
  overflow: auto;
  white-space: pre-wrap;
  background: transparent;
  font-size: 12px;
}

@media (max-width: 860px) {
  .print {
    grid-template-columns: 1fr;
    grid-template-rows: minmax(220px, 28vh) minmax(0, 1fr);
    padding: 16px;
  }
  .previewpane {
    grid-row: 1;
    min-height: 0;
  }
  .form {
    grid-row: 2;
    min-height: 0;
  }
  .preview-head {
    flex-direction: column;
    gap: 10px;
  }
  .preview-tools {
    justify-content: flex-start;
  }
  .frame {
    flex: 1;
    min-height: 0;
    max-height: none;
  }
  .form {
    gap: 8px;
  }
  .form-head {
    padding: 12px 13px 2px;
  }
  .template-picker {
    padding: 0 13px;
  }
  .params-region {
    padding-top: 10px;
  }
  .params-region h3 {
    padding: 0 13px 6px;
  }
  .param-scroll {
    padding: 0 13px;
  }
  .print-controls {
    gap: 8px;
    padding: 10px 13px 13px;
  }
}

@media (max-width: 520px) {
  .print {
    padding: 12px;
  }
  .grid2 {
    grid-template-columns: 1fr;
  }
  .curl-overlay {
    padding: 10px;
  }
  .curl-options {
    grid-template-columns: 1fr;
  }
  .curl {
    max-height: 52vh;
  }
}
</style>
