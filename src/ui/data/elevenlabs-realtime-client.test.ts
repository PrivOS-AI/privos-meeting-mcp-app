import { beforeEach, describe, expect, it, vi } from 'vitest';

type Listener = (data?: unknown) => void;

class FakeScribeConnection {
  listeners = new Map<string, Listener[]>();
  closed = false;
  on(event: string, listener: Listener): void {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
  }
  emit(event: string, data?: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(data);
  }
  close(): void {
    this.closed = true;
    this.emit('close');
  }
}

const RealtimeEventsFake = {
  SESSION_STARTED: 'session_started',
  PARTIAL_TRANSCRIPT: 'partial_transcript',
  FINAL_TRANSCRIPT: 'final_transcript',
  FINAL_TRANSCRIPT_WITH_TIMESTAMPS: 'final_transcript_with_timestamps',
  COMMITTED_TRANSCRIPT: 'committed_transcript',
  COMMITTED_TRANSCRIPT_WITH_TIMESTAMPS: 'committed_transcript_with_timestamps',
  COMMITTED_TRANSCRIPT_ENTITIES: 'committed_transcript_entities',
  AUTH_ERROR: 'auth_error',
  ERROR: 'error',
  OPEN: 'open',
  CLOSE: 'close',
  QUOTA_EXCEEDED: 'quota_exceeded',
  COMMIT_THROTTLED: 'commit_throttled',
  TRANSCRIBER_ERROR: 'transcriber_error',
  UNACCEPTED_TERMS: 'unaccepted_terms',
  RATE_LIMITED: 'rate_limited',
  INPUT_ERROR: 'input_error',
  INVALID_REQUEST: 'invalid_request',
  QUEUE_OVERFLOW: 'queue_overflow',
  RESOURCE_EXHAUSTED: 'resource_exhausted',
  SESSION_TIME_LIMIT_EXCEEDED: 'session_time_limit_exceeded',
  CHUNK_SIZE_EXCEEDED: 'chunk_size_exceeded',
  INSUFFICIENT_AUDIO_ACTIVITY: 'insufficient_audio_activity',
} as const;

let lastConnection: FakeScribeConnection | undefined;
let lastConnectOptions: Record<string, unknown> | undefined;

vi.mock('@elevenlabs/client', () => ({
  RealtimeEvents: RealtimeEventsFake,
  Scribe: {
    connect: (options: Record<string, unknown>) => {
      lastConnectOptions = options;
      lastConnection = new FakeScribeConnection();
      return lastConnection;
    },
  },
}));

const { createElevenLabsConnection } = await import('./elevenlabs-realtime-client.js');
const { RealtimeConnectionCallbacksStub } = await import('./test-support/realtime-callbacks-stub.js');

function token() {
  return {
    provider: 'elevenlabs' as const,
    token: 'temp-token',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    model: 'scribe_v2_realtime',
    capabilities: { speakerLabels: false, translation: false },
  };
}

beforeEach(() => {
  lastConnection = undefined;
  lastConnectOptions = undefined;
});

describe('createElevenLabsConnection', () => {
  it('connects with the minted token and microphone mode (no external stream option)', async () => {
    const stub = new RealtimeConnectionCallbacksStub();
    createElevenLabsConnection({ ...stub.options(), mintToken: async () => token(), stream: {} as MediaStream, recorderEpochMs: 0, translate: false });
    await vi.waitFor(() => expect(lastConnectOptions).toBeDefined());

    expect(lastConnectOptions).toMatchObject({ token: 'temp-token', modelId: 'scribe_v2_realtime', includeTimestamps: true });
    expect(lastConnectOptions?.microphone).toBeTruthy();
    expect('stream' in (lastConnectOptions ?? {})).toBe(false);
  });

  it('never emits a LiveTurn (ElevenLabs realtime has no diarization, QĐ-18)', async () => {
    const stub = new RealtimeConnectionCallbacksStub();
    createElevenLabsConnection({ ...stub.options(), mintToken: async () => token(), stream: {} as MediaStream, recorderEpochMs: 0, translate: false });
    await vi.waitFor(() => expect(lastConnection).toBeDefined());

    lastConnection!.emit(RealtimeEventsFake.SESSION_STARTED);
    lastConnection!.emit(RealtimeEventsFake.PARTIAL_TRANSCRIPT, { message_type: 'partial_transcript', text: 'hel' });
    lastConnection!.emit(RealtimeEventsFake.COMMITTED_TRANSCRIPT_WITH_TIMESTAMPS, {
      message_type: 'committed_transcript_with_timestamps',
      text: 'hello',
      words: [{ text: 'hello', start: 0, end: 0.5, type: 'word', logprob: 0 }],
    });

    expect(stub.turns).toEqual([]);
    expect(stub.captions.some((c) => c.text === 'hello' && c.kind === 'final')).toBe(true);
    expect(stub.captions.every((c) => c.speakerKey === undefined)).toBe(true);
  });

  it('treats any close/error event as the end of the session and reconnects with a fresh token', async () => {
    const stub = new RealtimeConnectionCallbacksStub();
    let mintCount = 0;
    createElevenLabsConnection({
      ...stub.options(),
      mintToken: async () => {
        mintCount += 1;
        return token();
      },
      stream: {} as MediaStream,
      recorderEpochMs: 0,
      translate: false,
    });
    await vi.waitFor(() => expect(mintCount).toBe(1));
    lastConnection!.emit(RealtimeEventsFake.SESSION_STARTED);
    lastConnection!.emit(RealtimeEventsFake.ERROR, { error: 'boom' });

    await vi.waitFor(() => expect(mintCount).toBe(2), { timeout: 3000 });
    expect(stub.statuses.some(([status]) => status === 'reconnecting')).toBe(true);
  });
});
