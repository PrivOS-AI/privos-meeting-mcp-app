import { afterEach, describe, expect, it } from 'vitest';

import { FILES_ORIGIN_PLACEHOLDER, createManifest, resolveFilesOrigin } from './manifest.js';

const original = process.env.PRIVOS_FILES_ORIGIN;
afterEach(() => {
  if (original === undefined) delete process.env.PRIVOS_FILES_ORIGIN;
  else process.env.PRIVOS_FILES_ORIGIN = original;
});

describe('resolveFilesOrigin', () => {
  it('leaves the placeholder untouched when PRIVOS_FILES_ORIGIN is unset', () => {
    delete process.env.PRIVOS_FILES_ORIGIN;
    const csp = JSON.stringify(createManifest().tools);
    expect(csp).toContain(FILES_ORIGIN_PLACEHOLDER);
  });

  it('substitutes the origin (trailing slash trimmed) into the manifest CSP', () => {
    process.env.PRIVOS_FILES_ORIGIN = 'https://files.example.com/';
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
    process.env.PRIVOS_FILES_ORIGIN = 'https://files.example.com';
    expect(resolveFilesOrigin({ a: 1 })).toEqual({ a: 1 });
  });
});
