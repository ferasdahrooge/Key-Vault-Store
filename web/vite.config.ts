import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Vite dev server proxies the API to the backend; build output is CSP-friendly.
export default defineConfig({
  // `@/…` imports resolve from src/.
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: 'http://localhost:8200', changeOrigin: false },
      '/healthz': { target: 'http://localhost:8200', changeOrigin: false },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    // The production CSP forbids inline scripts; keep everything in external files.
    modulePreload: { polyfill: false },
    assetsInlineLimit: 0,
  },
});
