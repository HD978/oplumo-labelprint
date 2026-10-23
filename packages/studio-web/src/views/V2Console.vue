<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { loadAll, state } from '../lib/store';
import { account, api, fileUrl, requestId, role, who } from '../lib/v2';

const props = defineProps<{ section: string }>();
const data = ref<any[]>([]),
  error = ref(''),
  message = ref(''),
  busy = ref(false),
  forecast = ref<any>({}),
  mappings = ref<any[]>([]),
  preview = ref<any>(),
  review = ref<any>(),
  assets = ref<Record<string, any[]>>({});
const canEdit = computed(() => role() !== 'worker'),
  canPeople = computed(() => role() === 'qa');
const sku = reactive({
  sku_code: '',
  name: '',
  name_en: '',
  category: '',
  spec: '',
  barcode: '',
  weight: '',
  size_code: '40x20',
  expiry_days: 7,
  version: 0,
  id: '',
});
const person = reactive({ name: '', email: '', password: '', role: 'worker' }),
  tenantName = ref('');
const mappingName = ref('产品标签字段对应'),
  mappingId = ref(''),
  defaultTemplate = ref(''),
  multiplier = ref(1),
  bindings = reactive<Record<string, any>>({}),
  mappingVersion = ref(0);
const fieldKeys = ref('productName,skuCode,spec,productionDate,expiryDate,batchNo');
const keys = computed(() =>
  fieldKeys.value
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean),
);
const job = reactive({
  mappingId: '',
  productionDate: new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kuala_Lumpur',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date()),
  batchNo: '',
  outlet: '',
  lines: '',
  outputType: 'pdf',
});
const rule = reactive({
    template_id: '',
    priority: 10,
    match_category: '',
    match_size_code: '',
    match_sku_prefix: '',
  }),
  rules = ref<any[]>([]);
const history = ref<any[]>([]),
  size = reactive({ code: '', width_mm: 40, height_mm: 20, gap_mm: 2, dpi: 300 }),
  sizes = ref<any[]>([]);
