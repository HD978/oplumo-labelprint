<script setup lang="ts">
import {
  type BulkBinding,
  type BulkPreview,
  type BulkRecord,
  type BulkRequest,
  collectParams,
  type ExcelFile,
} from '@labelprint/shared';
import { computed, onMounted, ref, watch } from 'vue';
import { download as downloadLocal } from '../lib/demoRuntime';
import { t } from '../lib/i18n';
import { state } from '../lib/store';

const files = ref<ExcelFile[]>([]);
const sheets = ref<Record<string, string>>({});
const templateId = ref('');
const templateColumn = ref('');
const quantityColumn = ref('');
const bindings = ref<Record<string, { mode: 'column' | 'value'; text: string }>>({});
const preview = ref<BulkPreview>();
const history = ref<BulkRecord[]>([]);
const busy = ref(false);
const error = ref('');
const downloaded = ref(false);
const sampleNote = ref('');
const selected = computed(() =>
  files.value
    .map((f) => f.sheets.find((s) => s.name === sheets.value[f.name]))
    .filter((s) => s !== undefined),
);
const rows = computed(() => selected.value.flatMap((s) => s.rows));
const headers = computed(() => [...new Set(selected.value.flatMap((s) => s.headers))]);
const templates = computed(() =>
  templateColumn.value
    ? state.templates.filter((t) =>
        rows.value.some((r) => r.cells[templateColumn.value]?.trim() === t.id),
      )
    : state.templates.filter((t) => t.id === templateId.value),
);
const params = computed(() => [...new Set(templates.value.flatMap(collectParams))]);
const request = computed<BulkRequest>(() => ({
  templateId: templateId.value,
  templateColumn: templateColumn.value,
  quantityColumn: quantityColumn.value,
  rows: rows.value,
  bindings: Object.fromEntries(
    params.value.map((key) => [
      key,
      bindings.value[key]?.mode === 'value'
        ? { value: bindings.value[key]?.text ?? '' }
        : ({ column: bindings.value[key]?.text ?? '' } as BulkBinding),
    ]),
  ),
}));
const canPreview = computed(
  () =>
    rows.value.length > 0 &&
    rows.value.length <= 500 &&
    !selected.value.some((s) => s.error) &&
    (!!templateId.value || !!templateColumn.value),
);
watch(
  request,
  () => {
    preview.value = undefined;
    downloaded.value = false;
  },
  { deep: true },
);
watch([params, headers], () => {
  for (const key of params.value)
    if (!bindings.value[key])
      bindings.value[key] = { mode: 'column', text: headers.value.includes(key) ? key : '' };
});
async function json<T>(url: string, method = 'GET', body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? res.statusText);
  return data as T;
}
async function run(fn: () => Promise<void>) {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    await fn();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}
function upload(event: Event) {
  const input = event.target as HTMLInputElement;
  const chosen = Array.from(input.files ?? []);
  preview.value = undefined;
  downloaded.value = false;
  void run(async () => {
    if (!chosen.length) return;
    if (chosen.length > 10) throw new Error(t('bulk.fileLimit'));
    if (new Set(chosen.map((f) => f.name)).size !== chosen.length)
      throw new Error(t('bulk.duplicateFiles'));
    const loaded: ExcelFile[] = [];
    for (const f of chosen) {
      if (!/\.xlsx$/i.test(f.name) || f.size > 2 * 1024 * 1024)
        throw new Error(t('bulk.fileLimit'));
      const res = await fetch(`/api/studio/excel/read?name=${encodeURIComponent(f.name)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: f,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(`${f.name}: ${data.error ?? res.statusText}`);
      loaded.push(data);
    }
    files.value = loaded;
    sheets.value = Object.fromEntries(
      loaded.map((f) => [
        f.name,
        (f.sheets.find((s) => !s.error && s.rows.length) ?? f.sheets[0])?.name ?? '',
      ]),
    );
  });
  input.value = '';
}
async function sampleWorkbook() {
  const Excel = await import('exceljs');
  const workbook = new Excel.Workbook();
  const sheet = workbook.addWorksheet('Labels');
  const docs = state.templates.filter((d) => collectParams(d).length).slice(0, 3);
  if (!docs.length) throw new Error('请先添加含动态字段的模板');
  const keys = [...new Set(docs.flatMap(collectParams))];
  sheet.addRow(['templateId', 'quantity', ...keys]);
  const sample = (key: string, i: number) =>
    /exp|date/i.test(key)
      ? '30/10/2026'
      : /batch/i.test(key)
        ? 'DEMO-20261023'
        : /weight/i.test(key)
          ? '500g'
          : /qty|quantity/i.test(key)
            ? '1'
            : `DEMO ${i + 1}`;
  docs.forEach((doc, i) => {
    sheet.addRow([doc.id, i + 1, ...keys.map((k) => sample(k, i))]);
  });
  sheet.columns.forEach((c) => {
    c.width = 25;
  });
  sheet.getRow(1).font = { bold: true };
  const buffer = await workbook.xlsx.writeBuffer();
  return new Blob([buffer as BlobPart], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}
function loadSample() {
  void run(async () => {
    const blob = await sampleWorkbook();
    const response = await fetch('/api/studio/excel/read?name=OPLUMO-demo.xlsx', {
      method: 'POST',
      body: blob,
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    files.value = [data];
    sheets.value = { [data.name]: data.sheets[0].name };
    templateColumn.value = 'templateId';
    quantityColumn.value = 'quantity';
    templateId.value = '';
    bindings.value = Object.fromEntries(
      data.sheets[0].headers
        .filter((k: string) => !['templateId', 'quantity'].includes(k))
        .map((key: string) => [key, { mode: 'column', text: key }]),
    );
    sampleNote.value =
      '已通过实际 Excel 读取流程载入 3 行示例，共 6 张标签。示例日期与内容仅用于演示。';
  });
}
function downloadSample() {
  void run(async () => downloadLocal(await sampleWorkbook(), 'OPLUMO-demo.xlsx'));
}
function redownload(entry: BulkRecord) {
  void run(async () => {
    const response = await fetch(`/api/studio/bulk/history/${entry.id}/file`);
    if (!response.ok) throw new Error('此记录的文件不可用，请重新生成');
    downloadLocal(await response.blob(), `oplumo-diecut-${entry.id.slice(0, 12)}.${entry.format}`);
  });
}
function review() {
  void run(async () => {
    preview.value = undefined;
    preview.value = await json<BulkPreview>('/api/studio/bulk/preview', 'POST', request.value);
    try {
      localStorage.setItem(
        'oplumo.bulk.mapping.v1',
        JSON.stringify({
          templateId: templateId.value,
          templateColumn: templateColumn.value,
          quantityColumn: quantityColumn.value,
          bindings: bindings.value,
        }),
      );
    } catch {
      /* Mapping memory is optional; server export remains available. */
    }
  });
}
async function loadHistory() {
  history.value = await json<BulkRecord[]>('/api/studio/bulk/history');
}
function download() {
  void run(async () => {
    if (!preview.value) return;
    const res = await fetch('/api/studio/bulk/pdf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: request.value, fingerprint: preview.value.fingerprint }),
    });
    if (!res.ok) {
      const data = await res.json();
      preview.value = undefined;
      throw new Error(data.error ?? res.statusText);
    }
    const blob = await res.blob();
    downloadLocal(
      blob,
      `oplumo-diecut-${preview.value.fingerprint.slice(0, 12)}.${res.headers.get('content-type')?.includes('zip') ? 'zip' : 'pdf'}`,
    );
    downloaded.value = true;
    await loadHistory();
  });
}
onMounted(() => {
  try {
    const saved = JSON.parse(localStorage.getItem('oplumo.bulk.mapping.v1') ?? 'null');
    if (
      saved &&
      typeof saved.templateId === 'string' &&
      typeof saved.templateColumn === 'string' &&
      typeof saved.quantityColumn === 'string'
    ) {
      templateId.value = saved.templateId;
      templateColumn.value = saved.templateColumn;
      quantityColumn.value = saved.quantityColumn;
      if (saved.bindings && typeof saved.bindings === 'object')
        bindings.value = Object.fromEntries(
          Object.entries(saved.bindings).filter(
            (entry): entry is [string, { mode: 'column' | 'value'; text: string }] => {
              const b = entry[1] as { mode?: unknown; text?: unknown };
              return (
                !!b && (b.mode === 'column' || b.mode === 'value') && typeof b.text === 'string'
              );
            },
          ),
        );
    }
  } catch {
    /* Corrupt optional browser preferences do not affect saved server records. */
  }
  void run(loadHistory);
});
</script>
<template>
<section class="bulk">
  <h2>{{ t('bulk.title') }}</h2><p>{{ t('bulk.description') }}</p>
  <div class="demo-actions"><button class="primary" :disabled="busy" @click="loadSample">载入 Excel 演示数据</button><button :disabled="busy" @click="downloadSample">下载示例 Excel</button><span>3 个实际模板 · 6 张标签 · 可修改后重新上传</span></div><p v-if="sampleNote" role="status">{{ sampleNote }}</p>
  <p class="hint">{{ t('bulk.boundary') }}</p>
  <label class="upload">{{ t('bulk.upload') }}<input type="file" multiple accept=".xlsx" :disabled="busy" @change="upload" /></label>
  <p>{{ t('bulk.fileLimit') }}</p>
  <div v-for="file in files" :key="file.name" class="file"><b>{{ file.name }}</b><label>{{ t('bulk.sheet') }}<select v-model="sheets[file.name]" :disabled="busy"><option v-for="sheet in file.sheets" :key="sheet.name" :value="sheet.name">{{ sheet.name }} · {{ sheet.rows.length }} {{ t('bulk.rows') }}{{ sheet.error?' ⚠':'' }}</option></select></label><p v-if="file.sheets.find(s=>s.name===sheets[file.name])?.error" class="error">{{ file.sheets.find(s=>s.name===sheets[file.name])?.error }}</p></div>
  <div v-if="files.length" class="settings">
    <label>{{ t('bulk.template') }}<select v-model="templateId" :disabled="busy||!!templateColumn"><option value="">{{ t('bulk.choose') }}</option><option v-for="template in state.templates" :key="template.id" :value="template.id">{{ template.name }} · {{ template.media.widthMm }} × {{ template.media.heightMm }} mm</option></select></label>
    <label>{{ t('bulk.templateColumn') }}<select v-model="templateColumn" :disabled="busy"><option value="">{{ t('bulk.useSelected') }}</option><option v-for="header in headers" :key="header">{{ header }}</option></select></label>
    <label>{{ t('bulk.quantity') }}<select v-model="quantityColumn" :disabled="busy"><option value="">{{ t('bulk.oneEach') }}</option><option v-for="header in headers" :key="header">{{ header }}</option></select></label>
  </div>
  <p v-if="files.length">{{ t('bulk.quantityNote') }}</p>
  <div v-if="params.length" class="tablewrap"><table><thead><tr><th>{{ t('bulk.parameter') }}</th><th>{{ t('bulk.binding') }}</th><th>{{ t('bulk.value') }}</th></tr></thead><tbody><tr v-for="key in params" :key="key"><td>{{ key }}</td><td><select v-if="bindings[key]" v-model="bindings[key].mode" :disabled="busy" :aria-label="`${key}: ${t('bulk.binding')}`"><option value="column">{{ t('bulk.column') }}</option><option value="value">{{ t('bulk.fixed') }}</option></select></td><td v-if="bindings[key]"><select v-if="bindings[key].mode==='column'" v-model="bindings[key].text" :disabled="busy" :aria-label="`${key}: ${t('bulk.column')}`"><option value="">{{ t('bulk.choose') }}</option><option v-for="header in headers" :key="header">{{ header }}</option></select><input v-else v-model="bindings[key].text" :disabled="busy" :aria-label="`${key}: ${t('bulk.fixed')}`" /></td></tr></tbody></table></div>
  <details v-if="rows.length"><summary>{{ t('bulk.dataPreview') }} · {{ rows.length }} {{ t('bulk.rows') }}</summary><div class="tablewrap"><table><thead><tr><th>{{ t('bulk.source') }}</th><th v-for="header in headers" :key="header">{{ header }}</th></tr></thead><tbody><tr v-for="(row,i) in rows.slice(0,10)" :key="i"><td>{{ row.file }} / {{ row.sheet }} / {{ row.row }}</td><td v-for="header in headers" :key="header">{{ row.cells[header] }}</td></tr></tbody></table></div></details>
  <p v-if="error" class="error" role="alert">{{ error }}</p>
  <button class="primary" :disabled="busy||!canPreview" @click="review">{{ busy?t('studio.loading'):t('bulk.review') }}</button>
  <div v-if="preview" class="review"><div><h3>{{ t('bulk.summary') }}</h3><p>{{ preview.rows }} {{ t('bulk.rows') }} → <b>{{ preview.labels }} {{ t('bulk.labels') }}</b></p><p v-for="(stock,i) in preview.stock" :key="i">{{ stock.widthMm }} × {{ stock.heightMm }} mm · {{ stock.labels }}</p><p>{{ t('bulk.previewNote') }}</p><button class="primary" :disabled="busy" @click="download">{{ t('bulk.generate') }}</button><p v-if="downloaded" role="status">{{ t('bulk.downloaded') }}</p></div><figure><img :src="preview.previewPng" :alt="t('bulk.firstLabel')" /><figcaption>{{ t('bulk.firstLabel') }}</figcaption></figure></div>
  <h3>{{ t('bulk.history') }}</h3><div v-for="entry in history.slice(0,10)" :key="entry.id" class="record"><span>{{ entry.createdAt }} · {{ entry.rows }} {{ t('bulk.rows') }} · {{ entry.labels }} {{ t('bulk.labels') }}</span><small>{{ t('bulk.generatedOnly') }}</small><button :disabled="busy" @click="redownload(entry)">再次下载 {{ entry.format.toUpperCase() }}</button></div>
</section>
</template>
<style scoped>
.demo-actions{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:20px 0}.demo-actions span{font-size:12px;color:var(--muted)}.bulk{background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:24px;min-width:0}.bulk h2{font-size:19px;margin:0}.bulk p{font-size:12px;color:var(--muted);line-height:1.7}.hint{padding:12px;background:var(--accent-soft);border-radius:6px}.bulk label{display:grid;gap:7px;font-size:12px;min-width:0}.upload{border:1px dashed var(--accent-border);padding:22px;border-radius:8px;margin-top:18px;background:var(--panel-subtle)}.upload input{max-width:100%;height:auto}.file{border-bottom:1px solid var(--border);padding:16px 0;display:grid;gap:10px}.file b{overflow-wrap:anywhere;font-size:13px}.settings{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px;margin:20px 0}.bulk input,.bulk select{max-width:100%;min-width:0}.tablewrap{overflow-x:auto;margin:16px 0}table{width:100%;border-collapse:collapse;text-align:left;font-size:12px}td,th{border-bottom:1px solid var(--border);padding:12px;max-width:240px;overflow-wrap:anywhere}th{color:var(--muted)}.bulk .error{color:#b34425;overflow-wrap:anywhere}.primary{background:var(--accent);color:white;border-color:var(--accent);cursor:pointer}.primary:disabled{opacity:.5;cursor:default}.review{display:grid;grid-template-columns:1fr 240px;gap:24px;border:1px solid var(--border);padding:20px;margin:24px 0;border-radius:8px}.review figure{margin:0;text-align:center}.review img{max-width:100%;max-height:320px;object-fit:contain;border:1px solid var(--border);background:white}.review figcaption{font-size:11px;color:var(--muted);margin-top:8px}.record{padding:12px 0;border-top:1px solid var(--border);font-size:12px;display:grid;gap:5px}.record small{color:var(--muted)}details{margin:18px 0;font-size:12px}@media(max-width:760px){.bulk{padding:16px}.settings,.review{grid-template-columns:1fr}.review figure{max-width:240px}.upload{padding:14px}}
</style>
