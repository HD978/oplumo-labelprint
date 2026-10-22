<script setup lang="ts">
import {
  ArrowUpRight,
  CheckCircle2,
  Layers,
  Package,
  Plug,
  Search,
  ShieldCheck,
} from 'lucide-vue-next';
import { computed, ref } from 'vue';
import { t } from '../lib/i18n';
import { setActiveView } from '../lib/store';

const section = ref('orders');
const search = ref('');
const reviewing = ref(false);
const approved = ref(false);
const activity = ref<string[]>([]);
const rows = [
  {
    order: 'DEMO-001',
    revision: 2,
    outlet: 'Outlet A',
    sku: 'DEMO-BREAD',
    qty: 12,
    unit: 'PKT',
    factor: 1,
    stock: '40 × 20',
    template: 'DEMO-T01',
  },
  {
    order: 'DEMO-002',
    revision: 1,
    outlet: 'Outlet B',
    sku: 'DEMO-PASTRY',
    qty: 4,
    unit: 'CTN',
    factor: 6,
    stock: '70 × 50',
    template: 'DEMO-T02',
  },
  {
    order: 'DEMO-003',
    revision: 1,
    outlet: 'Outlet C',
    sku: 'DEMO-SAUCE',
    qty: 8,
    unit: 'BAG',
    factor: 1,
    stock: '100 × 150',
    template: '',
  },
];
const filtered = computed(() =>
  rows.filter((r) =>
    `${r.order} ${r.outlet} ${r.sku}`.toLowerCase().includes(search.value.toLowerCase()),
  ),
);
const valid = rows.filter((r) => r.template);
const count = valid.reduce((n, r) => n + r.qty * r.factor, 0);
function approve() {
  if (approved.value) return;
  approved.value = true;
  activity.value.unshift(`DEMO-BATCH-001 · ${new Date().toLocaleTimeString()} · ${count}`);
}
function reset() {
  approved.value = false;
  activity.value = [];
  reviewing.value = false;
}
</script>

<template>
  <section class="studio">
    <div class="eyebrow">OPLUMO / LABEL STUDIO</div>
    <header><div><h1>{{ t('studio.title') }}</h1><p>{{ t('studio.subtitle') }}</p></div><button @click="setActiveView('templates')">{{ t('studio.openTemplates') }} <ArrowUpRight :size="15" /></button></header>
    <div class="demo"><ShieldCheck :size="16" />{{ t('studio.demo') }}</div>
    <div class="metrics">
      <article><CheckCircle2 :size="20" /><span>{{ t('studio.ready') }}</span><strong>{{ valid.length.toString().padStart(2, '0') }}</strong></article>
      <article class="warning"><ShieldCheck :size="20" /><span>{{ t('studio.blocked') }}</span><strong>01</strong></article>
      <article><Layers :size="20" /><span>{{ t('studio.labels') }}</span><strong>{{ count }}</strong></article>
    </div>
    <nav class="subnav"><button v-for="tab in ['orders', 'products', 'connections']" :key="tab" :class="{ selected: section === tab }" @click="section = tab"><Package v-if="tab === 'products'" :size="15" /><Plug v-else-if="tab === 'connections'" :size="15" />{{ t(`studio.${tab}` as Parameters<typeof t>[0]) }}</button></nav>
    <div v-if="section === 'orders'" class="panel">
      <div class="panelhead"><h2>{{ t('studio.orders') }}</h2><label class="search"><Search :size="16" /><input v-model="search" :placeholder="t('studio.search')" :aria-label="t('studio.search')" /></label></div>
      <div class="tablewrap"><table><thead><tr><th>{{ t('studio.order') }}</th><th>{{ t('studio.outlet') }}</th><th>{{ t('studio.sku') }}</th><th>{{ t('studio.qty') }}</th><th>{{ t('studio.stock') }}</th><th>{{ t('studio.status') }}</th></tr></thead><tbody><tr v-for="r in filtered" :key="r.order"><td><b>{{ r.order }}</b><small>rev {{ r.revision }}</small></td><td>{{ r.outlet }}</td><td>{{ r.sku }}</td><td>{{ r.qty }} {{ r.unit }}</td><td>{{ r.stock }} mm</td><td><span class="badge" :class="{ blocked: !r.template }">{{ r.template ? t('studio.valid') : t('studio.fix') }}</span></td></tr><tr v-if="!filtered.length"><td colspan="6">{{ t('studio.empty') }}</td></tr></tbody></table></div>
      <footer><span>{{ t('studio.notice') }}</span><button class="primary" @click="reviewing = true">{{ t('studio.preview') }} <ArrowUpRight :size="16" /></button></footer>
    </div>
    <div v-else-if="section === 'products'" class="panel"><div class="panelhead"><h2>{{ t('studio.products') }}</h2></div><p class="inset">{{ t('studio.rule') }}</p><div class="tablewrap"><table><thead><tr><th>SKU</th><th>{{ t('studio.unit') }}</th><th>{{ t('studio.factor') }}</th><th>{{ t('studio.template') }}</th></tr></thead><tbody><tr v-for="r in rows" :key="r.sku"><td>{{ r.sku }}</td><td>{{ r.unit }}</td><td>{{ r.factor }}</td><td>{{ r.template || '—' }}</td></tr></tbody></table></div></div>
    <div v-else class="panel"><div class="panelhead"><h2>{{ t('studio.connections') }}</h2></div><div class="connections"><article><Plug :size="22" /><h3>{{ t('studio.current') }}</h3></article><article><ArrowUpRight :size="22" /><h3>{{ t('studio.future') }}</h3></article></div><p class="inset">{{ t('studio.connectionNote') }}</p></div>
    <div class="pipeline"><span>{{ t('studio.flow') }}</span><small>{{ t('studio.printNote') }}</small></div>
    <div class="panel activity"><h2>{{ t('studio.audit') }}</h2><p v-if="!activity.length">{{ t('studio.noActivity') }}</p><p v-for="entry in activity" :key="entry">{{ entry }} · {{ t('studio.approved') }}</p><button v-if="activity.length" @click="reset">{{ t('studio.reset') }}</button></div>
    <div v-if="reviewing" class="overlay" @click.self="reviewing = false"><section class="review" role="dialog" aria-modal="true" :aria-label="t('studio.review')" @keydown.esc="reviewing = false"><h2>{{ t('studio.review') }}</h2><p>{{ t('studio.notice') }}</p><ul><li v-for="r in valid" :key="r.order">{{ r.order }} / rev {{ r.revision }} · {{ r.sku }} <b>{{ r.qty * r.factor }}</b></li></ul><p>{{ t('studio.labels') }}: <b>{{ count }}</b></p><p v-if="approved" role="status">{{ t('studio.approved') }}</p><footer><button @click="reviewing = false">{{ t('studio.close') }}</button><button class="primary" :disabled="approved" @click="approve">{{ t('studio.approve') }}</button></footer></section></div>
  </section>
