/**
 * UI-side mirror of the server's `src/server/stt/stt-provider.ts` wire shapes.
 * Kept as a separate small module (not imported from `src/server`) because the
 * iframe bundle must never pull in server-only code.
 */
export type SttVendor = 'soniox' | 'elevenlabs';

export interface RealtimeCapabilities {
  speakerLabels: boolean;
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
