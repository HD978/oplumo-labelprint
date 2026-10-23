<script setup lang="ts">
import { TooltipProvider } from 'reka-ui';
import { computed, onMounted, ref } from 'vue';
import ConfirmHost from './components/ConfirmHost.vue';
import { initHashRouting, loadAll, setActiveView, state } from './lib/store';
import { account, api, role, who } from './lib/v2';
import DesignView from './views/DesignView.vue';
import PrintView from './views/PrintView.vue';
import TemplatesView from './views/TemplatesView.vue';
import V2Console from './views/V2Console.vue';

const email = ref(''),
  password = ref(''),
  error = ref(''),
  busy = ref(false),
  section = ref('dashboard');
const manager = computed(() => role() !== 'worker');
const sections = computed(() =>
  [
    { id: 'dashboard', name: '工作台' },
    { id: 'skus', name: 'SKU 主档' },
    { id: 'mapping', name: 'Master Mapping' },
    { id: 'jobs', name: '批量任务 / 打印' },
    { id: 'files', name: '文件与导出' },
    { id: 'users', name: '人员与权限' },
    ...(account.me?.is_platform_admin ? [{ id: 'platform', name: '租户管理' }] : []),
  ].filter((s) => manager.value || ['dashboard', 'jobs', 'files'].includes(s.id)),
);
async function init() {
  await who();
  if (account.me && account.workspace) {
    initHashRouting();
    await loadAll();
  }
}
onMounted(init);
async function login() {
  busy.value = true;
  error.value = '';
  try {
    await api('/api/auth/login', 'POST', { email: email.value, password: password.value });
    password.value = '';
    await init();
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
async function switchWorkspace() {
  localStorage.setItem('oplumo.workspace', account.workspace);
  state.doc = null;
  state.templates = [];
  state.printValues = {};
  state.dirty = false;
  section.value = 'dashboard';
  await loadAll();
}
async function logout() {
  await api('/api/auth/logout', 'POST');
  account.me = null;
  state.doc = null;
  state.templates = [];
}
function navigate(id: string) {
  section.value = id;
  if (id === 'templates') setActiveView('templates');
}
</script>
<template><TooltipProvider><div v-if="account.loading" class="login">正在连接工作区…</div><form v-else-if="!account.me" class="login" @submit.prevent="login"><div class="login-card"><div class="wordmark">OPLUMO <small>LABEL STUDIO V2</small></div><h1>登录工厂工作区</h1><p>标签设计 · 主档对应 · 批量打印</p><label>邮箱<input v-model="email" type="email" required autocomplete="username" /></label><label>密码<input v-model="password" type="password" required autocomplete="current-password" /></label><p v-if="error" role="alert">{{ error }}</p><button class="primary" :disabled="busy">{{busy?'登录中…':'登录'}}</button></div></form><div v-else class="v2app"><aside class="nav"><div class="wordmark">OPLUMO<small>LABEL STUDIO V2</small></div><label>当前企业<select v-model="account.workspace" @change="switchWorkspace"><option v-for="m in account.me.memberships" :value="m.workspace_id">{{m.name}}</option></select></label><button v-for="s in sections" :class="{active:section===s.id}" @click="navigate(s.id)">{{s.name}}</button><button v-if="manager" :class="{active:section==='templates'}" @click="navigate('templates')">标签模板 / 设计</button><div class="identity"><b>{{account.me.name}}</b><small>{{role()?.toUpperCase()}} · {{account.me.email}}</small><button @click="logout">退出登录</button></div></aside><main><header><div><b>{{account.me.memberships.find(m=>m.workspace_id===account.workspace)?.name}}</b><span>Cloudflare 工作区 · {{ role()?.toUpperCase() }}</span></div><span role="status">{{state.status}}</span></header><template v-if="section==='templates'&&manager"><TemplatesView v-if="state.activeView==='templates'"/><DesignView v-else-if="state.activeView==='design'"/><PrintView v-else-if="state.activeView==='print'"/></template><V2Console v-else :key="account.workspace+section" :section="section" /></main></div><ConfirmHost/></TooltipProvider></template>
<style>.v2app{display:flex;height:100%;color:var(--text);background:var(--bg)}.nav{width:220px;flex-shrink:0;border-right:1px solid var(--border);padding:24px 16px;display:flex;flex-direction:column;gap:8px;background:var(--panel)}.wordmark{font-size:21px;letter-spacing:1px;font-weight:800;margin-bottom:24px}.wordmark small{display:block;color:var(--muted);font-size:10px;letter-spacing:2px;margin-top:5px}.nav label{font-size:11px;display:grid;gap:8px;margin-bottom:16px;color:var(--muted)}.nav select{width:100%;min-width:0}.nav>button{text-align:left;justify-content:flex-start;border:0;background:transparent;padding:12px;height:auto}.nav>button.active{background:var(--accent-soft);color:var(--accent);font-weight:bold}.identity{margin-top:auto;display:grid;gap:10px;font-size:12px}.identity small{color:var(--muted);overflow-wrap:anywhere}.v2app main{display:flex;flex-direction:column;flex:1;min-width:0;overflow:hidden}.v2app main>header{padding:16px 24px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;font-size:12px;background:var(--panel);gap:20px}.v2app main>header div{display:flex;gap:18px}.v2app main>header span{color:var(--muted);font-size:11px}.login{height:100%;display:grid;place-items:center;background:#edf3fc}.login-card{background:white;color:#17223b;border:1px solid #dce4ef;border-radius:18px;padding:40px;width:380px;max-width:90vw;display:grid;gap:16px;box-shadow:0 20px 80px #10254a12}.login-card h1{font-size:22px;margin:0}.login-card p{font-size:13px;color:#64748b}.login-card label{display:grid;gap:8px;font-size:12px}.primary{background:var(--accent);color:white;border-color:var(--accent)}@media(max-width:760px){.v2app{flex-direction:column}.nav{width:100%;padding:12px;flex-direction:row;flex-wrap:wrap;gap:4px}.nav .wordmark{font-size:15px;margin:0 12px 0 0}.nav .wordmark small,.identity small{display:none}.nav label{margin:0;max-width:160px}.nav>button{padding:7px;font-size:11px}.identity{margin:0;display:flex;align-items:center}.v2app main>header{padding:10px}.v2app main>header div{gap:8px}.login-card{padding:24px}}</style>
