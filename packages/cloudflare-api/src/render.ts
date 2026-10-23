import { applyParams, collectParams, compileToSvg, type TemplateDoc } from '@labelprint/shared';
import { initWasm, Resvg } from '@resvg/resvg-wasm';
import wasm from '@resvg/resvg-wasm/index_bg.wasm';
import bwipjs from 'bwip-js';
import { decode } from 'fast-png';
import { PDFDocument } from 'pdf-lib';
import { type Env, fail, type Snapshot } from './types';

let initialized: Promise<void> | undefined;
const bytes64 = (bytes: Uint8Array) => {
  let value = '';
  for (let n = 0; n < bytes.length; n += 8192)
    value += String.fromCharCode(...bytes.subarray(n, n + 8192));
  return btoa(value);
};
export async function hydrate(doc: TemplateDoc, env: Env, workspace: string) {
  const result = JSON.parse(JSON.stringify(doc)) as TemplateDoc;
  for (const e of result.elements) {
    if (e.type === 'image' && e.src.startsWith('asset:')) {
      const asset = await env.DB.prepare(
        'SELECT r2_key,file_type FROM assets WHERE workspace_id=? AND id=?',
      )
        .bind(workspace, e.src.slice(6))
        .first<{ r2_key: string; file_type: string }>();
      if (!asset) fail('模板引用的图片不在当前工作区');
      if (!['png', 'jpg', 'jpeg'].includes(asset.file_type)) fail('只能使用 PNG / JPEG 图片');
      const obj = await env.FILES.get(asset.r2_key);
      if (!obj) fail('图片原稿缺失');
      e.src = `data:image/${asset.file_type === 'png' ? 'png' : 'jpeg'};base64,${bytes64(new Uint8Array(await obj.arrayBuffer()))}`;
    }
  }
  return result;
}
export async function raster(
  snapshot: Pick<Snapshot, 'doc' | 'values'>,
  env: Env,
  w: string,
  dpi = 300,
) {
  initialized ??= initWasm(wasm);
  await initialized;
  const doc = await hydrate(snapshot.doc, env, w),
    assets: Record<string, string> = {};
  for (const k of collectParams(doc)) if (!snapshot.values[k]?.trim()) fail(`缺少 ${k}`);
  for (const e of doc.elements) {
    if (e.type === 'image') {
      if (!/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(e.src)) fail('图片不可渲染');
      assets[e.id] = e.src;
    }
    if (e.type === 'barcode' || e.type === 'qrcode') {
      const value = applyParams(e.value, snapshot.values, doc);
      try {
        const svg = bwipjs.toSVG({
          bcid: e.type === 'qrcode' ? 'qrcode' : e.symbology,
          text: value,
          scale: 3,
          height: 12,
          includetext: e.type === 'barcode' && !!e.showText,
        });
        assets[e.id] = `data:image/svg+xml;base64,${bytes64(new TextEncoder().encode(svg))}`;
      } catch {
        fail(`条码无效：${e.id}`);
      }
    }
  }
  const svg = compileToSvg(doc, { values: snapshot.values, assets, placeholders: false });
  const width = Math.ceil((doc.media.widthMm * dpi) / 25.4),
    height = Math.ceil((doc.media.heightMm * dpi) / 25.4);
  if (width * height > 13_000_000) fail('单张标签像素过大');
  const font = env.FONT_KEY ? await env.FILES.get(env.FONT_KEY) : null;
  if (!font) fail('请先上传并配置工作区字体文件 FONT_KEY', 503);
  const renderer = new Resvg(svg, {
    fitTo: { mode: 'width', value: width },
    font: {
      fontBuffers: [new Uint8Array(await font.arrayBuffer())],
      defaultFontFamily: 'DejaVu Sans',
      sansSerifFamily: 'DejaVu Sans',
      loadSystemFonts: false,
    },
    background: 'white',
  });
  try {
    const image = renderer.render();
    try {
      return new Uint8Array(image.asPng());
    } finally {
      image.free();
    }
  } finally {
    renderer.free();
  }
}
export function zplFromPng(png: Uint8Array, copies: number) {
  const image = decode(png),
    rowBytes = Math.ceil(image.width / 8),
    packed = new Uint8Array(rowBytes * image.height);
  for (let y = 0; y < image.height; y++)
    for (let x = 0; x < image.width; x++) {
      const p = (y * image.width + x) * image.channels;
      let grey: number;
      if (image.channels <= 2) grey = image.data[p]!;
      else
        grey = (image.data[p]! * 299 + image.data[p + 1]! * 587 + image.data[p + 2]! * 114) / 1000;
      const alpha =
        image.channels === 2 || image.channels === 4
          ? image.data[p + image.channels - 1]! / 255
          : 1;
      grey = grey * alpha + 255 * (1 - alpha);
      if (grey < 128) packed[y * rowBytes + (x >> 3)]! |= 128 >> (x % 8);
    }
  const hex = Array.from(packed, (x) => x.toString(16).padStart(2, '0').toUpperCase()).join('');
  return `^XA^PW${image.width}^LL${image.height}^FO0,0^GFA,${packed.length},${packed.length},${rowBytes},${hex}^FS^PQ${copies}^XZ\n`;
}
export async function renderPart(
  lines: { snapshot: Snapshot; copies: number }[],
  env: Env,
  w: string,
  format: string,
) {
  const groups = new Map<string, { pdf: PDFDocument; zpl: string[] }>();
  for (const line of lines) {
    const d = line.snapshot.doc,
      key = `${d.media.widthMm}x${d.media.heightMm}`;
    let g = groups.get(key);
    if (!g) {
      g = { pdf: await PDFDocument.create(), zpl: [] };
      groups.set(key, g);
    }
    const png = await raster(line.snapshot, env, w, 300);
    if (format === 'pdf' || format === 'both') {
      const image = await g.pdf.embedPng(png);
      for (let n = 0; n < line.copies; n++) {
        const page = g.pdf.addPage([(d.media.widthMm * 72) / 25.4, (d.media.heightMm * 72) / 25.4]);
        page.drawImage(image, { x: 0, y: 0, width: page.getWidth(), height: page.getHeight() });
      }
    }
    if (format === 'zpl' || format === 'both') g.zpl.push(zplFromPng(png, line.copies));
  }
  const outputs: { name: string; bytes: Uint8Array; type: string }[] = [];
  for (const [key, g] of groups) {
    if (format === 'pdf' || format === 'both')
      outputs.push({
        name: `${key}mm-300dpi.pdf`,
        bytes: await g.pdf.save(),
        type: 'application/pdf',
      });
    if (format === 'zpl' || format === 'both')
      outputs.push({
        name: `${key}mm-300dpi.zpl`,
        bytes: new TextEncoder().encode(g.zpl.join('')),
        type: 'text/plain',
      });
  }
  return outputs;
}
