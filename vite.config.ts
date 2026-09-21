import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The UI is served to the Hub iframe two ways:
 * - dev: straight from this Vite server over a public origin (HMR + breakpoints)
 * - prod: built to dist/ui and inlined into a single HTML document by the app server
 *
 * The iframe runs in an opaque origin (`srcdoc`, no `allow-same-origin`), so
 * `import.meta.url` is `about:srcdoc` and sibling asset URLs never resolve.
 * That is why the bundle must inline every chunk — `inlineDynamicImports` plus a
 * single entry — instead of code-splitting.
 */
export default defineConfig({
  plugins: [react()],
  root: 'src/ui',
  build: {
    outDir: '../../dist/ui',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
        entryFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
  server: {
    port: Number(process.env.VITE_PORT || 5179),
    strictPort: true,
    cors: true,
  },
});