const mappingSources = ['sku', 'batch', 'date', 'fixed'];
const skuFields = [
  'name',
  'sku_code',
  'name_en',
  'category',
  'spec',
  'barcode',
  'weight',
  'size_code',
];
let timer: ReturnType<typeof setInterval> | undefined;
async function run(fn: () => Promise<void>) {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  message.value = '';
  try {
    await fn();
  } catch (e) {
    error.value = (e as Error).message.includes('dynamically imported module')
      ? '页面版本已更新，请刷新后重新上传文件。'
      : (e as Error).message;
  } finally {
    busy.value = false;
  }
}
async function refresh() {
  const path: Record<string, string> = {
    skus: '/api/skus',
    mapping: '/api/mappings',
    jobs: '/api/jobs',
    files: '/api/assets',
    users: '/api/users',
    platform: '/api/platform/workspaces',
  };
  if (path[props.section]) data.value = await api(path[props.section]!);
  if (['dashboard', 'jobs'].includes(props.section)) {
    forecast.value = await api('/api/forecast');
    history.value = await api('/api/print');
  }
  if (['mapping', 'jobs'].includes(props.section)) {
    mappings.value = await api('/api/mappings');
    if (!job.mappingId)
      job.mappingId = mappings.value.find((m) => m.status === 'published')?.id ?? '';
  }
  if (props.section === 'mapping') {
    rules.value = await api('/api/rules');
    sizes.value = await api('/api/sizes');
  }
}
onMounted(() => {
  void run(refresh);
  if (props.section === 'jobs')
    timer = setInterval(() => {
      if (!busy.value) void refresh().catch((e) => (error.value = e.message));
    }, 3000);
});
onBeforeUnmount(() => {
  if (timer) clearInterval(timer);
});
function resetSku() {
  Object.assign(sku, {
    sku_code: '',
    name: '',
    name_en: '',
    category: '',
    spec: '',
    barcode: '',
    weight: '',
    size_code: '40x20',
    expiry_days: 7,
    version: 0,
    id: '',
  });
}
async function saveSku() {
  await api(sku.id ? `/api/skus/${sku.id}` : '/api/skus', sku.id ? 'PUT' : 'POST', sku);
  resetSku();
  message.value = '主档已保存，旧任务保留原始快照。';
  await refresh();
}
async function addUser() {
  await api('/api/users', 'POST', person);
  person.password = '';
  person.email = '';
  person.name = '';
  await refresh();
  message.value = '账号已建立，请通过公司认可的方式告知初始密码。';
}
function initBinding(key: string) {
  bindings[key] ??= {
    source: /Date$/.test(key) ? 'date' : key === 'batchNo' ? 'batch' : 'sku',
    field: key === 'productName' ? 'name' : key === 'skuCode' ? 'sku_code' : key,
    value: key === 'expiryDate' ? 'expiry' : 'production',
    format: 'DD/MM/YYYY',
  };
  return bindings[key];
}
function loadMapping(row: any) {
  mappingId.value = row.id;
  mappingName.value = row.name;
  mappingVersion.value = row.version;
  const c = JSON.parse(row.config_json);
  defaultTemplate.value = c.defaultTemplateId ?? '';
  multiplier.value = c.quantityMultiplier;
  fieldKeys.value = Object.keys(c.bindings).join(',');
  Object.keys(bindings).forEach((k) => {
    delete bindings[k];
  });
  Object.assign(bindings, c.bindings);
}
async function saveMapping() {
  const config = {
    bindings: Object.fromEntries(keys.value.map((k) => [k, initBinding(k)])),
    quantityMultiplier: multiplier.value,
    defaultTemplateId: defaultTemplate.value || undefined,
  };
  const result = await api('/api/mappings', 'POST', {
    id: mappingId.value || undefined,
    version: mappingVersion.value || undefined,
    name: mappingName.value,
    config,
  });
  mappingId.value = result.id;
  mappingVersion.value = result.version;
  message.value = '草稿已保存，发布后才可用于新任务。';
  await refresh();
}
function lines() {
  return job.lines
    .split('\n')
    .filter((x) => x.trim())
    .map((line) => {
      const parts = line.split(',');
      return { sku_code: parts[0]?.trim(), quantity: Number(parts[1]?.trim()) };
    });
}
function input() {
  return {
    mappingId: job.mappingId,
    productionDate: job.productionDate,
    batchNo: job.batchNo,
    outlet: job.outlet,
    lines: lines(),
  };
}
async function previewJob() {
  preview.value = await api('/api/jobs/preview', 'POST', input());
}
async function createJob() {
  await api('/api/jobs', 'POST', {
    input: input(),
    fingerprint: preview.value.fingerprint,
    outputType: job.outputType,
    idempotencyKey: requestId(),
  });
  preview.value = undefined;
  await refresh();
  message.value = '任务已建立并冻结批次资料，请核对后启动。';
}
async function filesFor(jobId: string) {
  assets.value[jobId] = await api(`/api/jobs/${jobId}/files`);
}
const confirm = reactive({
  jobId: '',
  quantity: 1,
  kind: 'original',
  printerName: '',
  note: '',
  idempotencyKey: '',
});
function prepareConfirmation(j: any) {
  Object.assign(confirm, {
    jobId: j.id,
    quantity: j.total_count,
    kind: 'original',
    printerName: '',
    note: '',
    idempotencyKey: requestId(),
  });
}
async function recordPrint() {
  await api('/api/print', 'POST', confirm);
  confirm.jobId = '';
  await refresh();
  message.value = '已保存人工出纸确认。补印、测试与损耗独立统计。';
}
async function parseMaster(event: Event) {
  const el = event.target as HTMLInputElement,
    f = el.files?.[0];
  el.value = '';
  if (!f) return;
  await run(async () => {
    if (f.size > 2 * 1024 * 1024) throw Error('主档最多 2MB，每批 500 行');
    let matrix: string[][] = [];
    if (/\.xlsx$/i.test(f.name)) {
      const Excel = await import('exceljs');
      const wb = new Excel.Workbook();
      await wb.xlsx.load(await f.arrayBuffer());
      const sheet = wb.worksheets.find((s) => s.state === 'visible');
      if (!sheet) throw Error('没有可见工作表');
      if (sheet.rowCount > 501 || sheet.columnCount > 32) throw Error('每批最多500行、32栏');
      sheet.eachRow((row) =>
        matrix.push(
          Array.from({ length: sheet.columnCount }, (_, i) => {
            const c = row.getCell(i + 1);
            if (c.isMerged) throw Error('请取消合并单元格');
            if (
              c.value &&
              typeof c.value === 'object' &&
              ('formula' in c.value || 'sharedFormula' in c.value)
            )
              throw Error('主档请使用数值，不接受公式');
            return c.text.trim();
          }),
        ),
      );
    } else if (/\.docx$/i.test(f.name)) {
      const Zip = (await import('jszip')).default;
      const zip = await Zip.loadAsync(f);
      const entry = zip.file('word/document.xml');
      if (!entry) throw Error('Word 内没有可读取表格');
      const xml = await entry.async('string');
      if (xml.length > 4 * 1024 * 1024) throw Error('Word 内容过大');
      const doc = new DOMParser().parseFromString(xml, 'text/xml');
      const table = doc.getElementsByTagName('w:tbl')[0];
      if (!table) throw Error('Word 第一张表格必须为主档');
      matrix = Array.from(table.getElementsByTagName('w:tr')).map((tr) =>
        Array.from(tr.getElementsByTagName('w:tc')).map((td) =>
          Array.from(td.getElementsByTagName('w:t'))
            .map((t) => t.textContent ?? '')
            .join('')
            .trim(),
        ),
      );
    } else throw Error('请上传 .xlsx 或 .docx');
    const headers = matrix.shift();
    if (!headers || new Set(headers).size !== headers.length || headers.some((h) => !h))
      throw Error('第一行需要唯一栏位名');
    const parsed = matrix
      .filter((r) => r.some(Boolean))
      .map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ''])));
    review.value = await api('/api/imports/preview', 'POST', { rows: parsed });
  });
}
async function importJobExcel(event: Event) {
  const f = (event.target as HTMLInputElement).files?.[0];
  if (!f) return;
  await run(async () => {
    if (f.size > 2 * 1024 * 1024) throw Error('文件过大');
    const Excel = await import('exceljs'),
      wb = new Excel.Workbook();
    await wb.xlsx.load(await f.arrayBuffer());
    const s = wb.worksheets[0];
    if (!s || s.rowCount > 5001) throw Error('每批最多5000行');
    const headers = (s.getRow(1).values as any[]).slice(1).map(String);
    const code = headers.indexOf('sku_code') + 1,
      qty = headers.indexOf('quantity') + 1;
    if (!code || !qty) throw Error('需要 sku_code 和 quantity 栏位');
    const values = [];
    for (let i = 2; i <= s.rowCount; i++) {
      const row = s.getRow(i);
      if (row.getCell(code).value)
        values.push(`${row.getCell(code).text},${row.getCell(qty).text}`);
    }
    job.lines = values.join('\n');
    preview.value = undefined;
  });
}
async function upload(event: Event) {
  const el = event.target as HTMLInputElement,
    files = Array.from(el.files ?? []);
  el.value = '';
  await run(async () => {
    if (files.length > 20) throw Error('一次最多20个文件');
    for (const f of files) {
      if (f.size > 20 * 1024 * 1024) throw Error('单个文件最多20MB');
      const form = new FormData();
      form.append('file', f);
      const res = await fetch('/api/assets', { method: 'POST', body: form });
      const out = await res.json();
      if (!res.ok) throw Error(out.error);
      if (/\.json$/i.test(f.name)) {
        const data = JSON.parse(await f.text());
        const docs = data.templates ?? [data];
        for (const doc of docs) {
          if (!Array.isArray(doc.elements)) continue;
          await api(`/api/templates/${requestId()}`, 'PUT', {
            ...doc,
            id: requestId(),
            version: 1,
          });
        }
      }
    }
    await loadAll();
    await refresh();
    message.value = '文件已上传。设计 JSON 已导入为草稿；PDF / BTW 原稿保留。';
  });
}
const totals = computed(() => {
  const c = forecast.value.confirmed ?? [];
  const sum = (kind: string) =>
    c.filter((r: any) => r.kind === kind).reduce((n: number, r: any) => n + r.labels, 0);
  return {
    original: sum('original'),
    reprint: sum('reprint'),
    test: sum('test'),
    waste: sum('waste'),
    generated: (forecast.value.generated ?? []).reduce((n: number, r: any) => n + r.labels, 0),
  };
});
</script>
<template><section class="console"><div v-if="error" role="alert" class="error">{{error}}</div><div v-if="message" role="status" class="success">{{message}}</div><p v-if="busy" role="status">正在处理…</p>
<template v-if="section==='dashboard'"><div class="eyebrow">PRODUCTION WORKSPACE</div><h1>标签生产工作台</h1><p>系统日期来自生产批次与 SKU 保质期。生成文件与实际出纸分别记录。</p><div class="metrics"><article v-for="(value,key) in totals"><span>{{({original:'原印确认',reprint:'补印确认',test:'测试打印',waste:'损耗',generated:'已生成标签'} as any)[key]}}</span><b>{{value}}</b><small>最近90天统计 · 张</small></article></div><div class="panel"><h2>标准操作流程</h2><ol><li>QA / Manager 上传主档，核对差异后应用。</li><li>保存并发布标签与 Master Mapping。</li><li>按生产批次核对数量，建立并启动分片任务。</li><li>Workers 下载文件或打开系统打印窗口，完成后确认出纸。</li></ol><p>确认数量是人工记录；未连接打印机回执。此统计是 forecast 的数据基础，不等同销量预测。</p></div></template>
<template v-if="section==='skus'"><h1>SKU 主档</h1><p>Excel / Word 表格批量更新；第一行使用 sku_code、name、spec、expiry_days、size_code 等栏位。每次最多500行。</p><div v-if="canEdit" class="panel"><label>上传 Master File<input type="file" accept=".xlsx,.docx" :disabled="busy" @change="parseMaster" /></label><div v-if="review" class="review"><b>新增 {{review.new}} · 修改 {{review.updated}} · 不变 {{review.unchanged}}</b><details><summary>检查差异明细</summary><table><tr><th>SKU</th><th>产品</th><th>变动</th><th>保质期</th></tr><tr v-for="r in review.rows"><td>{{r.row.sku_code}}</td><td>{{r.row.name}}</td><td>{{r.change}}</td><td>{{r.row.expiry_days}}</td></tr></table></details><button class="primary" :disabled="busy" @click="run(async()=>{await api(`/api/imports/${review.id}/apply`,'POST');review=undefined;await refresh();message='主档批量更新完成';})">核对并应用主档</button></div></div><form v-if="canEdit" class="panel formgrid" @submit.prevent="run(saveSku)"><label v-for="field in ['sku_code','name','name_en','category','spec','barcode','weight','size_code']">{{field}}<input v-model="(sku as any)[field]" :required="['sku_code','name'].includes(field)" /></label><label>expiry_days<input v-model.number="sku.expiry_days" type="number" min="0" /></label><button class="primary" :disabled="busy">{{sku.id?'保存修改':'添加 SKU'}}</button><button type="button" @click="resetSku">清空</button></form><div class="tablewrap"><table><tr><th>SKU</th><th>产品</th><th>规格</th><th>保质期</th><th>尺寸</th><th>版本</th><th></th></tr><tr v-for="r in data"><td>{{r.sku_code}}</td><td>{{r.name}}</td><td>{{r.spec}}</td><td>{{r.expiry_days??'未设定'}}</td><td>{{r.size_code}}</td><td>v{{r.version}}</td><td><button v-if="canEdit" @click="Object.assign(sku,r)">编辑</button></td></tr></table></div><button v-if="data.length===200" @click="run(async()=>{data.push(...await api('/api/skus?after='+encodeURIComponent(data[data.length-1].sku_code)))})">载入更多</button></template>
<template v-if="section==='mapping'"><h1>Master Mapping</h1><p>把模板变量对应到主档、批次资料或系统日期。未对应或未发布时阻止生成。</p><div class="pills"><button v-for="r in mappings" @click="loadMapping(r)">{{r.name}} · v{{r.version}} · {{r.status}}</button></div><div v-if="canEdit" class="panel"><div class="formgrid"><label>名称<input v-model="mappingName" /></label><label>默认模板<select v-model="defaultTemplate"><option value="">必须命中 SKU / 匹配规则</option><option v-for="t in state.templates" :value="t.id">{{t.name}}</option></select></label><label>每单位标签张数<input type="number" min="1" v-model.number="multiplier" /></label></div><label>模板变量名（逗号分隔）<input v-model="fieldKeys" /></label><table><tr><th>模板变量</th><th>来源</th><th>字段 / 计算</th><th>日期格式</th></tr><tr v-for="key in keys"><td>{{key}}</td><td><select v-model="initBinding(key).source"><option v-for="s in mappingSources">{{s}}</option></select></td><td><select v-if="initBinding(key).source==='sku'" v-model="bindings[key].field"><option v-for="f in skuFields">{{f}}</option></select><select v-else-if="bindings[key].source==='batch'" v-model="bindings[key].field"><option>productionDate</option><option>batchNo</option><option>outlet</option></select><select v-else-if="bindings[key].source==='date'" v-model="bindings[key].value"><option value="production">生产日期</option><option value="expiry">生产日期 + SKU 保质期</option></select><input v-else v-model="bindings[key].value" /></td><td><select v-if="bindings[key].source==='date'" v-model="bindings[key].format"><option>DD/MM/YYYY</option><option>YYYY-MM-DD</option></select></td></tr></table><div class="pills"><button :disabled="busy" @click="run(saveMapping)">保存草稿</button><button class="primary" :disabled="busy||!mappingId" @click="run(async()=>{await api(`/api/mappings/${mappingId}/publish`,'POST');await refresh();message='对应规则已发布';})">发布此版本</button></div></div><div class="panel"><h2>模板匹配规则</h2><p>数字越小优先级越高；未命中规则使用 Mapping 明确指定的默认模板，没有默认则阻止生成。</p><form v-if="canEdit" class="formgrid" @submit.prevent="run(async()=>{await api('/api/rules','POST',rule);await refresh();})"><label>模板<select v-model="rule.template_id" required><option v-for="t in state.templates" :value="t.id">{{t.name}}</option></select></label><label>优先级<input type="number" v-model.number="rule.priority" /></label><label>品类<input v-model="rule.match_category" /></label><label>尺寸代码<input v-model="rule.match_size_code" /></label><label>SKU 前缀<input v-model="rule.match_sku_prefix" /></label><button :disabled="busy">添加规则</button></form><table><tr><th>优先级</th><th>品类</th><th>尺寸</th><th>前缀</th><th>模板</th></tr><tr v-for="r in rules"><td>{{r.priority}}</td><td>{{r.match_category||'全部'}}</td><td>{{r.match_size_code||'全部'}}</td><td>{{r.match_sku_prefix||'全部'}}</td><td>{{state.templates.find(t=>t.id===r.template_id)?.name}}</td></tr></table></div><div class="panel"><h2>标签尺寸</h2><form v-if="canEdit" class="formgrid" @submit.prevent="run(async()=>{await api('/api/sizes','POST',size);await refresh();})"><label v-for="f in ['code','width_mm','height_mm','gap_mm','dpi']">{{f}}<input v-model="(size as any)[f]" :type="f==='code'?'text':'number'" required /></label><button :disabled="busy">添加尺寸</button></form><p v-for="s in sizes">{{s.code}} · {{s.width_mm}} × {{s.height_mm}} mm · {{s.dpi}} dpi</p></div></template>
<template v-if="section==='jobs'"><h1>批量任务与出纸确认</h1><p>任务冻结模板、字段值和生产日期；分片生成可重试、取消。PDF 和 ZPL 为300dpi；ZPL需要兼容打印机。</p><div v-if="canEdit" class="panel"><div class="formgrid"><label>已发布 Mapping<select v-model="job.mappingId"><option v-for="m in mappings.filter(m=>m.status==='published')" :value="m.id">{{m.name}} · v{{m.version}}</option></select></label><label>生产日期<input type="date" v-model="job.productionDate" /></label><label>批号<input v-model="job.batchNo" /></label><label>门店 / 地点<input v-model="job.outlet" /></label><label>输出<select v-model="job.outputType"><option value="pdf">PDF</option><option value="zpl">ZPL</option><option value="both">PDF + ZPL</option></select></label><label>上传批量 Excel<input type="file" accept=".xlsx" @change="importJobExcel" /></label></div><label>每行：sku_code,quantity<textarea rows="5" v-model="job.lines" placeholder="SKU-001,100&#10;SKU-002,300" /></label><button :disabled="busy" @click="run(previewJob)">检查系统日期与标签数量</button><div v-if="preview" class="review"><h2>预计生成 {{preview.total}} 张标签</h2><p v-for="(n,s) in preview.stock">{{s}} mm · {{n}} 张</p><p>第一行系统字段：{{preview.first}}</p><button class="primary" :disabled="busy" @click="run(createJob)">确认数量并建立任务</button></div></div><div v-for="j in data" class="panel"><div class="jobhead"><b>{{j.kind==='export'?'工作区导出':'标签任务'}} · {{j.id.slice(0,8)}}</b><span class="badge">{{j.status}}</span></div><p>{{j.created_at}} · {{j.success_count}} / {{j.total_count}} 张 · {{j.output_type}}</p><progress v-if="j.total_count" :value="j.success_count" :max="j.total_count" /><p v-if="j.error_message" class="error">{{j.error_message}}</p><div class="pills"><button v-if="j.status==='review'" :disabled="busy" @click="run(async()=>{await api(`/api/jobs/${j.id}/start`,'POST');await refresh();})">启动已核对任务</button><button v-if="['review','pending','processing','failed'].includes(j.status)" :disabled="busy" @click="run(async()=>{await api(`/api/jobs/${j.id}/cancel`,'POST');await refresh();})">取消</button><button v-if="j.status==='failed'&&canEdit" @click="run(async()=>{await api(`/api/jobs/${j.id}/retry`,'POST');await refresh();})">重试未完成部分</button><button v-if="j.status==='completed'" @click="run(()=>filesFor(j.id))">查看下载文件</button><button v-if="j.status==='completed'&&j.kind==='labels'" @click="prepareConfirmation(j)">确认出纸 / 记录补印</button></div><div v-if="assets[j.id]" class="downloads"><div v-for="f in assets[j.id]"><a :href="fileUrl(f.id)" target="_blank">下载 {{f.filename}} · {{Math.ceil(f.size_bytes/1024)}} KB</a><a v-if="f.filename.endsWith('.pdf')" :href="fileUrl(f.id)+'&inline=1'" target="_blank" style="margin-left:12px">打开 PDF / 打印</a></div></div></div><form v-if="confirm.jobId" class="panel formgrid" @submit.prevent="run(recordPrint)"><h2>人工确认出纸</h2><label>类型<select v-model="confirm.kind"><option value="original">首次打印</option><option value="reprint">补印</option><option value="test">测试</option><option value="waste">损耗</option></select></label><label>实际张数<input type="number" min="1" v-model.number="confirm.quantity" required /></label><label>打印机名称<input v-model="confirm.printerName" required /></label><label>备注<input v-model="confirm.note" /></label><button class="primary" :disabled="busy">保存出纸确认</button></form><h2>出纸记录</h2><div class="tablewrap"><table><tr><th>时间</th><th>任务</th><th>类型</th><th>张数</th><th>打印机</th></tr><tr v-for="h in history"><td>{{h.created_at}}</td><td>{{h.job_id.slice(0,8)}}</td><td>{{h.kind}}</td><td>{{h.quantity}}</td><td>{{h.printer_name}}</td></tr></table></div></template>
<template v-if="section==='files'"><h1>文件与完整导出</h1><p>所有文件按企业隔离。BTW保留原稿；设计 JSON 可导入编辑。PDF上传保留原稿，完整背景转模板功能沿用原演示，正在接入云端。</p><div v-if="canEdit" class="panel"><input type="file" multiple accept=".pdf,.png,.jpg,.jpeg,.btw,.json,.xlsx,.docx,.ttf" :disabled="busy" @change="upload"/><button :disabled="busy" @click="run(async()=>{const j=await api('/api/export','POST');message='导出任务已创建：'+j.id+'，请到批量任务下载所有 ZIP 分卷';})">导出完整工作区（JSON + 全部文件）</button><p>导出为多卷 ZIP，必须下载全部分卷。包含主档、模板历史、Mapping、任务快照、打印记录与文件；不包含用户密码或登录会话。</p></div><table><tr><th>文件</th><th>格式</th><th>大小</th><th></th></tr><tr v-for="f in data"><td>{{f.filename}}</td><td>{{f.file_type}}</td><td>{{Math.ceil(f.size_bytes/1024)}} KB</td><td><a :href="fileUrl(f.id)" target="_blank">下载</a></td></tr></table></template>
<template v-if="section==='users'"><h1>人员与权限</h1><p>QA：全部功能及人员管理。Manager：业务功能，不可添加或管理人员。Workers：只读及打印已核对任务。</p><form v-if="canPeople" class="panel formgrid" @submit.prevent="run(addUser)"><label>姓名<input v-model="person.name" required /></label><label>邮箱<input v-model="person.email" type="email" required /></label><label>初始密码<input v-model="person.password" type="password" minlength="12" autocomplete="new-password" required /></label><label>角色<select v-model="person.role"><option value="qa">QA</option><option value="manager">Manager</option><option value="worker">Workers</option></select></label><button class="primary" :disabled="busy">添加人员</button></form><table><tr><th>姓名</th><th>邮箱</th><th>角色</th><th>状态</th><th></th></tr><tr v-for="u in data"><td>{{u.name}}</td><td>{{u.email}}</td><td>{{u.role}}</td><td>{{u.is_active?'启用':'停用'}}</td><td><button v-if="canPeople&&u.id!==account.me?.id" :disabled="busy" @click="run(async()=>{await api(`/api/users/${u.id}`,'PATCH',{role:u.role,is_active:!u.is_active});await refresh();})">{{u.is_active?'停用':'启用'}}</button></td></tr></table></template>
<template v-if="section==='platform'"><h1>企业 / 工厂租户管理</h1><p>一个企业可有多名用户。各企业的主档、模板、资料与任务独立；支持至少10个租户，未设10个的上限。</p><form class="panel formgrid" @submit.prevent="run(async()=>{await api('/api/platform/workspaces','POST',{name:tenantName});tenantName='';await who();await refresh();})"><label>企业名称<input v-model="tenantName" required /></label><button class="primary" :disabled="busy">建立独立租户</button></form><table><tr><th>企业</th><th>状态</th><th>创建时间</th></tr><tr v-for="t in data"><td>{{t.name}}</td><td>{{t.status}}</td><td>{{t.created_at}}</td></tr></table></template>
</section></template>
<style scoped>.console{padding:30px;overflow:auto;flex:1;min-width:0}h1{font-size:25px;margin:0 0 12px}h2{font-size:16px;margin:0 0 14px}p,li{font-size:12px;line-height:1.8;color:var(--muted)}.eyebrow{font-size:10px;letter-spacing:2px;color:var(--accent);margin-bottom:14px}.metrics{display:grid;grid-template-columns:repeat(5,1fr);gap:14px;margin:24px 0}.metrics article{display:grid;gap:16px;background:var(--panel);padding:20px;border:1px solid var(--border);border-radius:10px}.metrics span{font-size:12px;color:var(--muted)}.metrics b{font-size:30px}.metrics small{font-size:10px;color:var(--muted)}.panel{padding:22px;border:1px solid var(--border);background:var(--panel);border-radius:10px;margin:20px 0}.formgrid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px;align-items:end}label{display:grid;gap:8px;font-size:12px;margin-bottom:12px}input,select,textarea{width:100%;min-width:0;max-width:100%}input[type=file]{height:auto}textarea{resize:vertical}table{width:100%;border-collapse:collapse;text-align:left;font-size:12px}td,th{padding:12px 10px;border-bottom:1px solid var(--border);overflow-wrap:anywhere}th{color:var(--muted);font-weight:500;background:var(--panel-subtle)}.tablewrap{overflow-x:auto}table input,table select{min-width:100px}.error{padding:12px;border-radius:6px;background:#fff1f0;color:#a53535;margin-bottom:15px;font-size:13px}.success,.review{padding:16px;background:var(--accent-soft);color:var(--accent);border-radius:8px;margin:16px 0;font-size:13px}.pills{display:flex;flex-wrap:wrap;gap:8px;margin:14px 0}.jobhead{display:flex;gap:20px;align-items:center;font-size:13px}.badge{padding:5px 10px;background:var(--accent-soft);color:var(--accent);border-radius:30px;font-size:11px}progress{width:100%;height:8px}.downloads{display:grid;gap:10px;font-size:12px;margin-top:16px}a{color:var(--accent)}@media(max-width:760px){.console{padding:16px}.formgrid{grid-template-columns:1fr 1fr}.metrics{grid-template-columns:repeat(2,1fr)}.metrics article{padding:14px}.panel{padding:15px}td,th{padding:9px 6px}.tablewrap table{min-width:550px}}@media(max-width:450px){.formgrid{grid-template-columns:1fr}}
</style>
