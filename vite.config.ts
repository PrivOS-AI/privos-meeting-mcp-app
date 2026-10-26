import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The UI is served to the Hub iframe two ways:
 * - dev: straight from this Vite server over a public origin (HMR + breakpoints)
 * - prod: a split build in dist/ui (= `ui.distDir`), served by `serveBuiltUi` —
 *   the shell references `./assets/<file>` and the Hub resolves each one as
 *   `ui://<manifest name>/assets/<file>` (Marketplace: from the signed bundle;
 *   relay: over `resources/read`).
 *
 * Never force a single chunk (`inlineDynamicImports`): the signed bundle caps
 * every file at 2 MB.
 */
export default defineConfig({
  plugins: [react()],
  root: 'src/ui',
  base: './',
  build: {
    outDir: '../../dist/ui',
    emptyOutDir: true,
    manifest: true,
    sourcemap: false,
    // Every referenced asset becomes a real hashed `assets/` file, never a data URI —
    // split-asset serving needs a filename to address over `ui://…/assets/<file>`.
    assetsInlineLimit: 0,
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['react', 'react-dom', '@privos_ai/app-react'],
        },
      },
    },
  },
  server: {
    port: Number(process.env.VITE_PORT || 5179),
    strictPort: true,
    cors: true,
  },
});
