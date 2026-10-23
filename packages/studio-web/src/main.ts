import { createApp } from 'vue';
import App from './App.vue';
import { setLocaleChoice, syncDocumentLocale } from './lib/i18n';
import { syncDocumentTheme } from './lib/theme';
import { installApi } from './lib/v2';
import './style.css';

installApi();
if (!localStorage.getItem('lp.locale')) setLocaleChoice('zh-CN');
syncDocumentLocale();
syncDocumentTheme();
createApp(App).mount('#app');
