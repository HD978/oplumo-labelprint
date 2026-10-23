<script setup lang="ts">
import { compileToSvg, defaultMediaProfiles, type TemplateDoc } from '@labelprint/shared';
import { Copy, Pencil, Plus, Printer, Trash2 } from 'lucide-vue-next';
import { computed, ref } from 'vue';
import { exportDesign } from '../lib/demoRuntime';
import { loadAll } from '../lib/store';
import { api as cloudApi } from '../lib/v2';

const cloudMessage = ref('');
async function publishDoc(id: string) {
  try {
    await cloudApi(`/api/templates/${id}/publish`, 'POST');
    await loadAll();
    cloudMessage.value = '模板已发布，可用于新任务';
  } catch (e) {
    cloudMessage.value = (e as Error).message;
  }
}
async function restoreDoc(tmpl: TemplateDoc) {
  try {
    const versions = await cloudApi<{ version: number }[]>(`/api/templates/${tmpl.id}/versions`);
    const previous = versions.find((v) => v.version < tmpl.version);
    if (!previous) {
      cloudMessage.value = '没有更早的版本';
      return;
    }
    await cloudApi(`/api/templates/${tmpl.id}/restore`, 'POST', {
      version: tmpl.version,
      restoreVersion: previous.version,
    });
    await loadAll();
    cloudMessage.value = '已还原上一个版本为新草稿，请核对后发布';
  } catch (e) {
    cloudMessage.value = (e as Error).message;
  }
}

import { confirmDialog } from '../lib/confirm';
import { mediaTypeLabel, t } from '../lib/i18n';
import {
  createTemplate,
  duplicateTemplateById,
  openTemplate,
  removeTemplate,
  selectPrintTemplate,
  setActiveView,
  state,
} from '../lib/store';

const query = ref('');
const size = ref('all');
const sizes = computed(() => [
  ...new Set(state.templates.map((t) => `${t.media.widthMm}x${t.media.heightMm}`)),
]);
const filtered = computed(() =>
  state.templates.filter(
    (t) =>
      t.name.toLowerCase().includes(query.value.toLowerCase()) &&
      (size.value === 'all' || `${t.media.widthMm}x${t.media.heightMm}` === size.value),
  ),
);
function thumb(t: TemplateDoc): string {
  return compileToSvg(t, {
    values: t.defaults,
    assets: Object.fromEntries(
      t.elements.filter((e) => e.type === 'image').map((e) => [e.id, e.src]),
    ),
  });
}
function mediaLabel(t: TemplateDoc): string {
  const m = t.media;
  return `${m.widthMm}×${m.heightMm} mm · ${mediaTypeLabel(m.type)}`;
}
function onNew(): void {
  createTemplate(defaultMediaProfiles()[0]!);
}
function onPrint(t: TemplateDoc): void {
  selectPrintTemplate(t.id);
  setActiveView('print');
}
async function onDelete(tmpl: TemplateDoc): Promise<void> {
  const ok = await confirmDialog({
    title: t('templates.deleteTitle', { name: tmpl.name }),
    message: t('templates.deleteMessage'),
    confirmText: t('common.delete'),
    danger: true,
  });
  if (ok) removeTemplate(tmpl.id);
}
</script>

<template>
  <div class="templates">
    <div class="head">
      <div>
        <h2>{{ t('templates.title') }}</h2>
        <p class="muted">{{ t('templates.description') }}</p>
      </div>
      <span class="count">{{ t('common.count.templates', { count: state.templates.length }) }}</span>
      <div class="spacer"></div>
      <button class="primary" @click="onNew"><Plus :size="15" /> {{ t('templates.new') }}</button>
    </div>

    <p v-if="cloudMessage" role="status">{{cloudMessage}}</p><div class="filters"><input v-model="query" placeholder="搜索产品、SKU 或门店" aria-label="搜索标签"/><select v-model="size" aria-label="标签尺寸"><option value="all">所有尺寸</option><option v-for="s in sizes" :key="s" :value="s">{{ s }} mm</option></select><span>{{ filtered.length }} 个模板</span></div>
    <div v-if="filtered.length" class="grid">
      <div v-for="tmpl in filtered" :key="tmpl.id" class="card">
        <button class="thumb" :title="t('common.edit')" @click="openTemplate(tmpl.id)">
          <div class="thumb-inner" v-html="thumb(tmpl)"></div>
        </button>
        <div class="meta">
          <div class="name" :title="tmpl.name">{{ tmpl.name }}</div>
          <div class="size muted">{{ mediaLabel(tmpl) }}</div><small class="muted">版本 {{ tmpl.version }} · {{ (tmpl as any).publicationStatus ?? 'draft' }}</small>
        </div>
        <div class="actions">
          <button class="primary action-main" @click="openTemplate(tmpl.id)"><Pencil :size="15" /> {{ t('common.design') }}</button>
          <button class="action-main" @click="onPrint(tmpl)"><Printer :size="15" /> {{ t('common.print') }}</button>
          <button class="link" @click="exportDesign(tmpl)">JSON</button><button class="link" @click="publishDoc(tmpl.id)">发布</button><button class="link" @click="restoreDoc(tmpl)">还原上版</button><div class="spacer"></div>
          <button class="link" :title="t('common.copy')" @click="duplicateTemplateById(tmpl.id)"><Copy :size="15" /></button>
          <button class="link danger" :title="t('common.delete')" @click="onDelete(tmpl)"><Trash2 :size="15" /></button>
        </div>
      </div>
    </div>
    <p v-else class="muted empty">{{ t('templates.empty') }}</p>
  </div>
