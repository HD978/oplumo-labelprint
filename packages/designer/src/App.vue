<script setup lang="ts">
import { TooltipProvider } from 'reka-ui';
import { onMounted } from 'vue';
import ConfirmHost from './components/ConfirmHost.vue';
import TopBar from './components/TopBar.vue';
import { initHashRouting, loadAll, state } from './lib/store';
import DesignView from './views/DesignView.vue';
import HistoryView from './views/HistoryView.vue';
import PrintView from './views/PrintView.vue';
import StudioView from './views/StudioView.vue';
import TemplatesView from './views/TemplatesView.vue';

onMounted(() => {
  initHashRouting();
  void loadAll();
});
</script>

<template>
  <TooltipProvider :delay-duration="250" :skip-delay-duration="0">
    <div class="app">
      <TopBar />
      <main class="workspace">
        <StudioView v-if="state.activeView === 'studio'" />
        <TemplatesView v-if="state.activeView === 'templates'" />
        <!-- design stays mounted (v-show) to preserve editor state when switching tabs -->
        <DesignView v-show="state.activeView === 'design'" />
        <PrintView v-if="state.activeView === 'print'" />
        <HistoryView v-if="state.activeView === 'history'" />
      </main>
    </div>
    <ConfirmHost />
  </TooltipProvider>
</template>

<style scoped>
.app {
  display: flex;
  flex-direction: row;
  height: 100%;
  min-width: 0;
}
.workspace {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
}

@media (max-width: 760px) {
  .app {
    flex-direction: column;
  }
}
</style>
