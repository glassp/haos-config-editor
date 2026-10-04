import { defineConfig } from 'vite';

// `base: './'` keeps every asset URL relative, which is required behind
// Home Assistant ingress (the add-on is served under a random path prefix).
export default defineConfig({
  base: './',
  build: { outDir: '../server/public', emptyOutDir: true, chunkSizeWarningLimit: 1200 },
  server: { proxy: { '/api': 'http://127.0.0.1:8099' } },
});
