import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolCallContext } from '@privos_ai/app-server';

import { installFakeHub, type Store } from './test-support/fake-hub.js';

vi.mock('@privos_ai/app-server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@privos_ai/app-server')>();
  return { ...actual, createAgentBotHubClient: () => fakeHub };
});
vi.mock('../hub/resolve-hub-origin.js', () => ({ resolveHubOrigin: async () => 'https://hub.example' }));
vi.mock('../hub/resolve-own-mcp-app-id.js', () => ({ resolveOwnMcpAppId: async () => 'app-123' }));

let store: Store;
let fakeHub: ReturnType<typeof installFakeHub>;

const { env } = await import('../env.js');
const { sttStatusTool } = await import('./stt-status-tool.js');

function context(claims: Record<string, unknown> = {}): ToolCallContext {
  return { transport: 'direct', identityState: 'verified', sessionScope: 'test', actor: { userId: 'user-1', roomId: 'room-1', claims, provenance: 'user-token' } };
}

describe('meeting_stt_status', () => {
  const originalSoniox = env.sonioxApiKey;
  const originalEleven = env.elevenLabsApiKey;

  beforeEach(() => {
    store = { app_settings: [] };
    fakeHub = installFakeHub({ store });
    env.sonioxApiKey = undefined;
    env.elevenLabsApiKey = undefined;
  });

  afterEach(() => {
    env.sonioxApiKey = originalSoniox;
    env.elevenLabsApiKey = originalEleven;
    vi.unstubAllGlobals();
  });

  it('a caller not bound to a room only ever gets {ok} — no provider names, models or usage', async () => {
    const roomless = context();
    (roomless.actor as { roomId?: string }).roomId = undefined;
    const result = (await sttStatusTool.execute({}, roomless, {} as never)) as Record<string, unknown>;
    expect(Object.keys(result)).toEqual(['ok']);
  });

  it('an admin caller gets the full status shape with both vendors, never a key', async () => {
    const result = (await sttStatusTool.execute({}, context({ isAdmin: true }), {} as never)) as {
      ok: boolean;
      activeRealtimeProvider: string;
      activeAsyncProvider: string;
      providers: Array<{ provider: string; kind: string; configured: boolean }>;
      liveConcurrency: { max: number };
    };
    expect(result.ok).toBe(true);
    expect(result.activeRealtimeProvider).toBe('soniox');
    expect(result.activeAsyncProvider).toBe('soniox');
    expect(result.providers).toHaveLength(4);
    expect(result.providers.every((p) => p.configured === false)).toBe(true);
    expect(result.liveConcurrency.max).toBe(env.liveMaxConcurrentRecordings);
    // The detail message legitimately NAMES the missing env var (SONIOX_API_KEY) — that is not a secret.
    // What must never appear is an actual key VALUE.
    expect(JSON.stringify(result)).not.toContain('test-key');
  });

  it('an admin caller sees a configured+ok vendor when its cheap probe succeeds', async () => {
    env.sonioxApiKey = 'test-key';
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({}) }) as Response));

    const result = (await sttStatusTool.execute({}, context({ role: 'admin' }), {} as never)) as {
      providers: Array<{ provider: string; kind: string; configured: boolean; ok: boolean }>;
    };
    const sonioxRealtime = result.providers.find((p) => p.provider === 'soniox' && p.kind === 'realtime');
    expect(sonioxRealtime).toMatchObject({ configured: true, ok: true });
  });

  it('an admin caller sees invalid_key when the probe gets a 401', async () => {
    env.elevenLabsApiKey = 'bad-key';
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) }) as Response));

    const result = (await sttStatusTool.execute({}, context({ roles: ['admin'] }), {} as never)) as {
      providers: Array<{ provider: string; kind: string; ok: boolean; reason?: string }>;
    };
    const elevenAsync = result.providers.find((p) => p.provider === 'elevenlabs' && p.kind === 'async');
    expect(elevenAsync).toMatchObject({ ok: false, reason: 'invalid_key' });
  });
});
