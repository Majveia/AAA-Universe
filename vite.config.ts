import { defineConfig } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  base: './',
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
  server: {
    host: true,
    port: 5173,
  },
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 4000,
    rollupOptions: {
      output: {
        // The function form, not the object form. Vite 8 bundles with rolldown,
        // which only accepts a function here — and rollup accepts both, so this
        // spelling works on the version pinned today and on the next major.
        // Splitting these two out keeps the app chunk small enough that a code
        // change does not invalidate 700 kB of unchanged vendor code.
        manualChunks(id: string) {
          if (id.includes('node_modules/three')) return 'three';
          if (id.includes('node_modules/postprocessing')) return 'postprocessing';
          return undefined;
        },
      },
    },
  },
});
