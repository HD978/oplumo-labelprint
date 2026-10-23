import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';
export default defineConfig({
  plugins: [vue()],
  build: { target: 'esnext' },
  server: { proxy: { '/api': 'http://localhost:8787' } },
});
