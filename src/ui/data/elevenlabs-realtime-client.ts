/**
 * ElevenLabs realtime wrapper. Scribe realtime has NO speaker diarization —
 * this wrapper NEVER emits a `LiveTurn` and its provider capabilities are
 * fixed `speakerLabels:false` regardless of anything the SDK returns (D-18).
 *
 * OPEN QUESTION (spike P1-10/P1-11, D-01): the installed `@elevenlabs/client`
 * 1.25 `ScribeRealtime.connect()` has no option to hand it an existing
 * `MediaStream` — only `microphone:{...}` (the SDK does its OWN internal
 * `getUserMedia`) or manual `AudioOptions` (we would have to encode/send audio
 * ourselves, which D-01 forbids). Default here: `microphone` mode — the SDK
 * opens a second, independent mic capture alongside our own MediaRecorder
 * stream. This means two concurrent mic opens for the same physical device
 * (functionally fine in every browser tested to date); revisit once a spike
 * confirms an SDK version/mode that accepts an external `MediaStream`.
 */
import { RealtimeEvents, Scribe } from '@elevenlabs/client';
import type {
  CommittedTranscriptMessage,
  CommittedTranscriptWithTimestampsMessage,
  PartialTranscriptMessage,
  RealtimeConnection as ScribeConnection,
} from '@elevenlabs/client';

import {
  MAX_RECONNECT_ATTEMPTS,
  RECONNECT_BACKOFF_MS,
  SESSION_ROLL_MS,
  type RealtimeConnection,
  type RealtimeConnectionOptions,
} from './realtime-client.js';

/** Every event that means "this session is over" — mirrors D-01/S2 "any close/error ends the session". */
const END_EVENTS: RealtimeEvents[] = [
  RealtimeEvents.CLOSE,
  RealtimeEvents.ERROR,
  RealtimeEvents.AUTH_ERROR,
  RealtimeEvents.QUOTA_EXCEEDED,
  RealtimeEvents.COMMIT_THROTTLED,
  RealtimeEvents.TRANSCRIBER_ERROR,
  RealtimeEvents.UNACCEPTED_TERMS,
  RealtimeEvents.RATE_LIMITED,
  RealtimeEvents.INPUT_ERROR,
  RealtimeEvents.INVALID_REQUEST,
  RealtimeEvents.QUEUE_OVERFLOW,
  RealtimeEvents.RESOURCE_EXHAUSTED,
  RealtimeEvents.SESSION_TIME_LIMIT_EXCEEDED,
  RealtimeEvents.CHUNK_SIZE_EXCEEDED,
  RealtimeEvents.INSUFFICIENT_AUDIO_ACTIVITY,
];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Every `END_EVENTS` payload carries at least `{ error?: string }` (CLOSE
 * carries a `CloseEvent` instead) — this narrow cast avoids repeating the same
 * listener registration 15 times with per-event payload types we never read.
 */
function onSessionEnd(connection: ScribeConnection, event: RealtimeEvents, handle: (reason: string) => void): void {
  const listener = (data: unknown) => {
    const reason = data && typeof data === 'object' && typeof (data as { error?: unknown }).error === 'string' ? (data as { error: string }).error : event;
    handle(reason);
  };
  (connection.on as unknown as (e: RealtimeEvents, l: (data: unknown) => void) => void)(event, listener);
}

type EndReason = 'app-stop' | 'roll' | `error:${string}` | `mint-error:${string}` | `start-error:${string}`;

