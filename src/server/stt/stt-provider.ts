/**
 * Provider-agnostic STT contract. Two first-class vendors (Soniox, ElevenLabs)
 * sit behind these interfaces and are selected per workspace (QĐ-15). Realtime
 * providers mint a short-lived token the iframe SDK uses; async providers
 * transcribe a finished audio file server-side and are the authoritative source
 * for the stored transcript (QĐ-03).
 *
 * Phase 1 ships the interfaces + four shells; the real vendor logic lands in
 * P2 (realtime) and P3 (async).
 */

export type SttVendor = 'soniox' | 'elevenlabs';

/** One recognized token, normalized across vendors. Timestamps are ms from the recorder epoch. */
export interface SttToken {
  text: string;
  startMs: number;
  endMs: number;
  speaker?: string;
  language?: string;
  confidence?: number;
  isFinal?: boolean;
  /** Translation status/target when bilingual output is on. */
  translation?: { text: string; lang: string };
}

/** A speaker turn as diarized by the async pass. */
export interface SttSegment {
  speaker: string;
  startMs: number;
  endMs: number;
  text: string;
  language?: string;
}

/** Normalized async transcription result — the same shape for every vendor. */
export interface SttResult {
  tokens: SttToken[];
  segments: SttSegment[];
  language?: string;
}

export interface TranscribeInput {
  /** Local path to the concatenated meeting audio (webm/opus or decoded wav). */
  audioPath: string;
  languageHints?: string[];
  enableSpeakerDiarization?: boolean;
  /** Cooperative cancellation for the job timeout / an aborted retry (P3). Optional so pre-P3 callers still compile. */
  signal?: AbortSignal;
  /**
   * Soniox-only: persist provider-side ids the MOMENT they exist (before the
   * first poll), so a job that dies mid-flight can be cleaned up or resumed
   * without a second upload/charge (plan.md S2-12).
   */
  onProviderIds?: (ids: { providerFileId?: string; providerTranscriptionId?: string }) => Promise<void> | void;
  /** Soniox-only: correlates this attempt with the vendor's own dashboard/logs. Not used for server-side lookup — no documented list-by-reference API. */
  clientReferenceId?: string;
  /** Soniox-only: resume a previous attempt instead of re-uploading — set from `processing_jobs.providerFileId`/`providerTranscriptionId` on retry. */
  resumeProviderFileId?: string;
  resumeProviderTranscriptionId?: string;
}

/** Capabilities a realtime provider advertises to the UI. */
export interface RealtimeCapabilities {
  speakerLabels: boolean;
  translation: boolean;
}

/** Short-lived credential the iframe SDK connects with. */
export interface RealtimeToken {
  provider: SttVendor;
  token: string;
  wsUrl?: string;
  expiresAt: string;
  model?: string;
  capabilities: RealtimeCapabilities;
}

/** Cheap vendor-account probe outcome — never a key, never derived from a full transcription. */
export type ProviderStatusReason = 'not_configured' | 'invalid_key' | 'network_error' | 'http_error';

/** Vendor usage snapshot for the admin status table — whatever fields that vendor's cheap probe exposes. */
export interface ProviderUsage {
  tier?: string;
  characterCount?: number;
  characterLimit?: number;
}

/** Live status for the settings/status tool (never includes any key). */
export interface ProviderStatus {
  provider: SttVendor;
  kind: 'realtime' | 'async';
  configured: boolean;
  ok: boolean;
  models: string[];
  detail?: string;
  /** Set only when `ok` is false and the cause is one of these known cheap-probe outcomes. */
  reason?: ProviderStatusReason;
  /** Vendor account usage from the cheap probe, when the vendor exposes one (ElevenLabs). */
  usage?: ProviderUsage;
  /** Realtime only: sessions this workspace currently has open with the ACTIVE realtime provider (shared cap, QĐ-19). */
  activeSessions?: number;
}

/** Async (post-meeting) transcription provider. */
export interface AsyncSttProvider {
  readonly vendor: SttVendor;
  transcribeFile(input: TranscribeInput): Promise<SttResult>;
  status(): Promise<ProviderStatus>;
}

/** Realtime token minter for the live caption SDK. */
export interface RealtimeTokenProvider {
  readonly vendor: SttVendor;
  readonly capabilities: RealtimeCapabilities;
  mint(meetingId: string): Promise<RealtimeToken>;
  status(): Promise<ProviderStatus>;
}
