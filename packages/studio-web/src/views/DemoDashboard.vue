<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { exportBackup } from '../lib/demoRuntime';
import { openTemplate, setActiveView, state } from '../lib/store';

const summary = ref<{
  templates: number;
  sourceFiles: number;
  pdfFiles: number;
  btwFiles: number;
}>();
const error = ref('');
const busy = ref(false);
const stocks = computed(() => [
  ...new Set(state.templates.map((t) => `${t.media.widthMm} × ${t.media.heightMm}`)),
]);
onMounted(async () => {
  summary.value = await fetch('/library-summary.json').then((r) => r.json());
});
async function backup() {
  busy.value = true;
  try {
    await exportBackup();
  } catch (e) {
    error.value = String(e);
  } finally {
    busy.value = false;
  }
}
</script>
<template><section class="home"><div class="eyebrow">OPLUMO / LABEL STUDIO</div><header><div><h1>你的标签，集中在这里。</h1><p>从原始标签到设计、批量生成和打印。</p></div><button :disabled="busy" @click="backup">{{ busy?'正在整理备份…':'备份整个工作区' }}</button></header><div class="notice">私有演示 · 修改保存在当前浏览器，换设备不会自动同步。可导出设计文件及完整工作区备份。</div><div class="metrics"><article><span>当前设计模板</span><b>{{ state.templates.length }}</b><small>原稿背景与动态字段</small></article><article><span>原始标签资料</span><b>{{ summary?.sourceFiles??'—' }}</b><small>{{ summary?.pdfFiles }} PDF / {{ summary?.btwFiles }} BTW</small></article><article><span>标签尺寸</span><b>{{ stocks.length }}</b><small>{{ stocks.join(' / ') }} mm</small></article></div><div class="tasks"><button @click="setActiveView('templates')"><strong>浏览与设计标签 ↗</strong><span>查看全部产品、门店模板；调整字段位置和尺寸。</span></button><button @click="setActiveView('bulk')"><strong>Excel 批量制标签 ↗</strong><span>上传多个工作簿，绑定栏位，输出按尺寸分档的 PDF。</span></button><button @click="setActiveView('files')"><strong>上传与原始资料 ↗</strong><span>PDF、图片、设计 JSON 可导入；BTW 保留原始文件。</span></button></div><div class="notice" style="margin-top:24px"><b>老板演示建议 · 3 分钟</b><p>① 浏览标签库，打开一个标签调整文字和位置并保存。② 进入 Excel 批量制标签，载入演示数据，检查预览后生成 6 张标签。③ 点击文件卡片下载或打开 PDF，展示实际尺寸与打印入口。</p></div><h2>先从这些标签开始</h2><div class="featured"><button v-for="doc in state.templates.slice(0,6)" :key="doc.id" @click="openTemplate(doc.id)"><img v-if="doc.elements[0]?.type==='image'" :src="doc.elements[0].src" alt="标签原稿" loading="lazy"/><strong>{{ doc.name }}</strong><span>进入设计器 →</span></button></div><p class="footnote">迁移模板保留来源的待核对状态。浏览器打印会打开设备打印对话框；打印机驱动、纸张与出纸结果需现场确认。</p><p v-if="error" role="alert">{{ error }}</p></section></template>
<style scoped>.home{padding:32px;overflow:auto;flex:1;background:var(--bg)}.eyebrow{font-size:11px;letter-spacing:2px;color:var(--accent);font-weight:700}header{display:flex;justify-content:space-between;align-items:center;gap:16px;margin:18px 0}h1{font-size:30px;letter-spacing:-1px;margin:0}p{color:var(--muted);font-size:13px;line-height:1.7}.notice{border:1px solid var(--accent-border);background:var(--accent-soft);color:var(--accent);padding:14px;border-radius:8px;font-size:12px}.metrics{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin:24px 0}.metrics article{display:grid;gap:10px;border:1px solid var(--border);border-radius:10px;padding:22px;background:var(--panel)}.metrics span,.metrics small{font-size:12px;color:var(--muted)}.metrics b{font-size:36px}.tasks{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}.tasks button{display:grid;text-align:left;gap:12px;padding:20px;white-space:normal;background:var(--panel);height:auto}.tasks strong{color:var(--accent)}.tasks span{color:var(--muted);line-height:1.7;font-size:12px}h2{font-size:17px;margin:30px 0 16px}.featured{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}.featured button{height:auto;display:grid;gap:10px;padding:16px;white-space:normal;text-align:left;background:var(--panel)}.featured img{height:130px;width:100%;object-fit:contain;background:white}.featured strong{font-size:12px}.featured span{font-size:11px;color:var(--accent)}.footnote{font-size:11px;margin-top:24px}@media(max-width:760px){.home{padding:18px}h1{font-size:24px}header{align-items:start;flex-direction:column}.metrics{gap:8px}.metrics article{padding:12px}.metrics b{font-size:26px}.metrics small{font-size:9px}.tasks{grid-template-columns:1fr}.featured{grid-template-columns:repeat(2,1fr)}}
</style>
