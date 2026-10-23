import {
  applyParams,
  type BulkPreview,
  type BulkRecord,
  type BulkRequest,
  collectParams,
  compileToSvg,
  type ExcelFile,
  syncParamDefs,
  type TemplateDoc,
} from '@labelprint/shared';
import { sha256 } from '@noble/hashes/sha256';
import bwipjs from 'bwip-js';
import JSZip from 'jszip';
import { PDFDocument } from 'pdf-lib';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

function newId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 15) | 64;
  bytes[8] = (bytes[8]! & 63) | 128;
  const h = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
const originalFetch = window.fetch.bind(window);
let database: Promise<IDBDatabase>;
export function db() {
  database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('oplumo-label-studio-demo-v1', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('data');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return database;
}
export async function getSaved<T>(key: string): Promise<T | undefined> {
  const store = await db();
  return new Promise((resolve, reject) => {
    const req = store.transaction('data').objectStore('data').get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
export async function saveSaved(key: string, value: unknown) {
  const store = await db();
  return new Promise<void>((resolve, reject) => {
    const tx = store.transaction('data', 'readwrite');
    tx.objectStore('data').put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
export interface SourceFile {
  id: string;
  name: string;
  type: string;
  url?: string;
  thumbnail?: string;
  bytes: number;
  pages?: number;
  data?: Blob;
  sources?: string[];
  widthMm?: number;
  heightMm?: number;
}
export async function sourceFiles(): Promise<SourceFile[]> {
  const bundled = await originalFetch('/source-catalogue.json').then((r) => r.json());
  return [...((await getSaved<SourceFile[]>('files')) ?? []), ...bundled];
}
export async function downloadSource(file: SourceFile) {
  if (file.data) {
    download(file.data, file.name);
  } else if (file.url) {
    const res = await originalFetch(file.url);
    if (!res.ok) throw Error('文件读取失败');
    download(await res.blob(), file.name);
  }
}
export function download(blob: Blob, name: string) {
  const old = document.querySelector('[data-download-tray]');
  if (old) {
    const a = old.querySelector('a');
    if (a) URL.revokeObjectURL(a.href);
    old.remove();
  }
  const url = URL.createObjectURL(blob);
  const tray = document.createElement('aside');
  tray.dataset.downloadTray = 'true';
  tray.setAttribute('role', 'status');
  Object.assign(tray.style, {
    position: 'fixed',
    bottom: '20px',
    right: '20px',
    zIndex: '9999',
    maxWidth: 'min(440px,90vw)',
    background: '#fff',
    color: '#12203a',
    padding: '16px',
    border: '1px solid #cbdcf8',
    borderRadius: '10px',
    boxShadow: '0 8px 30px #0a214122',
    font: '13px sans-serif',
  });
  const title = document.createElement('div');
  title.textContent = '文件已准备好，点击下载：';
  title.style.marginBottom = '8px';
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.textContent = name;
  a.style.color = '#1f6feb';
  a.style.overflowWrap = 'anywhere';
  const view = document.createElement('a');
  if (blob.type === 'application/pdf') {
    view.href = url;
    view.target = '_blank';
    view.rel = 'noopener';
    view.textContent = '打开 PDF / 打印';
    view.style.display = 'block';
    view.style.marginTop = '10px';
  }
  const close = document.createElement('button');
  close.textContent = '关闭';
  close.style.marginLeft = '12px';
  close.onclick = () => {
    tray.remove();
    URL.revokeObjectURL(url);
  };
  tray.append(title, a, view, close);
  document.body.append(tray);
}
let mutation: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>) {
  const next = mutation.then(fn, fn);
  mutation = next.catch(() => undefined);
  return next;
}
export async function templates(): Promise<TemplateDoc[]> {
  let data = await getSaved<TemplateDoc[]>('templates');
  if (!data) {
    data = await originalFetch('/seed-templates.json').then((r) => r.json());
    await saveSaved('templates', data);
  }
  return data!;
}
function checkTemplate(doc: TemplateDoc) {
  if (
    !doc?.id ||
    typeof doc.name !== 'string' ||
    !Array.isArray(doc.elements) ||
    doc.elements.length > 500 ||
    !Number.isFinite(doc.media?.widthMm) ||
    !Number.isFinite(doc.media?.heightMm) ||
    doc.media.widthMm <= 0 ||
    doc.media.heightMm <= 0 ||
    doc.media.widthMm > 300 ||
    doc.media.heightMm > 300
  )
    throw Error('标签格式不正确，尺寸须为 0–300 mm');
  doc.params = syncParamDefs(doc);
  return doc;
}
export async function saveTemplate(doc: TemplateDoc) {
  return serial(async () => {
    checkTemplate(doc);
    const all = await templates();
    const index = all.findIndex((t) => t.id === doc.id);
    const next = { ...structuredClone(doc), updatedAt: new Date().toISOString() };
    if (index < 0) all.push(next);
    else all[index] = next;
    await saveSaved('templates', all);
    return next;
  });
}
export async function portableTemplate(doc: TemplateDoc) {
  const result = JSON.parse(JSON.stringify(doc)) as TemplateDoc;
  for (const el of result.elements) {
    if (
      el.type === 'image' &&
      (el.src.startsWith('/label-assets/') || el.src.startsWith('/api/assets/'))
    )
      el.src = await blobDataUrl(await originalFetch(el.src).then((r) => r.blob()));
  }
  return result;
}
export async function exportDesign(doc: TemplateDoc) {
  download(
    new Blob([JSON.stringify(await portableTemplate(doc), null, 2)], { type: 'application/json' }),
    `${doc.name.replace(/[\\/:*?"<>|]/g, '-')}.label.json`,
  );
}
export async function exportBackup() {
  const all = await templates();
  const portable = [];
  for (const doc of all) portable.push(await portableTemplate(doc));
  download(
    new Blob([JSON.stringify({ version: 1, templates: portable })], { type: 'application/json' }),
    'OPLUMO-label-workspace-backup.json',
  );
}
export function blobDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
const dataImages = new Map<string, string>();
export async function renderLabel(
  doc: TemplateDoc,
  values: Record<string, string>,
  strict = false,
): Promise<Blob> {
  const assets: Record<string, string> = {};
  for (const el of doc.elements) {
    if (el.type === 'image') {
      let value = applyParams(el.src, values, doc);
      if (value.startsWith('/label-assets/') || value.startsWith('/api/assets/')) {
        if (!dataImages.has(value))
          dataImages.set(
            value,
            await blobDataUrl(await originalFetch(value).then((r) => r.blob())),
          );
        value = dataImages.get(value)!;
      }
      if (!/^data:image\//.test(value)) throw Error('图片须为已上传图片，暂不读取外部图片网址');
      assets[el.id] = value;
    }
    if (el.type === 'barcode' || el.type === 'qrcode') {
      const value = applyParams(el.value, values, doc).trim();
      if (!value && !strict) continue;
      try {
        const canvas = document.createElement('canvas');
        bwipjs.toCanvas(canvas, {
          bcid: el.type === 'qrcode' ? 'qrcode' : el.symbology,
          text: value,
          scale: 4,
          height: 12,
          includetext: el.type === 'barcode' && !!el.showText,
        });
        assets[el.id] = canvas.toDataURL('image/png');
      } catch {
        throw Error(`条码／二维码无法生成：${el.id}`);
      }
    }
  }
  const svg = compileToSvg(doc, { values, assets, placeholders: false });
  const image = new Image();
  image.src = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(doc.media.widthMm * 12);
    canvas.height = Math.ceil(doc.media.heightMm * 12);
    if (canvas.width * canvas.height > 16_000_000) throw Error('标签尺寸过大');
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(Error('无法生成预览'))), 'image/png'),
    );
  } finally {
    URL.revokeObjectURL(image.src);
  }
}
export async function labelPdf(doc: TemplateDoc, values: Record<string, string>, copies: number) {
  for (const key of collectParams(doc))
    if (!(values[key] ?? '').trim()) throw Error(`请填写 ${key}`);
  if (!Number.isInteger(copies) || copies < 1 || copies > 999) throw Error('份数须为 1–999');
  const png = await renderLabel(doc, values, true);
  const pdf = await PDFDocument.create();
  const img = await pdf.embedPng(await png.arrayBuffer());
  for (let i = 0; i < copies; i++) {
    const page = pdf.addPage([(doc.media.widthMm * 72) / 25.4, (doc.media.heightMm * 72) / 25.4]);
    page.drawImage(img, { x: 0, y: 0, width: page.getWidth(), height: page.getHeight() });
  }
  return new Blob([(await pdf.save()) as BlobPart], { type: 'application/pdf' });
}
export async function uploadFiles(files: File[]) {
  if (files.length > 20) throw Error('一次最多上传 20 个文件');
  for (const file of files) {
    if (file.size > 20 * 1024 * 1024) throw Error('单个文件最多 20 MB');
    const ext = file.name.split('.').pop()?.toLowerCase();
    const id = newId();
    if (ext === 'json') {
      const content = JSON.parse(await file.text());
      const docs = Array.isArray(content.templates) ? content.templates : [content];
      for (const doc of docs) {
        doc.id = newId();
        doc.name = `${doc.name} · 导入`;
        await saveTemplate(checkTemplate(doc));
      }
    } else if (ext === 'pdf') {
      const pdfjs = await import('pdfjs-dist');
      pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
      const bytes = await file.arrayBuffer();
      const pdf = await pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false })
        .promise;
      if (pdf.numPages > 30)
        throw Error('PDF 导入设计一次最多 30 页，请先拆分；原始资料库可查看更大的 PDF');
      for (let n = 1; n <= pdf.numPages; n++) {
        const page = await pdf.getPage(n);
        const viewport = page.getViewport({ scale: 300 / 72 });
        if (viewport.width * viewport.height > 16_000_000) throw Error('PDF 页尺寸过大');
        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        await page.render({ canvasContext: canvas.getContext('2d')!, viewport }).promise;
        const base = page.getViewport({ scale: 1 });
        await saveTemplate({
          id: `${id}-${n}`,
          name: `${file.name} · ${n}`,
          version: 1,
          media: {
            widthMm: (base.width * 25.4) / 72,
            heightMm: (base.height * 25.4) / 72,
            type: 'gap',
            gapMm: 2,
          },
          params: [],
          defaults: {},
          elements: [
            {
              id: 'background',
              type: 'image',
              x: 0,
              y: 0,
              w: (base.width * 25.4) / 72,
              h: (base.height * 25.4) / 72,
              src: canvas.toDataURL('image/png'),
              locked: true,
            },
          ],
          sourceType: '上传 PDF 背景（可叠加编辑）',
        } as TemplateDoc);
      }
    } else if (['png', 'jpg', 'jpeg'].includes(ext ?? '')) {
      const image = await blobDataUrl(file);
      await saveTemplate({
        id,
        name: file.name,
        version: 1,
        media: { widthMm: 100, heightMm: 150, type: 'gap', gapMm: 2 },
        params: [],
        defaults: {},
        elements: [
          { id: 'image', type: 'image', x: 0, y: 0, w: 100, h: 150, src: image, locked: false },
        ],
      } as TemplateDoc);
    } else if (ext !== 'btw') throw Error('可导入 JSON、PDF、PNG、JPG；BTW 可保存为原始资料');
    const existing = (await getSaved<SourceFile[]>('files')) ?? [];
    existing.unshift({ id, name: file.name, type: ext ?? '', bytes: file.size, data: file });
    await saveSaved('files', existing);
  }
}
async function readWorkbook(file: Blob, name: string): Promise<ExcelFile> {
  if (!name.toLowerCase().endsWith('.xlsx') || file.size > 2 * 1024 * 1024)
    throw Error('请使用不超过 2 MB 的 .xlsx');
  const Excel = await import('exceljs');
  const wb = new Excel.Workbook();
  await wb.xlsx.load(await file.arrayBuffer());
  const sheets = wb.worksheets.filter((s) => s.state === 'visible');
  if (sheets.length > 10) throw Error('最多 10 个可见工作表');
  return {
    name,
    sheets: sheets.map((sheet) => {
      try {
        if (sheet.rowCount > 501 || sheet.columnCount > 64)
          throw Error('工作表最多 500 行数据、64 栏');
        const value = (r: number, c: number) => {
          const cell = sheet.getCell(r, c);
          if (cell.isMerged) throw Error('请先取消合并单元格');
          let v = cell.value;
          if (v && typeof v === 'object' && ('formula' in v || 'sharedFormula' in v)) {
            if (v.result === undefined) throw Error('公式需先在 Excel 重算并保存');
            v = v.result;
          }
          if (v instanceof Date) return v.toISOString().slice(0, 10);
          if (v && typeof v === 'object' && 'error' in v) throw Error('单元格包含错误');
          if (v && typeof v === 'object' && 'richText' in v)
            return v.richText.map((x) => x.text).join('');
          if (v && typeof v === 'object' && 'text' in v) return v.text;
          const s = v === null ? '' : String(v ?? '');
          if (s.length > 1000) throw Error('单元格超过1000字');
          if (typeof v === 'number' && Number.isInteger(v) && /^0+$/.test(cell.numFmt))
            return String(v).padStart(cell.numFmt.length, '0');
          return s;
        };
        const headers = Array.from({ length: sheet.columnCount }, (_, i) => value(1, i + 1).trim());
        if (!headers.length || headers.some((h) => !h) || new Set(headers).size !== headers.length)
          throw Error('第一行需为不重复栏位名');
        const rows = [];
        for (let r = 2; r <= sheet.rowCount; r++) {
          const cells = Object.fromEntries(headers.map((h, i) => [h, value(r, i + 1)]));
          if (Object.values(cells).some((v) => v.trim()))
            rows.push({ file: name, sheet: sheet.name, row: r, cells });
        }
        return { name: sheet.name, headers, rows };
      } catch (e) {
        return { name: sheet.name, headers: [], rows: [], error: String((e as Error).message) };
      }
    }),
  };
}
async function bulkPlan(input: BulkRequest) {
  if (!input.rows?.length || input.rows.length > 500) throw Error('请选择 1–500 行数据');
  const docs = await templates();
  const lines = [];
  const stock: BulkPreview['stock'] = [];
  let labels = 0;
  for (const row of input.rows) {
    const cell = (key: string) => {
      if (!Object.hasOwn(row.cells, key))
        throw Error(`${row.file} 第 ${row.row} 行缺少栏位：${key}`);
      return row.cells[key]!;
    };
    const id = input.templateColumn ? cell(input.templateColumn).trim() : input.templateId;
    const doc = docs.find((d) => d.id === id);
    if (!doc) throw Error(`找不到模板：${id}`);
    const quantity = input.quantityColumn ? cell(input.quantityColumn).trim() : '1';
    if (!/^\d+$/.test(quantity) || Number(quantity) < 1 || Number(quantity) > 2000)
      throw Error(`第 ${row.row} 行标签份数不正确`);
    const copies = Number(quantity);
    labels += copies;
    if (labels > 2000) throw Error('Sites 演示一次最多生成 2000 张标签');
    const values: Record<string, string> = {};
    for (const key of collectParams(doc)) {
      const binding = input.bindings[key];
      if (!binding) throw Error(`缺少字段对应：${key}`);
      const v = 'column' in binding ? cell(binding.column) : binding.value;
      if (!v?.trim()) throw Error(`${row.file} 第 ${row.row} 行缺少 ${key}`);
      values[key] = v;
    }
    lines.push({ doc, values, copies });
    let group = stock.find(
      (s) => s.widthMm === doc.media.widthMm && s.heightMm === doc.media.heightMm,
    );
    if (!group) {
      group = { widthMm: doc.media.widthMm, heightMm: doc.media.heightMm, labels: 0 };
      stock.push(group);
    }
    group.labels += copies;
  }
  const hash = sha256(
    new TextEncoder().encode(JSON.stringify({ input, docs: lines.map((l) => l.doc) })),
  );
  const fingerprint = Array.from(hash, (b) => b.toString(16).padStart(2, '0')).join('');
  return { lines, stock, labels, fingerprint };
}
async function bulkPreview(input: BulkRequest) {
  const p = await bulkPlan(input);
  return {
    fingerprint: p.fingerprint,
    stock: p.stock,
    rows: p.lines.length,
    labels: p.labels,
    previewPng: await blobDataUrl(await renderLabel(p.lines[0]!.doc, p.lines[0]!.values, true)),
  };
}
async function bulkPdf(input: BulkRequest, fingerprint: string) {
  const p = await bulkPlan(input);
  if (p.fingerprint !== fingerprint) throw Error('数据或模板已改变，请重新预览');
  const cached = await getSaved<{ blob: Blob; record: BulkRecord }>(`export-${fingerprint}`);
  if (cached) return cached;
  const outputs = [];
  let pixels = 0;
  for (const group of p.stock) {
    const pdf = await PDFDocument.create();
    for (const line of p.lines.filter(
      (l) => l.doc.media.widthMm === group.widthMm && l.doc.media.heightMm === group.heightMm,
    )) {
      pixels += line.doc.media.widthMm * 12 * line.doc.media.heightMm * 12;
      if (pixels > 50_000_000) throw Error('图像总量较大，请分批处理');
      const blob = await renderLabel(line.doc, line.values, true);
      const image = await pdf.embedPng(await blob.arrayBuffer());
      for (let n = 0; n < line.copies; n++) {
        const page = pdf.addPage([(group.widthMm * 72) / 25.4, (group.heightMm * 72) / 25.4]);
        page.drawImage(image, { x: 0, y: 0, width: page.getWidth(), height: page.getHeight() });
      }
    }
    outputs.push({
      name: `labels-${group.widthMm}x${group.heightMm}mm.pdf`,
      bytes: await pdf.save(),
    });
  }
  const format = outputs.length > 1 ? 'zip' : 'pdf';
  let blob: Blob;
  if (format === 'zip') {
    const zip = new JSZip();
    outputs.forEach((o) => {
      zip.file(o.name, o.bytes);
    });
    blob = await zip.generateAsync({ type: 'blob' });
  } else blob = new Blob([outputs[0]!.bytes as BlobPart], { type: 'application/pdf' });
  const record: BulkRecord = {
    id: fingerprint,
    createdAt: new Date().toISOString(),
    rows: p.lines.length,
    labels: p.labels,
    stock: p.stock,
    status: 'pdf-generated',
    format,
    files: outputs.map((o) => o.name),
  };
  await saveSaved(`export-${fingerprint}`, { blob, record });
  const history = (await getSaved<BulkRecord[]>('bulkHistory')) ?? [];
  await saveSaved('bulkHistory', [record, ...history.filter((r) => r.id !== fingerprint)]);
  return { blob, record };
}
function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
export async function installBrowserDemo() {
  await db();
  await templates();
  window.fetch = async (input, init) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      location.origin,
    );
    if (!url.pathname.startsWith('/api/')) return originalFetch(input, init);
    try {
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body;
      const path = decodeURIComponent(url.pathname);
      if (path === '/api/templates' && method === 'GET') return json(await templates());
      const templateMatch = path.match(/^\/api\/templates\/([^/]+)$/);
      if (templateMatch) {
        if (method === 'GET')
          return json((await templates()).find((d) => d.id === templateMatch[1]));
        if (method === 'PUT') return json(await saveTemplate({ ...body, id: templateMatch[1] }));
        if (method === 'DELETE')
          return await serial(async () => {
            const all = await templates();
            await saveSaved(
              'templates',
              all.filter((t) => t.id !== templateMatch[1]),
            );
            return json({ deleted: true });
          });
      }
      if (path === '/api/fonts')
        return json({
          families: [
            'Arial',
            'Helvetica',
            'Georgia',
            'Courier New',
            'Microsoft YaHei',
            'PingFang SC',
            'sans-serif',
          ],
        });
      if (path === '/api/targets')
        return json([
          { id: 'target_pdf_download', name: '导出标签 PDF', format: 'pdf', delivery: 'download' },
          {
            id: 'target_browser_print',
            name: '浏览器直接打印',
            format: 'browser-print-page',
            delivery: 'browser-dialog',
          },
        ]);
      const preview = path.match(/\/templates\/([^/]+)\/preview$/);
      if (preview) {
        const doc = (await templates()).find((t) => t.id === preview[1]);
        if (!doc) throw Error('模板不存在');
        return new Response(await renderLabel(doc, body ?? {}), {
          headers: { 'Content-Type': 'image/png' },
        });
      }
      if (path === '/api/history') {
        if (method === 'DELETE') {
          await saveSaved('history', []);
          return json({ ok: true });
        }
        return json((await getSaved('history')) ?? []);
      }
      if (path.startsWith('/api/history/') && method === 'DELETE') {
        await saveSaved(
          'history',
          ((await getSaved<any[]>('history')) ?? []).filter((r) => r.id !== path.split('/').pop()),
        );
        return json({ deleted: true });
      }
      const history = path.match(/\/targets\/([^/]+)\/templates\/([^/]+)\/history$/);
      if (history) {
        const doc = (await templates()).find((t) => t.id === history[2]);
        const record = {
          id: newId(),
          ts: new Date().toISOString(),
          templateId: doc?.id,
          templateName: doc?.name,
          values: body,
          copies: Number(url.searchParams.get('copies') ?? 1),
          target: history[1] === 'target_browser_print' ? '浏览器打印对话框' : 'PDF下载',
          targetId: history[1],
          format: history[1] === 'target_browser_print' ? 'browser-print-page' : 'pdf',
          delivery: history[1] === 'target_browser_print' ? 'browser-dialog' : 'download',
          ok: true,
          detail:
            history[1] === 'target_browser_print'
              ? '已打开打印对话框；未确认出纸'
              : '已生成文件并请求下载；未确认打印',
          widthDots: Math.round((doc?.media.widthMm ?? 0) * 12),
          heightDots: Math.round((doc?.media.heightMm ?? 0) * 12),
        };
        await saveSaved('history', [record, ...((await getSaved<any[]>('history')) ?? [])]);
        return json(record);
      }
      if (path === '/api/studio/excel/read')
        return json(await readWorkbook(body as Blob, url.searchParams.get('name') ?? ''));
      if (path === '/api/studio/bulk/preview') return json(await bulkPreview(body));
      const savedExport = path.match(/^\/api\/studio\/bulk\/history\/([a-f0-9]+)\/file$/);
      if (savedExport) {
        const data = await getSaved<{ blob: Blob }>(`export-${savedExport[1]}`);
        if (!data) throw Error('文件不存在');
        return new Response(data.blob, { headers: { 'Content-Type': data.blob.type } });
      }
      if (path === '/api/studio/bulk/history') return json((await getSaved('bulkHistory')) ?? []);
      if (path === '/api/studio/bulk/pdf') {
        return await serial(async () => {
          const output = await bulkPdf(body.input, body.fingerprint);
          return new Response(output.blob, {
            headers: {
              'Content-Type':
                output.record.format === 'zip' ? 'application/zip' : 'application/pdf',
            },
          });
        });
      }
      return json({ error: '此演示只提供本机设计、文件及浏览器打印功能' }, 400);
    } catch (e) {
      return json({ error: (e as Error).message ?? String(e) }, 400);
    }
  };
}
