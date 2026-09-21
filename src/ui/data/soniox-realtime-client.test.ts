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
  it('keeps one speaker\'s words on ONE line, and starts a new line after a long pause', async () => {
    const stub = new RealtimeConnectionCallbacksStub();
    createSonioxConnection({ ...stub.options(), mintToken: async () => token(), stream: {} as MediaStream, recorderEpochMs: 0, translate: false });
    await vi.waitFor(() => expect(FakeSonioxClient.instances).toHaveLength(1));
    const client = FakeSonioxClient.instances[0];
    client.options.onStarted?.();

    client.options.onPartialResult?.({
      tokens: [
        makeToken({ text: 'xin ', speaker: '1', is_final: true, start_ms: 0, end_ms: 300 }),
        makeToken({ text: 'chào ', speaker: '1', is_final: true, start_ms: 320, end_ms: 600 }),
        makeToken({ text: 'mọi người', speaker: '1', is_final: true, start_ms: 650, end_ms: 1100 }),
        // same speaker resumes after a 3s silence -> new line
        makeToken({ text: 'tiếp theo', speaker: '1', is_final: true, start_ms: 4100, end_ms: 4700 }),
      ],
      text: '',
      final_audio_proc_ms: 4700,
      total_audio_proc_ms: 4700,
    });

    const lines = new Map(stub.captions.map((c) => [c.id, c.text]));
    expect([...lines.values()]).toEqual(['xin chào mọi người', 'tiếp theo']);
  });
  async function linesFor(tokens: Token[]): Promise<string[]> {
    const stub = new RealtimeConnectionCallbacksStub();
    createSonioxConnection({ ...stub.options(), mintToken: async () => token(), stream: {} as MediaStream, recorderEpochMs: 0, translate: false });
    await vi.waitFor(() => expect(FakeSonioxClient.instances).toHaveLength(1));
    const client = FakeSonioxClient.instances[0];
    client.options.onStarted?.();
    client.options.onPartialResult?.({ tokens, text: '', final_audio_proc_ms: 0, total_audio_proc_ms: 0 });
    return [...new Map(stub.captions.filter((c) => !c.translationOf).map((c) => [c.id, c.text])).values()];
  }
  const wordCount = (text: string) => text.trim().split(/\s+/).length;
  /** `n` one-word tokens from one speaker with no pause; `sentenceEndAt` puts a full stop on that word (1-based). */
  function monologue(n: number, sentenceEndAt?: number): Token[] {
    return Array.from({ length: n }, (_, i) =>
      makeToken({ text: `${i + 1 === sentenceEndAt ? 'word.' : 'word'} `, speaker: '1', is_final: true, start_ms: i * 300, end_ms: i * 300 + 290 }),
    );
  }

  it('keeps a monologue under the soft limit on one line', async () => {
    expect(await linesFor(monologue(90, 40))).toHaveLength(1);
  });
  it('past the soft limit, breaks at the END OF A SENTENCE rather than at a fixed size', async () => {
    const lines = await linesFor(monologue(140, 120));
    expect(lines).toHaveLength(2);
    expect(wordCount(lines[0])).toBe(120);
    expect(lines[0].trim().endsWith('.')).toBe(true);
  });
  it('past the soft limit, breaks at a short breath pause', async () => {
    const tokens = monologue(140);
    for (let i = 110; i < tokens.length; i++) { tokens[i].start_ms! += 600; tokens[i].end_ms! += 600; }
    const lines = await linesFor(tokens);
    expect(lines).toHaveLength(2);
    expect(wordCount(lines[0])).toBe(110);
  });
  it('hard-caps a line at 150 words when there is no sentence end or pause at all', async () => {
    const lines = await linesFor(monologue(200));
    expect(lines).toHaveLength(2);
    expect(wordCount(lines[0])).toBe(150);
  });
  it('builds up history when each response carries only NEW final tokens (Soniox sends a final once)', async () => {
    const stub = new RealtimeConnectionCallbacksStub();
    createSonioxConnection({ ...stub.options(), mintToken: async () => token(), stream: {} as MediaStream, recorderEpochMs: 0, translate: true });
    await vi.waitFor(() => expect(FakeSonioxClient.instances).toHaveLength(1));
    const client = FakeSonioxClient.instances[0];
    client.options.onStarted?.();

    client.options.onPartialResult?.({
      tokens: [makeToken({ text: 'chào anh', speaker: '1', is_final: true, start_ms: 0, end_ms: 800 })],
      text: '', final_audio_proc_ms: 800, total_audio_proc_ms: 800,
    });
    // second response: the first final is NOT repeated; a second speaker + a translation + a draft tail
    client.options.onPartialResult?.({
      tokens: [
        makeToken({ text: 'hello', is_final: true, translation_status: 'translation', language: 'en' }),
        makeToken({ text: 'chào em', speaker: '2', is_final: true, start_ms: 1000, end_ms: 1700 }),
        makeToken({ text: ' khoẻ', speaker: '2', is_final: false, start_ms: 1750, end_ms: 2000 }),
      ],
      text: '', final_audio_proc_ms: 1700, total_audio_proc_ms: 2000,
    });

    const latest = new Map(stub.captions.map((c) => [c.id, c]));
    const lines = [...latest.values()].filter((c) => !c.translationOf);
    expect(lines.map((c) => c.text)).toEqual(['chào anh', 'chào em khoẻ']);
    expect(lines.map((c) => c.speakerKey)).toEqual(['s0:1', 's0:2']);
    const translation = [...latest.values()].find((c) => c.translationOf);
    expect(translation).toMatchObject({ text: 'hello', translationOf: lines[0].id });
  });
});
