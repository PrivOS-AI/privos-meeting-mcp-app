/**
 * Shared contract for the realtime caption connection — the app never touches
 * a wire protocol itself (QĐ-01). Each vendor SDK self-captures audio from the
 * `MediaStream` it is given (or, for ElevenLabs, its own internal microphone
 * capture — see `elevenlabs-realtime-client.ts`) and the wrapper only
 * translates its callbacks into these two shapes.
 */
import type { RealtimeCapabilities, RealtimeToken, SttVendor } from './stt-types.js';

/** One caption token/word, already expressed on the MEETING clock (seconds since `recorderEpochMs`). */
export interface CaptionEvent {
  kind: 'draft' | 'final';
  id: string;
  text: string;
  atSec: number;
  endSec: number;
  speakerKey?: string;
  lang?: string;
  /** Set only for a translation token/line; points at the id of the original-language line it translates. */
  translationOf?: string;
}

/** A merged run of consecutive same-speaker tokens — used for `meeting_chunk_ready`, never for on-screen captions. */
export interface LiveTurn {
  id: string;
  speakerKey: string;
  /** Meeting-clock milliseconds (already offset-adjusted). */
  startMs: number;
  endMs: number;
  text: string;
  final: boolean;
}

export type CaptionStatus = 'connecting' | 'live' | 'reconnecting' | 'off';

export interface RealtimeConnectionCallbacks {
  onCaption(event: CaptionEvent): void;
  /** Fires with the FULL current set of live turns whenever it changes (grouping is recomputed, not diffed). */
  onTurns(turns: LiveTurn[]): void;
  onStarted(sessionIndex: number, offsetMs: number): void;
  onStatus(status: CaptionStatus, info?: { sessionIndex: number; error?: string }): void;
}

export interface RealtimeConnectionOptions extends RealtimeConnectionCallbacks {
  /** Mints a fresh token for connect/reconnect/roll-session — never cached across attempts. */
  mintToken: () => Promise<RealtimeToken>;
  stream: MediaStream;
  recorderEpochMs: number;
  translate: boolean;
}

export interface RealtimeConnection {
  stop(): Promise<void>;
}

/** Backoff schedule for reconnects: 1s/2s/4s/8s/16s, capped at 5 attempts (spec). */
export const RECONNECT_BACKOFF_MS = [1000, 2000, 4000, 8000, 16000];
export const MAX_RECONNECT_ATTEMPTS = RECONNECT_BACKOFF_MS.length;
/** Proactive session roll-over well under Soniox's 300 min hard cap. */
export const SESSION_ROLL_MS = 280 * 60 * 1000;

export type RealtimeClientFactory = (opts: RealtimeConnectionOptions) => RealtimeConnection;

const FACTORIES: Record<SttVendor, () => Promise<RealtimeClientFactory>> = {
  soniox: async () => (await import('./soniox-realtime-client.js')).createSonioxConnection,
  elevenlabs: async () => (await import('./elevenlabs-realtime-client.js')).createElevenLabsConnection,
};

/**
 * Factory keyed by the provider the backend minted a token for — the app
 * never branches on vendor logic outside this one seam. Dynamic `import()` so
 * the bundle only loads whichever SDK the active provider actually needs.
 */
export async function createRealtimeClient(vendor: SttVendor, opts: RealtimeConnectionOptions): Promise<RealtimeConnection> {
  const factory = await FACTORIES[vendor]();
  return factory(opts);
}

/** Re-exported so wrapper modules and the store share one type without importing the server-side stt-provider module. */
export type { RealtimeCapabilities, RealtimeToken, SttVendor };
