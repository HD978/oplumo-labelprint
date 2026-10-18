<script setup lang="ts">
import { defaultMediaProfiles } from '@labelprint/shared';
import {
  FileImage,
  Grid3x3,
  Magnet,
  Maximize2,
  Plus,
  Save,
  Trash2,
  ZoomIn,
  ZoomOut,
} from 'lucide-vue-next';
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import LabelCanvas from '../components/Canvas.vue';
import IconButton from '../components/IconButton.vue';
import ParamDefsPanel from '../components/ParamDefsPanel.vue';
import PropertyPanel from '../components/PropertyPanel.vue';
import ResizeBar from '../components/ResizeBar.vue';
import Toolbar from '../components/Toolbar.vue';
import { t } from '../lib/i18n';
import { newTemplate, save, state } from '../lib/store';

function onNew(): void {
  newTemplate(defaultMediaProfiles()[0]!);
}
function onName(e: Event): void {
  if (state.doc) {
    state.doc.name = (e.target as HTMLInputElement).value;
    state.dirty = true;
  }
}
const referenceInput = ref<HTMLInputElement | null>(null);
const referenceError = ref('');
async function importReference(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  referenceError.value = '';
  if (!file || !state.doc) return;
  if (file.size > 20 * 1024 * 1024) {
    referenceError.value = t('design.referenceFileTooLarge');
    return;
  }
  try {
    let dataUrl: string;
    if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
      const pdfjs = await import('pdfjs-dist');
      pdfjs.GlobalWorkerOptions.workerSrc = new URL(
        'pdfjs-dist/build/pdf.worker.min.mjs',
        import.meta.url,
      ).toString();
      const pdf = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
      const page = await pdf.getPage(1);
      const viewport0 = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: (state.doc.media.widthMm * 4) / viewport0.width });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const context = canvas.getContext('2d');
      if (!context) throw new Error(t('design.referenceReadFailed'));
      await page.render({ canvasContext: context, viewport }).promise;
      dataUrl = canvas.toDataURL('image/png');
    } else if (file.type.startsWith('image/')) {
      dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () =>
          typeof reader.result === 'string'
            ? resolve(reader.result)
            : reject(new Error(t('design.referenceReadFailed')));
        reader.onerror = () => reject(new Error(t('design.referenceReadFailed')));
        reader.readAsDataURL(file);
      });
    } else throw new Error(t('design.referenceChooseFile'));
    state.doc.referenceImage = { dataUrl, opacity: 0.35, name: file.name };
    state.dirty = true;
  } catch (error) {
    referenceError.value = error instanceof Error ? error.message : t('design.referenceReadFailed');
  }
}
function onReferenceOpacity(e: Event): void {
  if (!state.doc?.referenceImage) return;
  state.doc.referenceImage.opacity = Number((e.target as HTMLInputElement).value);
  state.dirty = true;
}
function removeReference(): void {
  if (state.doc) {
    delete state.doc.referenceImage;
    state.dirty = true;
  }
}
const MIN_ZOOM = 3;
const MAX_ZOOM = 80;
const CANVAS_PAD = 96;
const fitMode = ref(false);
let fitObserver: ResizeObserver | undefined;

function zoom(d: number): void {
  fitMode.value = false;
  state.view.pxPerMm = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, state.view.pxPerMm + d));
}

function canvasScroll(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.canvas-scroll');
}

function applyFitZoom(): void {
  if (!state.doc) return;
  const scroll = canvasScroll();
  if (!scroll) return;
  if (scroll.clientWidth <= 0 || scroll.clientHeight <= 0) return;
  const availableW = Math.max(1, scroll.clientWidth - CANVAS_PAD);
  const availableH = Math.max(1, scroll.clientHeight - CANVAS_PAD);
  const fit = Math.floor(
    Math.min(availableW / state.doc.media.widthMm, availableH / state.doc.media.heightMm),
  );
  state.view.pxPerMm = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, fit));
}

function fitDesign(): void {
  fitMode.value = true;
  applyFitZoom();
}

watch(
  () => [state.doc?.id, state.doc?.media.widthMm, state.doc?.media.heightMm, state.activeView],
  () => {
    if (fitMode.value) void nextTick(applyFitZoom);
  },
);

onMounted(() => {
  void nextTick(() => {
    const scroll = canvasScroll();
    if (!scroll) return;
    fitObserver = new ResizeObserver(() => {
      if (fitMode.value) applyFitZoom();
    });
    fitObserver.observe(scroll);
  });
});

onBeforeUnmount(() => fitObserver?.disconnect());
</script>

