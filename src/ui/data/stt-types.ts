/**
 * UI-side mirror of the server's `src/server/stt/stt-provider.ts` wire shapes.
 * Kept as a separate small module (not imported from `src/server`) because the
 * iframe bundle must never pull in server-only code.
 */
/** `local` = the app's own recognizer (no vendor); `soniox` / `elevenlabs` = optional vendors. */
export type SttVendor = 'local' | 'soniox' | 'elevenlabs';

export interface RealtimeCapabilities {
  speakerLabels: boolean;
  /** Speakers are identified live on the server — poll `meeting_live_speakers`. Absent from an older server: fall back to `speakerLabels`. */
  liveSpeakers?: boolean;
  translation: boolean;
}

export interface RealtimeToken {
  provider: SttVendor;
  token: string;
  wsUrl?: string;
  expiresAt: string;
  model?: string;
  capabilities: RealtimeCapabilities;
}