</template>

<style scoped>
.actions{flex-wrap:wrap}.actions .action-main{white-space:nowrap;min-width:78px}.filters{display:flex;gap:12px;align-items:center;margin-bottom:20px;flex-wrap:wrap}.filters span{color:var(--muted);font-size:12px}.filters input{width:280px;max-width:100%}
.templates {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  padding: 22px 24px;
  overflow: auto;
}
.head {
  display: flex;
  align-items: flex-start;
  gap: 14px;
  margin-bottom: 18px;
}
.head h2 {
  margin: 0;
  font-size: 20px;
  line-height: 1.2;
}
.head p {
  margin: 5px 0 0;
}
.head button.primary {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: none;
}
.count {
  margin-top: 2px;
  color: var(--text-soft);
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 4px 10px;
  white-space: nowrap;
}
.spacer {
  flex: 1;
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
  gap: 16px;
}
.card {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--panel);
  overflow: hidden;
  display: flex;
  flex-direction: column;
  box-shadow: 0 1px 2px rgba(24, 32, 51, 0.04);
  transition:
    border-color 120ms ease,
    box-shadow 120ms ease,
    transform 120ms ease;
}
.card:hover {
  border-color: var(--border-strong);
  box-shadow: var(--shadow-panel);
  transform: translateY(-1px);
}
.thumb {
  border: none;
  border-radius: 0;
  background:
    linear-gradient(var(--canvas-grid) 1px, transparent 1px),
    linear-gradient(90deg, var(--canvas-grid) 1px, transparent 1px),
    var(--canvas-bg);
  background-size: 18px 18px;
  padding: 18px;
  height: 148px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
}
.thumb:hover {
  background-color: var(--panel-muted);
}
.thumb-inner {
  max-width: 100%;
  max-height: 100%;
  display: flex;
}
.thumb-inner :deep(svg) {
  max-width: 100%;
  max-height: 102px;
  width: auto;
  height: auto;
  background: var(--paper);
  box-shadow: var(--shadow-paper);
}
.meta {
  padding: 12px 13px 5px;
}
.name {
  font-weight: 600;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.size {
  font-size: 11px;
  margin-top: 2px;
}
.actions {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 5px 10px 12px;
}
.action-main {
  min-height: 30px;
  padding-inline: 10px;
  font-weight: 650;
}
.actions .spacer {
  flex: 1;
}
.actions .link {
  border: none;
  background: transparent;
  padding: 6px;
  min-height: 28px;
  border-radius: 6px;
  color: var(--muted);
  cursor: pointer;
}
.actions .link:hover {
  background: var(--accent-wash);
  color: var(--accent);
}
.actions .link.danger:hover {
  background: var(--danger-soft);
  color: var(--danger);
}
.empty {
  padding: 44px;
  border: 1px dashed var(--border-strong);
  border-radius: var(--radius);
  background: var(--panel-subtle);
  text-align: center;
}

@media (max-width: 720px) {
  .filters{display:flex;gap:12px;align-items:center;margin-bottom:20px;flex-wrap:wrap}.filters span{color:var(--muted);font-size:12px}.filters input{width:280px;max-width:100%}
.templates {
    padding: 16px;
  }
  .head {
    align-items: stretch;
    flex-wrap: wrap;
  }
  .count {
    order: 3;
  }
  .grid {
    grid-template-columns: 1fr;
  }
}
</style>
