// Local-only build. No Wrangler, network calls, credentials or deployment.

import { copyFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
await mkdir('dist', { recursive: true });
await copyFile(require.resolve('@resvg/resvg-wasm/index_bg.wasm'), 'dist/resvg.wasm');
await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  conditions: ['workerd', 'browser'],
  sourcemap: true,
  plugins: [
    {
      name: 'compiled-wasm',
      setup(b) {
        b.onResolve({ filter: /index_bg\.wasm$/ }, () => ({
          path: './resvg.wasm',
          external: true,
        }));
      },
    },
  ],
});
console.log('Local Worker bundle written to dist/ (not deployed).');
