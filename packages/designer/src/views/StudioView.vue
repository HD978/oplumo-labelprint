<script setup lang="ts">
import type { StudioBatch, StudioBatchView, StudioPlan, StudioView } from '@labelprint/shared';
import { ArrowUpRight, CheckCircle2, Layers, Plug, Search, ShieldCheck } from 'lucide-vue-next';
import { computed, onMounted, ref } from 'vue';
import { t } from '../lib/i18n';
import { setActiveView, state } from '../lib/store';
import { studioApi } from '../lib/studioApi';

const section = ref('orders');
const search = ref('');
const day = ref(
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kuala_Lumpur',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date()),
);
const workspace = ref<StudioView>({
  settings: { outlets: [], rules: [] },
  orders: [],
  batches: [],
  revisions: [],
});
const settingsJson = ref('');
const ordersJson = ref('[]');
const plan = ref<StudioPlan>();
const reviewing = ref<StudioBatch>();
const busy = ref(false);
const error = ref('');
const notice = ref('');
const filtered = computed(() =>
  (plan.value?.lines ?? []).filter((r) =>
    `${r.orderId} ${r.outletId} ${r.sku}`.toLowerCase().includes(search.value.toLowerCase()),
  ),
);
const currentBatch = computed(() =>
  workspace.value.batches.find((b) => b.id === reviewing.value?.id),
);
function message(code: string) {
  return t(`studio.${code}` as Parameters<typeof t>[0]);
}
async function run(fn: () => Promise<void>) {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  notice.value = '';
  try {
    await fn();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}
async function load() {
  workspace.value = await studioApi.view();
  plan.value = await studioApi.preview(day.value);
}
function refresh() {
  void run(async () => {
    await load();
    settingsJson.value = JSON.stringify(workspace.value.settings, null, 2);
  });
}
function saveRules() {
  void run(async () => {
    await studioApi.settings(JSON.parse(settingsJson.value));
    await load();
    notice.value = t('studio.saved');
  });
}
function importOrders() {
  void run(async () => {
    await studioApi.ingest(JSON.parse(ordersJson.value));
    await load();
    notice.value = t('studio.saved');
  });
}
function prepare() {
  void run(async () => {
    reviewing.value = await studioApi.prepare(day.value);
    await load();
  });
}
function approve() {
  void run(async () => {
    if (!reviewing.value) return;
    await studioApi.approve(reviewing.value.id);
    await load();
    notice.value = t('studio.saved');
  });
}
function batchState(b: StudioBatchView) {
  return b.stale
    ? t('studio.stale')
    : b.status === 'approved'
      ? t('studio.approvedState')
      : t('studio.reviewState');
}
function exportPlan(b: StudioBatch) {
  const blob = new Blob([JSON.stringify(b, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `batch-${b.id}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function sample() {
  ordersJson.value = JSON.stringify(
    [
      {
        source: 'manual',
        orderId: 'SAMPLE-001',
        revision: 1,
        status: 'confirmed',
        outletId: workspace.value.settings.outlets[0] ?? 'SAMPLE-OUTLET',
        deliveryDate: day.value,
        lines: [{ lineId: '1', sku: 'SAMPLE-SKU', quantity: 12, unit: 'PKT' }],
      },
    ],
    null,
    2,
  );
}
onMounted(refresh);
</script>

<template>
<section class="studio">
  <div class="eyebrow">OPLUMO / LABEL STUDIO</div>
  <header><div><h1>{{ t('studio.title') }}</h1><p>{{ t('studio.subtitle') }}</p></div><button @click="setActiveView('templates')">{{ t('studio.openTemplates') }} <ArrowUpRight :size="15" /></button></header>
  <div class="demo"><ShieldCheck :size="16" />{{ t('studio.demo') }}</div>
  <p class="localnote">{{ t('studio.localNotice') }}</p>
  <div class="controls"><label>{{ t('studio.delivery') }}<input v-model="day" type="date" :disabled="busy" @change="refresh" /></label><button :disabled="busy" @click="refresh">{{ busy ? t('studio.loading') : t('studio.refresh') }}</button></div>
  <p v-if="error" class="error" role="alert">{{ error }}</p><p v-if="notice" role="status">{{ notice }}</p>
  <div class="metrics"><article><CheckCircle2 :size="20" /><span>{{ t('studio.ready') }}</span><strong>{{ plan?.lines.length ?? 0 }}</strong></article><article class="warning"><ShieldCheck :size="20" /><span>{{ t('studio.blocked') }}</span><strong>{{ plan?.issues.length ?? 0 }}</strong></article><article><Layers :size="20" /><span>{{ t('studio.labels') }}</span><strong>{{ plan?.totalLabels ?? 0 }}</strong></article></div>
  <nav class="subnav"><button v-for="tab in ['orders','products','connections','history']" :key="tab" :class="{selected:section===tab}" @click="section=tab">{{ message(tab) }}</button></nav>
  <div v-if="section==='orders'" class="panel">
    <div class="panelhead"><h2>{{ t('studio.orders') }}</h2><label class="search"><Search :size="16" /><input v-model="search" :placeholder="t('studio.search')" :aria-label="t('studio.search')" /></label></div>
    <div class="tablewrap"><table><thead><tr><th>{{ t('studio.order') }}</th><th>{{ t('studio.outlet') }}</th><th>SKU</th><th>{{ t('studio.qty') }}</th><th>{{ t('studio.labels') }}</th><th>{{ t('studio.stock') }}</th></tr></thead><tbody><tr v-for="r in filtered" :key="JSON.stringify([r.source,r.orderId,r.lineId])"><td><b>{{ r.orderId }}</b><small>{{ r.source }} / rev {{ r.revision }}</small></td><td>{{ r.outletId }}</td><td>{{ r.sku }}</td><td>{{ r.quantity }} {{ r.unit }}</td><td>{{ r.labels }}</td><td>{{ r.widthMm }} × {{ r.heightMm }} mm</td></tr><tr v-if="!filtered.length"><td colspan="6">{{ t('studio.empty') }}</td></tr></tbody></table></div>
    <div v-if="plan?.issues.length" class="issues"><p v-for="(issue,i) in plan.issues" :key="i" class="error">{{ issue.orderId }} / {{ issue.lineId }} · {{ message(issue.code) }}</p></div>
    <footer><span>{{ t('studio.prepareNote') }}</span><button class="primary" :disabled="busy || !plan?.lines.length || !!plan?.issues.length" @click="prepare">{{ t('studio.prepare') }}</button></footer>
    <details class="import"><summary>{{ t('studio.orderJson') }}</summary><p>{{ t('studio.importHelp') }}</p><label>{{ t('studio.orderJson') }}<textarea v-model="ordersJson" spellcheck="false" /></label><footer><button :disabled="busy" @click="sample">{{ t('studio.sample') }}</button><button class="primary" :disabled="busy" @click="importOrders">{{ t('studio.import') }}</button></footer></details>
  </div>
  <div v-else-if="section==='products'" class="panel"><div class="panelhead"><h2>{{ t('studio.workspaceSettings') }}</h2></div><div class="editor"><p>{{ t('studio.settingsHelp') }}</p><p>{{ t('studio.rulesNote') }}</p><label>{{ t('studio.settingsJson') }}<textarea v-model="settingsJson" spellcheck="false" /></label><button class="primary" :disabled="busy" @click="saveRules">{{ t('studio.save') }}</button><h3>{{ t('studio.template') }}</h3><p v-for="template in state.templates" :key="template.id"><code>{{ template.id }}</code> · {{ template.name }} · {{ template.media.widthMm }} × {{ template.media.heightMm }} mm</p><code>{ "outlets": ["SAMPLE-OUTLET"], "rules": [{ "sku": "SAMPLE-SKU", "unit": "PKT", "labelsPerUnit": 1, "templateId": "…" }] }</code></div></div>
  <div v-else-if="section==='connections'" class="panel"><div class="panelhead"><h2>{{ t('studio.connections') }}</h2></div><div class="connections"><article><Plug :size="22" /><h3>{{ t('studio.current') }}</h3></article><article><ArrowUpRight :size="22" /><h3>{{ t('studio.future') }}</h3></article></div><p class="inset">{{ t('studio.connectionNote') }}</p></div>
  <div v-else class="panel"><div class="panelhead"><h2>{{ t('studio.history') }}</h2></div><p v-if="!workspace.batches.length" class="inset">{{ t('studio.noBatches') }}</p><div v-for="b in workspace.batches" :key="b.id" class="batch"><div><b>{{ b.plan.deliveryDate }} · {{ b.plan.totalLabels }}</b><small>{{ b.id }}</small><span class="badge" :class="{blocked:b.stale}">{{ batchState(b) }}</span></div><button @click="reviewing=b">{{ t('studio.preview') }}</button></div></div>
  <div class="pipeline"><span>{{ t('studio.flow') }}</span><small>{{ t('studio.previewNote') }}</small></div>
  <div v-if="reviewing" class="overlay" @click.self="reviewing=undefined"><section class="review" role="dialog" aria-modal="true" :aria-label="t('studio.review')"><h2>{{ t('studio.review') }}</h2><p>{{ reviewing.id }}</p><p>{{ t('studio.previewNote') }}</p><p v-if="currentBatch" :class="{error:currentBatch.stale}">{{ batchState(currentBatch) }}</p><ul><li v-for="(stock,i) in reviewing.plan.stock" :key="i">{{ stock.widthMm }} × {{ stock.heightMm }} mm <b>{{ stock.labels }}</b></li></ul><p>{{ t('studio.labels') }}: <b>{{ reviewing.plan.totalLabels }}</b></p><footer><button @click="reviewing=undefined">{{ t('studio.close') }}</button><button @click="exportPlan(reviewing)">{{ t('studio.export') }}</button><button class="primary" :disabled="busy || !currentBatch || currentBatch.stale || currentBatch.status==='approved'" @click="approve">{{ t('studio.approveReal') }}</button></footer></section></div>
</section>
</template>
<style scoped>
.studio{width:100%;overflow:auto;padding:36px;background:var(--bg);color:var(--text)}.eyebrow{font-size:11px;letter-spacing:2px;color:var(--accent);font-weight:750;margin-bottom:16px}header,.panelhead,footer{display:flex;align-items:center;justify-content:space-between;gap:20px}h1{font-size:30px;letter-spacing:-1px;margin:0}h2{font-size:15px;margin:0}p{color:var(--muted);line-height:1.6}button{display:inline-flex;align-items:center;gap:8px;cursor:pointer}button.primary{background:var(--accent);color:white;border-color:var(--accent)}button:disabled{opacity:.5;cursor:default}.demo{display:flex;align-items:center;gap:9px;color:var(--accent);background:var(--accent-soft);padding:12px 16px;border-radius:8px;font-size:12px;margin:22px 0}.metrics{display:grid;grid-template-columns:repeat(3,1fr);gap:18px}.metrics article{border:1px solid var(--border);border-radius:10px;background:var(--panel);padding:20px;display:grid;grid-template-columns:1fr auto;gap:14px}.metrics svg{color:var(--accent);grid-column:2;grid-row:1/3}.metrics span{font-size:12px;color:var(--muted)}.metrics strong{font-size:34px;line-height:1}.warning strong{color:#b36c19}.subnav{display:flex;gap:12px;margin:26px 0 16px}.subnav button{border:0;background:transparent;color:var(--muted)}.subnav .selected{color:var(--accent);background:var(--accent-soft)}.panel{background:var(--panel);border:1px solid var(--border);border-radius:10px;overflow:hidden}.panelhead{padding:20px}.search{display:flex;align-items:center;gap:8px;color:var(--muted)}.search input{width:240px}.tablewrap{overflow-x:auto}table{width:100%;border-collapse:collapse;white-space:nowrap;text-align:left;font-size:12px}th{background:var(--panel-subtle);font-weight:500;color:var(--muted)}td,th{padding:17px 20px;border-bottom:1px solid var(--border)}td small{display:block;color:var(--muted);margin-top:5px}.badge{background:var(--accent-soft);color:var(--accent);padding:5px 8px;border-radius:5px}.badge.blocked{background:#fff2df;color:#925c13}footer{padding:18px 20px}footer span{max-width:600px;font-size:12px;color:var(--muted);line-height:1.6}.pipeline{display:grid;gap:8px;padding:24px 0;color:var(--text);font-size:13px}.pipeline small{color:var(--muted)}.activity{padding:20px}.activity p{font-size:12px}.inset{padding:0 20px;font-size:13px}.connections{display:grid;grid-template-columns:1fr 1fr;gap:16px;padding:20px}.connections article{border:1px solid var(--border);padding:20px;border-radius:8px}.connections h3{font-size:14px}.overlay{position:fixed;inset:0;z-index:100;background:#07132b88;display:grid;place-items:center;padding:20px}.review{background:var(--panel);padding:26px;border-radius:12px;width:min(560px,100%);max-height:85vh;overflow:auto}.review p{font-size:13px}.review li{padding:12px 0;font-size:12px}.review li b{float:right}.review footer{padding:20px 0 0}@media(max-width:760px){.studio{padding:20px 14px}header,.panelhead,footer{align-items:stretch;flex-direction:column;gap:12px}h1{font-size:25px}.metrics{gap:8px}.metrics article{padding:12px;display:flex;flex-direction:column;gap:10px}.metrics svg{display:none}.metrics strong{font-size:28px}.metrics span{font-size:10px}.search input{width:100%}.search{width:100%}.connections{grid-template-columns:1fr}.subnav{gap:2px}.subnav button{font-size:12px}}

.controls{display:flex;gap:16px;align-items:end;margin:18px 0}.controls label{display:grid;gap:6px;font-size:12px}.localnote{font-size:12px}.error{color:#b34425;font-size:13px}.issues,.editor,.import{padding:20px}.editor label,.import label{display:block;font-size:12px}.editor textarea,.import textarea{display:block;width:100%;min-height:260px;resize:vertical;font:12px/1.6 monospace;margin:10px 0 16px;white-space:pre;overflow:auto}.editor>code{display:block;white-space:pre-wrap;overflow-wrap:anywhere;font-size:11px;line-height:1.8}.editor p,.import p{font-size:12px}.batch{display:flex;justify-content:space-between;align-items:center;gap:16px;padding:20px;border-top:1px solid var(--border)}.batch small{display:block;color:var(--muted);font-size:10px;margin:8px 0}.batch .badge{display:inline-block;font-size:12px}.subnav{flex-wrap:wrap}.review footer{flex-wrap:wrap}.review>p{overflow-wrap:anywhere}.review li{padding-right:12px}.controls input{max-width:100%}
</style>