</template>

<style scoped>
.studio{width:100%;overflow:auto;padding:36px;background:var(--bg);color:var(--text)}.eyebrow{font-size:11px;letter-spacing:2px;color:var(--accent);font-weight:750;margin-bottom:16px}header,.panelhead,footer{display:flex;align-items:center;justify-content:space-between;gap:20px}h1{font-size:30px;letter-spacing:-1px;margin:0}h2{font-size:15px;margin:0}p{color:var(--muted);line-height:1.6}button{display:inline-flex;align-items:center;gap:8px;cursor:pointer}button.primary{background:var(--accent);color:white;border-color:var(--accent)}button:disabled{opacity:.5;cursor:default}.demo{display:flex;align-items:center;gap:9px;color:var(--accent);background:var(--accent-soft);padding:12px 16px;border-radius:8px;font-size:12px;margin:22px 0}.metrics{display:grid;grid-template-columns:repeat(3,1fr);gap:18px}.metrics article{border:1px solid var(--border);border-radius:10px;background:var(--panel);padding:20px;display:grid;grid-template-columns:1fr auto;gap:14px}.metrics svg{color:var(--accent);grid-column:2;grid-row:1/3}.metrics span{font-size:12px;color:var(--muted)}.metrics strong{font-size:34px;line-height:1}.warning strong{color:#b36c19}.subnav{display:flex;gap:12px;margin:26px 0 16px}.subnav button{border:0;background:transparent;color:var(--muted)}.subnav .selected{color:var(--accent);background:var(--accent-soft)}.panel{background:var(--panel);border:1px solid var(--border);border-radius:10px;overflow:hidden}.panelhead{padding:20px}.search{display:flex;align-items:center;gap:8px;color:var(--muted)}.search input{width:240px}.tablewrap{overflow-x:auto}table{width:100%;border-collapse:collapse;white-space:nowrap;text-align:left;font-size:12px}th{background:var(--panel-subtle);font-weight:500;color:var(--muted)}td,th{padding:17px 20px;border-bottom:1px solid var(--border)}td small{display:block;color:var(--muted);margin-top:5px}.badge{background:var(--accent-soft);color:var(--accent);padding:5px 8px;border-radius:5px}.badge.blocked{background:#fff2df;color:#925c13}footer{padding:18px 20px}footer span{max-width:600px;font-size:12px;color:var(--muted);line-height:1.6}.pipeline{display:grid;gap:8px;padding:24px 0;color:var(--text);font-size:13px}.pipeline small{color:var(--muted)}.activity{padding:20px}.activity p{font-size:12px}.inset{padding:0 20px;font-size:13px}.connections{display:grid;grid-template-columns:1fr 1fr;gap:16px;padding:20px}.connections article{border:1px solid var(--border);padding:20px;border-radius:8px}.connections h3{font-size:14px}.overlay{position:fixed;inset:0;z-index:100;background:#07132b88;display:grid;place-items:center;padding:20px}.review{background:var(--panel);padding:26px;border-radius:12px;width:min(560px,100%);max-height:85vh;overflow:auto}.review p{font-size:13px}.review li{padding:12px 0;font-size:12px}.review li b{float:right}.review footer{padding:20px 0 0}@media(max-width:760px){.studio{padding:20px 14px}header,.panelhead,footer{align-items:stretch;flex-direction:column;gap:12px}h1{font-size:25px}.metrics{gap:8px}.metrics article{padding:12px;display:flex;flex-direction:column;gap:10px}.metrics svg{display:none}.metrics strong{font-size:28px}.metrics span{font-size:10px}.search input{width:100%}.search{width:100%}.connections{grid-template-columns:1fr}.subnav{gap:2px}.subnav button{font-size:12px}}
</style>
