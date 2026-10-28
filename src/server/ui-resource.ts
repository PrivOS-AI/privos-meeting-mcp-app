/**
 * Delivery of the app UI to the Hub iframe.
 *
 * Production serves the Vite split build (`dist/ui`, = `ui.distDir`) through the
 * SDK's `serveBuiltUi`: a shell whose `./assets/<file>` tags the Hub resolves as
 * `ui://<manifest name>/assets/<file>` — from the signed bundle on the
 * Marketplace, over `resources/read` on a relay install. Development points the
 * document at a live Vite origin instead, keeping HMR and breakpoints working
 * inside the Hub.
 */
import { MCP_UI_MIME, serveBuiltUi, type ServeBuiltUi, type UiResourceProvider } from '@privos_ai/app-server';

import { APP_ID, UI_RESOURCE_URI, manifest } from './manifest.js';
import { uiDistDir } from './paths.js';

let devPublicUrl: string | null = null;

export function setDevPublicUrl(publicUrl: string): void {
  devPublicUrl = publicUrl.replace(/\/$/, '');
}

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

/**
 * Lazy: `serveBuiltUi` throws when `dist/ui` is missing or malformed — importing
 * this module (tests, the manifest-only surface) must not require a build.
 */
let builtUi: ServeBuiltUi | null = null;
function getBuiltUi(): ServeBuiltUi {
  builtUi ??= serveBuiltUi({ distDir: uiDistDir, appSlug: APP_ID });
  return builtUi;
}

export function renderUiHtml(): string {
  return devPublicUrl ? devHtml(devPublicUrl) : getBuiltUi().renderHtml();
}

/**
 * One line per UI read, so "App assets unavailable" can be traced from the container log: whether the
 * Hub asked for the shell, the asset list or a file, and whether that file exists in this build. A Hub
 * that never asks for the assets named by the shell is serving a stale asset set (version not bumped).
 */
function logUiRead(kind: 'shell' | 'assets-manifest' | 'asset', detail = ''): void {
  console.log(`[ui] resources/read ${kind}${detail ? ` ${detail}` : ''}`);
}

export const uiResourceProvider: UiResourceProvider = {
  uri: UI_RESOURCE_URI,
  mimeType: MCP_UI_MIME,
  renderHtml: () => {
    logUiRead('shell');
    return renderUiHtml();
  },
  readAsset: (uri) => {
    if (devPublicUrl) return null;
    const asset = getBuiltUi().readAsset(uri);
    logUiRead('asset', `${uri.slice(uri.lastIndexOf('/') + 1)} ${asset ? 'found' : 'MISSING'}`);
    return asset;
  },
  readAssetsManifest: () => {
    if (devPublicUrl) return { files: [] };
    const assets = getBuiltUi().readAssetsManifest();
    logUiRead('assets-manifest', `${assets.files.length} files`);
    return assets;
  },
  assetUriPrefix: `ui://${APP_ID}/assets/`,
};
