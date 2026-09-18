/**
 * Loads `transcript.json` once per `fileId` and caches it for the tab's
 * lifetime (phase-07 § Architecture / § Non-functional: "chỉ tải 1
 * lần/meeting/phiên") — a 3h meeting's transcript (~2000 segments) must not
 * be re-fetched on every re-render or tab switch.
 */
import type { McpApp } from '@privos_ai/app-react';

import { resolveFileUrl } from './file-download.js';

export interface TranscriptSpeakerDoc {
  speakerId: string;
  totalSpeakSec: number;
  displayName: string | null;
}

export interface TranscriptSegmentDoc {
  id: string;
  speakerId: string;
  startSec: number;
  endSec: number;
  text: string;
  translation?: string;
  lang: string;
}

export interface TranscriptDoc {
  version: number;
  meetingId: string;
  title: string;
  startedAt: string;
  durationSec: number;
  languageCode: string;
  translationLang?: string;
  provider: string;
  speakers: TranscriptSpeakerDoc[];
  segments: TranscriptSegmentDoc[];
}

const cache = new Map<string, Promise<TranscriptDoc>>();

async function fetchTranscript(app: McpApp, fileId: string): Promise<TranscriptDoc> {
  const { url } = await resolveFileUrl(app, fileId, 'application/json');
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Không tải được transcript.json (HTTP ${response.status}).`);
  return (await response.json()) as TranscriptDoc;
}

/** Cached by `fileId` for this tab's session — a second call for the same file returns the same in-flight/settled promise. */
export async function loadTranscript(app: McpApp, fileId: string): Promise<TranscriptDoc> {
  let pending = cache.get(fileId);
  if (!pending) {
    pending = fetchTranscript(app, fileId);
    cache.set(fileId, pending);
    pending.catch(() => cache.delete(fileId)); // a failed load must not poison future attempts
  }
  return pending;
}

/** Presigned (or fallback Blob) URL for the meeting's `audio.webm` — resolved fresh each call so a re-mount or an expired-URL retry always gets a live link. */
export async function resolveAudioUrl(app: McpApp, fileId: string): Promise<string> {
  const { url } = await resolveFileUrl(app, fileId, 'audio/webm');
  return url;
}

/** Test-only reset — the cache is otherwise module-scoped for the tab's lifetime. */
export function resetTranscriptCacheForTests(): void {
  cache.clear();
}
