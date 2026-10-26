import { afterEach, describe, expect, it } from 'vitest';

import { FILES_ORIGIN_PLACEHOLDER, UI_RESOURCE_URI, createManifest, manifest, resolveFilesOrigin } from './manifest.js';

const original = process.env.FILES_ORIGIN;
afterEach(() => {
  if (original === undefined) delete process.env.FILES_ORIGIN;
  else process.env.FILES_ORIGIN = original;
});

describe('resolveFilesOrigin', () => {
  it('leaves the placeholder untouched when FILES_ORIGIN is unset', () => {
    delete process.env.FILES_ORIGIN;
    const csp = JSON.stringify(createManifest().tools);
    expect(csp).toContain(FILES_ORIGIN_PLACEHOLDER);
  });

  it('substitutes the origin (trailing slash trimmed) into the manifest CSP', () => {
    process.env.FILES_ORIGIN = 'https://files.example.com/';
    const uiTool = createManifest().tools[0] as { _meta: { ui: { csp: { 'connect-src': string[]; 'media-src': string[] } } } };
    const connect = uiTool._meta.ui.csp['connect-src'];
    const media = uiTool._meta.ui.csp['media-src'];
    expect(connect).toContain('https://files.example.com');
    expect(media).toEqual(['https://files.example.com']);
    expect(JSON.stringify(uiTool)).not.toContain(FILES_ORIGIN_PLACEHOLDER);
    // Vendor WS origins must survive untouched.
    expect(connect).toContain('wss://stt-rt.soniox.com');
  });

  it('is a no-op clone for values without the placeholder', () => {
    process.env.FILES_ORIGIN = 'https://files.example.com';
    expect(resolveFilesOrigin({ a: 1 })).toEqual({ a: 1 });
  });
});

describe('marketplace contract', () => {
  it('keeps every ui:// host equal to the manifest name (split assets resolve at ui://<name>/assets/…)', () => {
    const hosts = manifest.tools.flatMap((tool) => {
      const t = tool as { ui?: { resourceUri?: string }; _meta?: { ui?: { resourceUri?: string } } };
      return [t.ui?.resourceUri, t._meta?.ui?.resourceUri].filter((uri): uri is string => Boolean(uri));
    }).map((uri) => new URL(uri).host);
    expect(hosts.length).toBeGreaterThan(0);
    expect(new Set(hosts)).toEqual(new Set([manifest.name]));
    expect(UI_RESOURCE_URI.startsWith(`ui://${manifest.name}/`)).toBe(true);
  });

  it('points ui.distDir at the Vite split-build output', () => {
    expect((manifest as { ui?: { distDir?: string } }).ui?.distDir).toBe('dist/ui');
  });

  it('declares no runtime-owned or reserved env keys', () => {
    const allowed = new Set(['PRIVOS_AGENT_BOT_USER_ID', 'PRIVOS_AGENT_BOT_CREDENTIAL']);
    for (const { key } of manifest.env) {
      expect(['PORT', 'HOME', 'PATH']).not.toContain(key);
      if (key.startsWith('PRIVOS_')) expect(allowed.has(key)).toBe(true);
    }
  });
});
