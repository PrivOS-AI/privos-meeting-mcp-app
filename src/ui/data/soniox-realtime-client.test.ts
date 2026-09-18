import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Token } from '@soniox/speech-to-text-web';

interface FakeClientOptions {
  apiKey: string;
  onStarted?: () => void;
  onPartialResult?: (result: { tokens: Token[]; text: string; final_audio_proc_ms: number; total_audio_proc_ms: number }) => void;
  onError?: (status: string, message?: string, code?: number) => void;
  onFinished?: () => void;
}

class FakeSonioxClient {
  static instances: FakeSonioxClient[] = [];
  startedOptions: unknown;
  constructor(public options: FakeClientOptions) {
    FakeSonioxClient.instances.push(this);
  }
  start(audioOptions: unknown): Promise<void> {
    this.startedOptions = audioOptions;
    return Promise.resolve();
  }
  stop(): void {
    this.options.onFinished?.();
  }
}

vi.mock('@soniox/speech-to-text-web', () => ({ SonioxClient: FakeSonioxClient }));

const { createSonioxConnection } = await import('./soniox-realtime-client.js');
const { RealtimeConnectionCallbacksStub } = await import('./test-support/realtime-callbacks-stub.js');

function token(overrides: Partial<{ token: string; model: string }> = {}) {
  return {
    provider: 'soniox' as const,
    token: overrides.token ?? 'temp-key',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    model: overrides.model ?? 'stt-rt-v5',
    capabilities: { speakerLabels: true, translation: true },
  };
}

function makeToken(t: Partial<Token>): Token {
  return { text: '', start_ms: 0, end_ms: 0, confidence: 1, is_final: false, ...t };
}

beforeEach(() => {
  FakeSonioxClient.instances = [];
});

describe('createSonioxConnection', () => {
  it('passes the stream + camelCase options straight through to the SDK', async () => {
    const stream = {} as MediaStream;
    const stub = new RealtimeConnectionCallbacksStub();
    createSonioxConnection({ ...stub.options(), mintToken: async () => token(), stream, recorderEpochMs: 0, translate: true });
    await vi.waitFor(() => expect(FakeSonioxClient.instances).toHaveLength(1));

    const client = FakeSonioxClient.instances[0];
    expect(client.startedOptions).toMatchObject({
      model: 'stt-rt-v5',
      enableSpeakerDiarization: true,
      stream,
      translation: { type: 'two_way', language_a: 'vi', language_b: 'en' },
    });
  });

  it('namespaces speaker labels by sessionIndex and reports the started offset', async () => {
    const stub = new RealtimeConnectionCallbacksStub();
    createSonioxConnection({ ...stub.options(), mintToken: async () => token(), stream: {} as MediaStream, recorderEpochMs: 1000, translate: false });
    await vi.waitFor(() => expect(FakeSonioxClient.instances).toHaveLength(1));
    const client = FakeSonioxClient.instances[0];

    vi.spyOn(performance, 'now').mockReturnValue(1500);
    client.options.onStarted?.();
    expect(stub.started).toEqual([[0, 500]]);

    client.options.onPartialResult?.({
      tokens: [makeToken({ text: 'hello', speaker: '1', is_final: true, start_ms: 0, end_ms: 500 })],
      text: 'hello',
      final_audio_proc_ms: 500,
      total_audio_proc_ms: 500,
    });
    expect(stub.captions[0].speakerKey).toBe('s0:1');
    expect(stub.turns[stub.turns.length - 1]?.some((t) => t.speakerKey === 's0:1')).toBe(true);
  });

  it('replaces a draft caption with the final version under the SAME id', async () => {
    const stub = new RealtimeConnectionCallbacksStub();
    createSonioxConnection({ ...stub.options(), mintToken: async () => token(), stream: {} as MediaStream, recorderEpochMs: 0, translate: false });
    await vi.waitFor(() => expect(FakeSonioxClient.instances).toHaveLength(1));
    const client = FakeSonioxClient.instances[0];
    client.options.onStarted?.();

    client.options.onPartialResult?.({
      tokens: [makeToken({ text: 'hel', speaker: '1', is_final: false, start_ms: 0, end_ms: 200 })],
      text: 'hel',
      final_audio_proc_ms: 200,
      total_audio_proc_ms: 200,
    });
    const draftId = stub.captions.at(-1)!.id;
    expect(stub.captions.at(-1)!.kind).toBe('draft');

    client.options.onPartialResult?.({
      tokens: [makeToken({ text: 'hello', speaker: '1', is_final: true, start_ms: 0, end_ms: 500 })],
      text: 'hello',
      final_audio_proc_ms: 500,
      total_audio_proc_ms: 500,
    });
    const finalEvent = stub.captions.at(-1)!;
    expect(finalEvent.id).toBe(draftId);
    expect(finalEvent.kind).toBe('final');
    expect(finalEvent.text).toBe('hello');
  });

  it('excludes translation tokens from every LiveTurn, but still emits them as captions', async () => {
    const stub = new RealtimeConnectionCallbacksStub();
    createSonioxConnection({ ...stub.options(), mintToken: async () => token(), stream: {} as MediaStream, recorderEpochMs: 0, translate: true });
    await vi.waitFor(() => expect(FakeSonioxClient.instances).toHaveLength(1));
    const client = FakeSonioxClient.instances[0];
    client.options.onStarted?.();

    client.options.onPartialResult?.({
      tokens: [
        makeToken({ text: 'xin chào', speaker: '1', is_final: true, start_ms: 0, end_ms: 500, language: 'vi' }),
        makeToken({ text: 'hello', is_final: true, start_ms: 0, end_ms: 500, translation_status: 'translation', language: 'en' }),
      ],
      text: 'xin chào',
      final_audio_proc_ms: 500,
      total_audio_proc_ms: 500,
    });

    const lastTurns = stub.turns.at(-1) ?? [];
    expect(lastTurns.every((t) => !t.text.includes('hello'))).toBe(true);
    expect(stub.captions.some((c) => c.text === 'hello' && c.translationOf)).toBe(true);
  });
});
