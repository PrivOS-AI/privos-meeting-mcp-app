import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installFakeHub, type Store } from '../tools/test-support/fake-hub.js';

vi.mock('@privos_ai/app-server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@privos_ai/app-server')>();
  return { ...actual, createAgentBotHubClient: () => fakeHub };
});
vi.mock('../hub/resolve-hub-origin.js', () => ({ resolveHubOrigin: async () => 'https://hub.example' }));
vi.mock('../hub/resolve-own-mcp-app-id.js', () => ({ resolveOwnMcpAppId: async () => 'app-123' }));

let store: Store;
let fakeHub: ReturnType<typeof installFakeHub>;

const { AppDbBotClient } = await import('../hub/app-db-bot-client.js');
const { env } = await import('../env.js');
const { asyncProviderFor, resolveAsyncVendor } = await import('./stt-provider-registry.js');

describe('stt-provider-registry', () => {
  const originalAsync = env.asyncProvider;

  beforeEach(() => {
    store = { app_settings: [] };
    fakeHub = installFakeHub({ store });
  });

  afterEach(() => {
    env.asyncProvider = originalAsync;
  });

  it('falls back to the env default when app_settings has no override', async () => {
    env.asyncProvider = 'soniox';
    expect(await resolveAsyncVendor(new AppDbBotClient())).toBe('soniox');
  });

  it('uses the app_settings override when set', async () => {
    store.app_settings = [{ _id: 's1', key: 'sttAsyncProvider', valueJson: JSON.stringify('elevenlabs') }];
    expect(await resolveAsyncVendor(new AppDbBotClient())).toBe('elevenlabs');
  });

  it('asyncProviderFor maps each vendor to its own provider implementation', () => {
    expect(asyncProviderFor('soniox').vendor).toBe('soniox');
    expect(asyncProviderFor('elevenlabs').vendor).toBe('elevenlabs');
  });

  it('reports not-configured with a message naming the missing env key', async () => {
    const original = env.elevenLabsApiKey;
    env.elevenLabsApiKey = undefined;
    const status = await asyncProviderFor('elevenlabs').status();
    expect(status.configured).toBe(false);
    expect(status.detail).toMatch(/ELEVENLABS_API_KEY/);
    env.elevenLabsApiKey = original;
  });
});
