/**
 * `transcript.json` — the stored transcript's source of truth (D-04). Shape
 * is provider-agnostic: both async providers already normalize into the same
 * `SttToken[]`/`Segment[]`. `displayName` is filled in by P4; `translation` by
 * P6 — both left `null`/absent here.
 */
import type { Segment } from './segment-builder.js';
import type { SttToken } from '../stt/stt-provider.js';

export type SttAsyncProviderName = 'soniox-async' | 'elevenlabs-batch';

export interface TranscriptSpeaker {
  speakerId: string;
  totalSpeakSec: number;
  displayName: string | null;
}

export interface TranscriptJson {
  version: 2;
  meetingId: string;
  title: string;
  startedAt: string;
  durationSec: number;
  languageCode: string;
  translationLang?: string;
  provider: SttAsyncProviderName;
  speakers: TranscriptSpeaker[];
  segments: Segment[];
  tokens: SttToken[];
}

export interface BuildTranscriptJsonInput {
  meetingId: string;
  title: string;
  startedAt: string;
  durationSec: number;
  languageCode: string;
  translationLang?: string;
  provider: SttAsyncProviderName;
  speakers: TranscriptSpeaker[];
  segments: Segment[];
  tokens: SttToken[];
}

export function buildTranscriptJson(input: BuildTranscriptJsonInput): TranscriptJson {
  return { version: 2, ...input };
}

export function serializeTranscriptJson(doc: TranscriptJson): Buffer {
  return Buffer.from(JSON.stringify(doc, null, 2), 'utf8');
}