<template>
  <div class="design">
    <div class="subbar">
      <div class="template-name">
        <span class="label">{{ t('design.currentTemplate') }}</span>
        <input v-if="state.doc" class="name" :value="state.doc.name" @input="onName" :placeholder="t('design.templateName')" />
      </div>
      <div class="command-group">
        <IconButton :icon="Save" :label="t('design.save')" :disabled="!state.dirty" @click="save" />
        <span v-if="state.dirty" class="dirty" :title="t('design.unsaved')"><i></i> {{ t('design.unsaved') }}</span>
        <IconButton :icon="Plus" :label="t('design.new')" @click="onNew" />
      </div>
      <div class="command-group reference-tools">
        <input ref="referenceInput" class="reference-file" type="file" accept="image/*,application/pdf,.pdf" @change="importReference" />
        <IconButton :icon="FileImage" :label="state.doc?.referenceImage ? t('design.referenceReplace') : t('design.referenceImport')" @click="referenceInput?.click()" />
        <template v-if="state.doc?.referenceImage">
          <span class="reference-name" :title="state.doc.referenceImage.name">{{ state.doc.referenceImage.name || 'Reference layer' }}</span>
          <label class="reference-opacity" :title="t('design.referenceOpacity')"><input type="range" min="0.05" max="1" step="0.05" :value="state.doc.referenceImage.opacity" @input="onReferenceOpacity" /></label>
          <IconButton :icon="Trash2" :label="t('design.referenceRemove')" @click="removeReference" />
        </template>
      </div>
      <span v-if="referenceError" class="reference-error">{{ referenceError }}</span>
      <div class="spacer"></div>
      <div class="command-group">
        <IconButton :icon="ZoomOut" :label="t('design.zoomOut')" @click="zoom(-2)" />
        <span class="zoom mono">{{ state.view.pxPerMm }}px/mm</span>
        <IconButton :icon="ZoomIn" :label="t('design.zoomIn')" @click="zoom(2)" />
        <IconButton :icon="Maximize2" :label="t('design.zoomFit')" :active="fitMode" @click="fitDesign" />
      </div>
      <div class="command-group">
        <IconButton :icon="Grid3x3" :label="t('design.showGrid')" :active="state.view.showGrid" @click="state.view.showGrid = !state.view.showGrid" />
        <IconButton :icon="Magnet" :label="t('design.snap')" :active="state.view.snap" @click="state.view.snap = !state.view.snap" />
        <label class="step"><span>{{ t('design.step') }}</span><input type="number" step="0.5" min="0" v-model.number="state.view.gridStep" /></label>
      </div>
    </div>

    <div class="workarea">
      <div class="panel left" :style="{ width: state.panels.left + 'px' }"><Toolbar /></div>
      <ResizeBar class="resize-left" side="left" />
      <LabelCanvas />
      <ResizeBar class="resize-right" side="right" />
      <div class="panel right" :style="{ width: state.panels.right + 'px' }">
        <PropertyPanel />
        <ParamDefsPanel />
      </div>
    </div>
  </div>
</template>

<style scoped>
.design {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
}
.subbar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
  background: var(--panel-subtle);
  flex: none;
  min-width: 0;
}
.template-name {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-width: 190px;
  max-width: 360px;
  flex: 0 1 320px;
}
.label {
  color: var(--muted);
  font-size: 12px;
  white-space: nowrap;
}
.name {
  min-width: 0;
  height: 30px;
  font-weight: 650;
}
.spacer {
  flex: 1;
  min-width: 0;
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
.dirty {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding-inline: 5px;
  color: var(--warn);
  font-size: 12px;
  white-space: nowrap;
}
.dirty i {
  width: 7px;
  height: 7px;
  border-radius: 999px;
  background: var(--warn);
  box-shadow: 0 0 0 3px var(--warn-soft);
}
.zoom {
  font-size: 11px;
  color: var(--muted);
  min-width: 56px;
  text-align: center;
}
.step {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--muted);
  padding-left: 4px;
}
.step input {
  width: 52px;
  height: 28px;
}
.reference-file { display: none; }
.reference-name { max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; color: var(--muted); }
.reference-opacity input { width: 64px; }
.reference-error { color: var(--warn); font-size: 11px; max-width: 150px; }
.workarea {
  flex: 1;
  display: grid;
  grid-template-columns: auto 6px minmax(0, 1fr) 6px auto;
  min-height: 0;
  min-width: 0;
  overflow: hidden;
}
.panel {
  flex: none;
  overflow-y: auto;
  min-height: 0;
  background: var(--panel);
  border-left: 1px solid var(--border);
  min-width: 0;
}
.panel.left {
  border-left: none;
  border-right: 1px solid var(--border);
}
/* right panel is a single scroll container; PropertyPanel + ParamDefsPanel flow inside */

@media (max-width: 860px) {
  .subbar {
    align-items: stretch;
    flex-wrap: wrap;
    gap: 8px;
  }
  .template-name {
    flex: 1 1 100%;
    max-width: none;
  }
  .command-group {
    flex: 0 0 auto;
  }
  .workarea {
    grid-template-columns: 70px minmax(0, 1fr);
    grid-template-rows: minmax(0, 1fr) minmax(240px, 42vh);
  }
  .resize-left,
  .resize-right {
    display: none;
  }
  .panel.left {
    grid-column: 1;
    grid-row: 1;
    width: auto !important;
  }
  .panel.right {
    grid-column: 1 / -1;
    grid-row: 2;
    width: auto !important;
    border-left: none;
    border-top: 1px solid var(--border);
  }
  .canvas-wrap {
    grid-column: 2;
    grid-row: 1;
  }
}

@media (max-width: 520px) {
  .subbar {
    padding: 7px;
  }
  .label,
  .dirty {
    display: none;
  }
  .command-group {
    max-width: 100%;
  }
  .workarea {
    grid-template-columns: 64px minmax(0, 1fr);
  }
}
</style>
