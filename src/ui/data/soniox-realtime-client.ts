/**
 * Soniox realtime wrapper — the ONLY provider with live speaker diarization
 * (QĐ-18) and native two-way translation. The SDK self-captures from the
 * `MediaStream` we give it (spike P1-10 pinned `@soniox/speech-to-text-web`);
 * this module never touches PCM, backpressure or the wire protocol (QĐ-01).
 *
 * `onPartialResult(result)` is documented as "the current recognized state"
 * rather than a delta stream (open question #2/#3 — unverified against a live
 * call). This wrapper assumes `result.tokens` is the FULL cumulative token
 * list for the current SDK session so far, diffs it against the previous
 * snapshot to avoid re-emitting unchanged captions, and rebuilds the turn
 * grouping from the full snapshot each time (cheap: turn count is bounded by
 * speaker switches, not token count).
 */
import { SonioxClient } from '@soniox/speech-to-text-web';
import type { SpeechToTextAPIResponse, Token } from '@soniox/speech-to-text-web';

import {
  MAX_RECONNECT_ATTEMPTS,
  RECONNECT_BACKOFF_MS,
  SESSION_ROLL_MS,
  type CaptionEvent,
  type LiveTurn,
  type RealtimeConnection,
  type RealtimeConnectionOptions,
} from './realtime-client.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface BuildResult {
  captions: CaptionEvent[];
  turns: LiveTurn[];
}

/**
 * Group the FULL cumulative token snapshot into one caption LINE per speaker
 * run (a "turn"), not one per token — otherwise every word starts a new line.
 * Line ids are stable across snapshots (`turn{n}` in appearance order), so
 * `applyCaption` keeps updating the same growing line as more tokens stream and
 * flips it draft->final in place. Re-emitting all turns each snapshot is cheap:
 * turn count is bounded by speaker switches, not token count.
 */
function buildFromSnapshot(sessionIndex: number, tokens: Token[], offsetMs: number): BuildResult {
  const captions: CaptionEvent[] = [];
  const turns: LiveTurn[] = [];
  const toMeetingSec = (rawMs: number | undefined) => (offsetMs + (rawMs ?? 0)) / 1000;

  // Current original (non-translation) speaker run.
  let current: { id: string; speakerKey: string; startMsRaw: number; endMsRaw: number; text: string; final: boolean; lang?: string } | null = null;
  let turnIndex = 0;
  // Current translation run, linked to the original turn open when it started.
  let translation: { id: string; text: string; final: boolean; translationOf?: string; lang?: string } | null = null;
  let translationIndex = 0;

  const flushTurn = () => {
    if (!current) return;
    turns.push({ id: current.id, speakerKey: current.speakerKey, startMs: offsetMs + current.startMsRaw, endMs: offsetMs + current.endMsRaw, text: current.text, final: current.final });
    captions.push({ kind: current.final ? 'final' : 'draft', id: current.id, text: current.text, atSec: toMeetingSec(current.startMsRaw), endSec: toMeetingSec(current.endMsRaw), speakerKey: current.speakerKey, lang: current.lang });
    current = null;
  };
  const flushTranslation = () => {
    if (!translation) return;
    captions.push({ kind: translation.final ? 'final' : 'draft', id: translation.id, text: translation.text, atSec: 0, endSec: 0, translationOf: translation.translationOf, lang: translation.lang });
    translation = null;
  };

  tokens.forEach((token) => {
    if (token.translation_status === 'translation') {
      // Translation tokens carry no timestamp and never join a LiveTurn (QĐ-12);
      // group them into their own line linked to the original turn now open.
      const translationOf = current?.id;
      if (translation && translation.translationOf === translationOf) {
        translation.text += token.text;
        translation.final = token.is_final;
        translation.lang = token.language ?? translation.lang;
      } else {
        flushTranslation();
        translation = { id: `s${sessionIndex}:trans${translationIndex++}`, text: token.text, final: token.is_final, translationOf, lang: token.language };
      }
      return;
    }

    const speakerKey = token.speaker ? `s${sessionIndex}:${token.speaker}` : `s${sessionIndex}:unknown`;
    if (current && current.speakerKey === speakerKey) {
      current.text += token.text;
      current.endMsRaw = token.end_ms ?? current.endMsRaw;
      current.final = token.is_final;
      current.lang = token.language ?? current.lang;
    } else {
      flushTurn();
      current = { id: `s${sessionIndex}:turn${turnIndex++}`, speakerKey, startMsRaw: token.start_ms ?? 0, endMsRaw: token.end_ms ?? token.start_ms ?? 0, text: token.text, final: token.is_final, lang: token.language };
    }
  });
  flushTurn();
  flushTranslation();

  return { captions, turns };
}

type EndReason = 'app-stop' | 'roll' | `error:${string}` | `mint-error:${string}` | `start-error:${string}`;

export function createSonioxConnection(opts: RealtimeConnectionOptions): RealtimeConnection {
  let sessionIndex = 0;
  let stopped = false;
  let currentClient: SonioxClient | null = null;
  let rollRequested = false;
  let rollTimer: ReturnType<typeof setTimeout> | null = null;
  const offsetBySession = new Map<number, number>();
  const turnsBySession = new Map<number, LiveTurn[]>();

  function clearRollTimer(): void {
    if (rollTimer) clearTimeout(rollTimer);
    rollTimer = null;
  }

  function handlePartialResult(index: number, result: SpeechToTextAPIResponse): void {
    const offsetMs = offsetBySession.get(index) ?? 0;
    const { captions, turns } = buildFromSnapshot(index, result.tokens, offsetMs);
    turnsBySession.set(index, turns);
    for (const caption of captions) opts.onCaption(caption);
    opts.onTurns([...turnsBySession.values()].flat());
  }

  /** Mint a fresh token, start one Soniox session, and resolve once it ends (for any reason). */
  function openSession(index: number): Promise<{ endedReason: EndReason }> {
    return new Promise((resolve) => {
      rollRequested = false;
      opts
        .mintToken()
        .then((token) => {
          if (stopped) {
            resolve({ endedReason: 'app-stop' });
            return;
          }
          const client = new SonioxClient({
            apiKey: token.token,
            onStarted: () => {
              const offsetMs = performance.now() - opts.recorderEpochMs;
              offsetBySession.set(index, offsetMs);
              opts.onStarted(index, offsetMs);
              opts.onStatus('live', { sessionIndex: index });
              clearRollTimer();
              rollTimer = setTimeout(() => {
                rollRequested = true;
                client.stop();
              }, SESSION_ROLL_MS);
            },
            onPartialResult: (result) => handlePartialResult(index, result),
            onError: (status, message) => {
              clearRollTimer();
              resolve({ endedReason: `error:${status}:${message ?? ''}` });
            },
            onFinished: () => {
              clearRollTimer();
              resolve({ endedReason: stopped ? 'app-stop' : rollRequested ? 'roll' : 'error:finished-unexpectedly' });
            },
          });
          currentClient = client;
          client
            .start({
              model: token.model ?? 'stt-rt-v5',
              enableSpeakerDiarization: true,
              stream: opts.stream,
              ...(opts.translate ? { translation: { type: 'two_way' as const, language_a: 'vi', language_b: 'en' } } : {}),
            })
            .catch((error: unknown) => resolve({ endedReason: `start-error:${String(error)}` }));
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
      currentClient?.stop();
      await loopPromise;
    },
  };
}
