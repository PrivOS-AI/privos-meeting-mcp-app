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
/** A same-speaker pause longer than this starts a new caption line. */
const LINE_BREAK_PAUSE_MS = 1500;
/**
 * A long monologue is cut by MEANING, not at a fixed size: one ever-growing
 * paragraph is hard to read, makes speaker correction coarse, and feeds the live
 * embedder one long, drift-prone span. Up to SOFT_MAX_WORDS nothing but a long
 * pause breaks a line. Between SOFT and HARD the line ends at the first natural
 * boundary — the end of a sentence, or a short breath pause. HARD_MAX_WORDS is
 * only the safety net for speech with no punctuation and no pauses, and even
 * then the cut waits for a word boundary. Decided on finalized text only, so
 * line ids stay stable across snapshot rebuilds.
 */
const SOFT_MAX_WORDS = 100;
const HARD_MAX_WORDS = 150;
/** A same-speaker pause this long is a natural break once the line is past the soft limit. */
const BREATH_PAUSE_MS = 400;
const SENTENCE_END_RE = /[.!?…。！？]["')\]]*\s*$/;

function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

/** Should the same speaker's next token open a NEW line rather than extend `text`? */
function shouldBreakLine(text: string, nextToken: string, pausedMs: number): boolean {
  if (pausedMs > LINE_BREAK_PAUSE_MS) return true;
  // Cheap guard: 100 words is never under ~200 characters, so skip the count until then.
  if (text.length < 200) return false;
  const words = countWords(text);
  if (words < SOFT_MAX_WORDS) return false;
  if (SENTENCE_END_RE.test(text) || pausedMs >= BREATH_PAUSE_MS) return true;
  // Hard cap — but never split inside a word (tokens can be sub-word pieces).
  return words >= HARD_MAX_WORDS && (/\s$/.test(text) || /^\s/.test(nextToken));
}

function buildFromSnapshot(sessionIndex: number, tokens: Token[], offsetMs: number): BuildResult {
  const captions: CaptionEvent[] = [];
  const turns: LiveTurn[] = [];
  const toMeetingSec = (rawMs: number | undefined) => (offsetMs + (rawMs ?? 0)) / 1000;

  // Current original (non-translation) speaker run.
  let current: { id: string; speakerKey: string; startMsRaw: number; endMsRaw: number; text: string; final: boolean; lang?: string } | null = null;
  let turnIndex = 0;
  // Translation text accumulated PER ORIGINAL TURN, so the whole translation of
  // a segment renders directly under that segment's caption.
  const translations = new Map<string, { text: string; final: boolean; lang?: string }>();
  let lastTurnId: string | undefined;

  const flushTurn = () => {
    if (!current) return;
    turns.push({ id: current.id, speakerKey: current.speakerKey, startMs: offsetMs + current.startMsRaw, endMs: offsetMs + current.endMsRaw, text: current.text, final: current.final });
    captions.push({ kind: current.final ? 'final' : 'draft', id: current.id, text: current.text, atSec: toMeetingSec(current.startMsRaw), endSec: toMeetingSec(current.endMsRaw), speakerKey: current.speakerKey, lang: current.lang });
    lastTurnId = current.id;
    current = null;
  };

  tokens.forEach((token) => {
    if (token.translation_status === 'translation') {
      // Translation tokens carry no timestamp and never join a LiveTurn (QĐ-12);
      // they belong to the original turn that is open (or was just closed).
      const turnId = current?.id ?? lastTurnId;
      if (!turnId) return;
      const entry = translations.get(turnId) ?? { text: '', final: true, lang: token.language };
      entry.text += token.text;
      entry.final = entry.final && token.is_final;
      translations.set(turnId, entry);
      return;
    }

    const speakerKey = token.speaker ? `s${sessionIndex}:${token.speaker}` : `s${sessionIndex}:unknown`;
    // Same speaker continues the line — unless they paused: a long monologue
    // would otherwise be one ever-growing paragraph with no visible history.
    const pausedMs = current ? (token.start_ms ?? current.endMsRaw) - current.endMsRaw : 0;
    if (current && current.speakerKey === speakerKey && !shouldBreakLine(current.text, token.text, pausedMs)) {
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
  // After every turn line exists, so `translationOf` always finds its target.
  for (const [turnId, entry] of translations) {
    captions.push({ kind: entry.final ? 'final' : 'draft', id: `${turnId}:tr`, text: entry.text.trim(), atSec: 0, endSec: 0, translationOf: turnId, lang: entry.lang });
  }

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

  /**
   * Soniox sends each FINAL token once and re-sends only the still-changing
   * non-final tail, so a response is NOT the whole transcript — treating it as
   * one rewrote the same few lines forever and the conversation history never
   * built up. Keep every final token per session and append the current tail.
   * If an SDK build does send cumulative finals (first final identical to ours),
   * adopt its list instead of double-appending.
   */
  const finalTokensBySession = new Map<number, Token[]>();
  function accumulate(index: number, tokens: Token[]): Token[] {
    const kept = finalTokensBySession.get(index) ?? [];
    const incomingFinals = tokens.filter((t) => t.is_final);
    const tail = tokens.filter((t) => !t.is_final);
    const first = incomingFinals[0];
    const cumulative = Boolean(first && kept[0] && kept.length > 0 && first.text === kept[0].text && first.start_ms === kept[0].start_ms && incomingFinals.length >= kept.length);
    const finals = cumulative ? incomingFinals : [...kept, ...incomingFinals];
    finalTokensBySession.set(index, finals);
    return [...finals, ...tail];
  }

  function clearRollTimer(): void {
    if (rollTimer) clearTimeout(rollTimer);
    rollTimer = null;
  }

  function handlePartialResult(index: number, result: SpeechToTextAPIResponse): void {
    const offsetMs = offsetBySession.get(index) ?? 0;
    const { captions, turns } = buildFromSnapshot(index, accumulate(index, result.tokens), offsetMs);
    turnsBySession.set(index, turns);
    for (const caption of captions) opts.onCaption(caption);
    opts.onLinesSnapshot?.(index, turns.map((t) => t.id));
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
              ...(opts.translate ? { translation: { type: 'two_way' as const, language_a: opts.translateFrom ?? 'vi', language_b: opts.translateTo ?? 'en' } } : {}),
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