export function createElevenLabsConnection(opts: RealtimeConnectionOptions): RealtimeConnection {
  let sessionIndex = 0;
  let stopped = false;
  let current: ScribeConnection | null = null;
  let rollRequested = false;
  let rollTimer: ReturnType<typeof setTimeout> | null = null;

  function clearRollTimer(): void {
    if (rollTimer) clearTimeout(rollTimer);
    rollTimer = null;
  }

  function openSession(index: number): Promise<{ endedReason: EndReason }> {
    return new Promise((resolve) => {
      rollRequested = false;
      let sessionOffsetMs = 0;
      let committedSeq = 0;

      opts
        .mintToken()
        .then((token) => {
          if (stopped) {
            resolve({ endedReason: 'app-stop' });
            return;
          }

          let connection: ScribeConnection;
          try {
            connection = Scribe.connect({
              token: token.token,
              modelId: token.model ?? 'scribe_v2_realtime',
              includeTimestamps: true,
              microphone: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
            });
          } catch (error) {
            resolve({ endedReason: `start-error:${String(error)}` });
            return;
          }
          current = connection;

          const endSession = (reason: string) => {
            clearRollTimer();
            resolve({ endedReason: stopped ? 'app-stop' : rollRequested ? 'roll' : `error:${reason}` });
          };

          connection.on(RealtimeEvents.SESSION_STARTED, () => {
            sessionOffsetMs = performance.now() - opts.recorderEpochMs;
            opts.onStarted(index, sessionOffsetMs);
            opts.onStatus('live', { sessionIndex: index });
            clearRollTimer();
            rollTimer = setTimeout(() => {
              rollRequested = true;
              connection.close();
            }, SESSION_ROLL_MS);
          });

          connection.on(RealtimeEvents.PARTIAL_TRANSCRIPT, (msg: PartialTranscriptMessage) => {
            // No per-token timestamp is ever provided for interim results — approximate with "now".
            const elapsedSec = (performance.now() - opts.recorderEpochMs) / 1000;
            opts.onCaption({ kind: 'draft', id: `s${index}:draft`, text: msg.text, atSec: elapsedSec, endSec: elapsedSec });
          });

          connection.on(RealtimeEvents.COMMITTED_TRANSCRIPT_WITH_TIMESTAMPS, (msg: CommittedTranscriptWithTimestampsMessage) => {
            const words = (msg.words ?? []).filter((w) => w.type === 'word');
            const firstStart = words.find((w) => typeof w.start === 'number')?.start ?? 0;
            const lastEnd = [...words].reverse().find((w) => typeof w.end === 'number')?.end ?? firstStart;
            opts.onCaption({
              kind: 'final',
              id: `s${index}:committed:${committedSeq++}`,
              text: msg.text,
              atSec: (sessionOffsetMs + firstStart * 1000) / 1000,
              endSec: (sessionOffsetMs + lastEnd * 1000) / 1000,
              lang: msg.language_code,
            });
            // Never a LiveTurn — ElevenLabs realtime carries no speaker id (D-18).
          });

          connection.on(RealtimeEvents.COMMITTED_TRANSCRIPT, (msg: CommittedTranscriptMessage) => {
            // Fallback only — normally superseded by the _WITH_TIMESTAMPS variant above.
            const elapsedSec = (performance.now() - opts.recorderEpochMs) / 1000;
            opts.onCaption({ kind: 'final', id: `s${index}:committed:${committedSeq++}`, text: msg.text, atSec: elapsedSec, endSec: elapsedSec });
          });

          for (const event of END_EVENTS) onSessionEnd(connection, event, endSession);
        })
        .catch((error: unknown) => resolve({ endedReason: `mint-error:${String(error)}` }));
    });
  }

  async function runLoop(): Promise<void> {
    let attempt = 0;
    while (!stopped) {
      const index = sessionIndex;
      opts.onStatus(attempt === 0 ? 'connecting' : 'reconnecting', { sessionIndex: index });
      const { endedReason } = await openSession(index);
      if (stopped || endedReason === 'app-stop') return;
      if (endedReason === 'roll') {
        sessionIndex += 1;
        attempt = 0;
        continue;
      }
      attempt += 1;
      if (attempt > MAX_RECONNECT_ATTEMPTS) {
        opts.onStatus('off', { sessionIndex: index, error: endedReason });
        return;
      }
      opts.onStatus('reconnecting', { sessionIndex: index, error: endedReason });
      await sleep(RECONNECT_BACKOFF_MS[attempt - 1]);
      sessionIndex += 1;
    }
  }

  const loopPromise = runLoop();

  return {
    async stop() {
      stopped = true;
      clearRollTimer();
      current?.close();
      await loopPromise;
    },
  };
}
