/**
 * Delivery of the app UI to the Hub iframe.
 *
 * Production inlines the built bundle into one self-contained HTML document —
 * the iframe runs in an opaque origin and cannot fetch sibling asset URLs.
 * Development points the document at a live Vite origin instead, keeping HMR
 * and breakpoints working inside the Hub.
 */
import fs from 'node:fs';
import path from 'node:path';

import { MCP_UI_MIME, type UiResourceProvider } from '@privos_ai/app-server';

import { UI_RESOURCE_URI, manifest } from './manifest.js';
import { uiDistDir } from './paths.js';

let devPublicUrl: string | null = null;

export function setDevPublicUrl(publicUrl: string): void {
  devPublicUrl = publicUrl.replace(/\/$/, '');
}

let cachedHtml: string | null = null;
let cachedAssetsMtime = 0;

function devHtml(publicUrl: string): string {
  return `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${manifest.title} (dev)</title>
  <script type="module" src="${publicUrl}/@vite/client"></script>
  <script type="module">
    import RefreshRuntime from "${publicUrl}/@react-refresh";
    RefreshRuntime.injectIntoGlobalHook(window);
    window.$RefreshReg$ = () => {};
    window.$RefreshSig$ = () => (type) => type;
    window.__vite_plugin_react_preamble_installed__ = true;
  </script>
</head>
<body><div id="root"></div>
<script type="module" src="${publicUrl}/main.tsx"></script>
</body>
</html>`;
}

function inlineHtml(): string {
  const assetsDir = path.join(uiDistDir, 'assets');
  if (!fs.existsSync(assetsDir)) {
    throw new Error('UI is not built. Run `npm run build` before starting in production mode.');
  }
  const mtime = fs.statSync(assetsDir).mtimeMs;
  if (cachedHtml && mtime === cachedAssetsMtime) return cachedHtml;

  const files = fs.readdirSync(assetsDir);
  const js = files.filter((f) => f.endsWith('.js')).map((f) => fs.readFileSync(path.join(assetsDir, f), 'utf8'));
  const css = files.filter((f) => f.endsWith('.css')).map((f) => fs.readFileSync(path.join(assetsDir, f), 'utf8'));

  cachedHtml = `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${manifest.title}</title>
  <style>${css.join('\n')}</style>
</head>
<body><div id="root"></div>
<script type="module">${js.join('\n')}</script>
</body>
</html>`;
  cachedAssetsMtime = mtime;
  return cachedHtml;
}

export function renderUiHtml(): string {
  return devPublicUrl ? devHtml(devPublicUrl) : inlineHtml();
}

export const uiResourceProvider: UiResourceProvider = {
  uri: UI_RESOURCE_URI,
  mimeType: MCP_UI_MIME,
  renderHtml: () => renderUiHtml(),
};
