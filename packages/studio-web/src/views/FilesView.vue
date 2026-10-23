<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import {
  downloadSource,
  exportBackup,
  type SourceFile,
  sourceFiles,
  uploadFiles,
} from '../lib/demoRuntime';
import { loadAll } from '../lib/store';

const files = ref<SourceFile[]>([]),
  query = ref(''),
  type = ref('all'),
  page = ref(1),
  busy = ref(false),
  message = ref('');
const filtered = computed(() =>
  files.value.filter(
    (f) =>
      (type.value === 'all' || f.type === type.value) &&
      f.name.toLowerCase().includes(query.value.toLowerCase()),
  ),
);
const visible = computed(() => filtered.value.slice((page.value - 1) * 24, page.value * 24));
async function refresh() {
  files.value = await sourceFiles();
}
async function run(fn: () => Promise<void>) {
  if (busy.value) return;
  busy.value = true;
  message.value = '';
  try {
    await fn();
  } catch (e) {
    message.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
function upload(e: Event) {
  const input = e.target as HTMLInputElement;
  const selected = Array.from(input.files ?? []);
  void run(async () => {
    await uploadFiles(selected);
    await loadAll();
    await refresh();
    message.value = '已导入并保存到当前浏览器。';
  });
  input.value = '';
}
function download(file: SourceFile) {
  void run(() => downloadSource(file));
}
function open(file: SourceFile) {
  void run(async () => {
    const blob = file.data ?? (await fetch(file.url!).then((r) => r.blob()));
    const url = URL.createObjectURL(blob!);
    window.open(url, '_blank', 'noopener');
    setTimeout(() => URL.revokeObjectURL(url), 120000);
  });
}
function importSource(file: SourceFile) {
  void run(async () => {
    const blob = file.data ?? (await fetch(file.url!).then((r) => r.blob()));
    await uploadFiles([new File([blob!], file.name, { type: blob!.type })]);
    await loadAll();
    await refresh();
    message.value = '已导入模板库，可进入设计器叠加编辑。';
  });
}
onMounted(() => {
  void refresh();
});
</script>
<template><section class="files"><header><div><h1>文件与原始标签</h1><p>原稿保留，设计另存。所有可找到的标签文件均在这里。</p></div><button :disabled="busy" @click="run(exportBackup)">备份工作区</button></header><div class="upload"><label>上传设计或背景文件<input type="file" multiple accept=".pdf,.png,.jpg,.jpeg,.json,.btw" :disabled="busy" @change="upload" /></label><p>PDF 导入为背景，可叠加文字、日期和条码；设计 JSON 可继续编辑。BTW 仅保留原始文件供下载，需要 BarTender 打开。一次最多 20 个文件；PDF 导入最多 30 页。</p></div><div class="filters"><input v-model="query" placeholder="搜索产品、文件名或尺寸" aria-label="搜索原始文件" @input="page=1"/><select v-model="type" aria-label="文件类型" @change="page=1"><option value="all">所有格式</option><option value="pdf">PDF</option><option value="btw">BTW</option><option value="json">JSON</option></select><span>{{ filtered.length }} 个文件</span></div><p v-if="message" role="status">{{ message }}</p><p v-if="busy">处理中，请稍候…</p><div class="grid"><article v-for="file in visible" :key="file.id"><img v-if="file.thumbnail" :src="file.thumbnail" :alt="file.name" loading="lazy"/><div v-else class="type">{{ file.type.toUpperCase() }}</div><strong>{{ file.name }}</strong><small>{{ file.pages?file.pages+' 页 · ':'' }}{{ file.widthMm?file.widthMm+' × '+file.heightMm+' mm · ':'' }}{{ Math.round(file.bytes/1024) }} KB</small><div class="actions"><button :disabled="busy" @click="download(file)">下载原稿</button><button v-if="file.type==='pdf'" :disabled="busy" @click="open(file)">打开 PDF</button><button v-if="file.type==='pdf'&&(file.pages??1)<=30" :disabled="busy" @click="importSource(file)">导入设计</button></div></article></div><footer><button :disabled="page<=1" @click="page--">上一页</button><span>{{ page }} / {{ Math.max(1,Math.ceil(filtered.length/24)) }}</span><button :disabled="page*24>=filtered.length" @click="page++">下一页</button></footer></section></template>
<style scoped>.files{flex:1;overflow:auto;padding:28px;min-width:0}header{display:flex;align-items:center;justify-content:space-between;gap:16px}h1{font-size:26px;margin:0}p{font-size:12px;line-height:1.8;color:var(--muted)}.upload{margin:22px 0;border:1px dashed var(--accent);background:var(--accent-soft);padding:20px;border-radius:8px}.upload label{display:grid;gap:10px;font-size:13px}.upload input{max-width:100%;height:auto}.filters{display:flex;gap:12px;align-items:center;margin:20px 0}.filters input{width:300px;max-width:100%}.filters span{font-size:12px;color:var(--muted)}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:16px}article{display:flex;flex-direction:column;gap:12px;padding:16px;border:1px solid var(--border);border-radius:10px;background:var(--panel)}article img{height:150px;object-fit:contain;background:white}.type{display:grid;place-items:center;height:150px;color:var(--accent);background:var(--accent-soft);font-size:30px;font-weight:bold}article strong{font-size:12px;overflow-wrap:anywhere;line-height:1.6}small{font-size:10px;color:var(--muted)}.actions{display:flex;gap:5px;flex-wrap:wrap;margin-top:auto}.actions button{font-size:11px}footer{display:flex;align-items:center;justify-content:center;gap:18px;margin:24px 0}footer span{font-size:12px}@media(max-width:760px){.files{padding:16px}header{align-items:start;flex-direction:column}.filters{flex-wrap:wrap}.filters input{width:100%}.grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}article{padding:10px}article img,.type{height:100px}}
</style>
