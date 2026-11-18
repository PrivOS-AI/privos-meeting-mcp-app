/**
 * What a meeting is likely to say that a general model gets wrong: the Room's
 * own terms (Settings › Speech recognition, `vocabulary`) and the names of the
 * people the app knows by voice. Handed to the local recogniser as hotwords
 * (`hotwords.ts`); the Room's terms come first, so they survive the cap.
 * Profile names from this Room come before the rest of the workspace's.
 *
 * Best effort: a failed read means decoding without a vocabulary, never a
 * failed caption or transcript.
 */
import { parseVocabulary } from '../../shared/app-settings.js';
import type { AppDbBotClient } from '../hub/app-db-bot-client.js';
import { getSetting } from '../hub/app-settings.js';
import { cachedProfiles } from '../speaker/profile-store.js';
import { MAX_HOTWORDS } from './hotwords.js';
import type { LiveAsrSession } from './live-asr-session.js';

export async function meetingVocabulary(db: AppDbBotClient, roomId: string): Promise<string[]> {
  const [glossary, profiles] = await Promise.all([
    getSetting<string>(db, 'vocabulary').catch(() => undefined),
    cachedProfiles(db).catch(() => []),
  ]);
  const names = [...profiles]
    .sort((a, b) => Number(b.createdInRoomId === roomId) - Number(a.createdInRoomId === roomId) || (b.lastSeenAt ?? '').localeCompare(a.lastSeenAt ?? ''))
    .map((profile) => profile.displayName.trim())
    .filter(Boolean);
  return [...new Set([...parseVocabulary(glossary ?? ''), ...names])].slice(0, MAX_HOTWORDS * 2);
}

/** Loads the vocabulary into a live session once; its utterances use it from then on. */
export function loadSessionVocabulary(session: LiveAsrSession, db: AppDbBotClient, roomId: string): void {
  if (session.vocabularyRequested) return;
  session.vocabularyRequested = true;
  meetingVocabulary(db, roomId).then(
    (vocabulary) => {
      session.vocabulary = vocabulary;
    },
    (error: unknown) => console.warn('[asr] vocabulary not loaded:', session.meetingId, error instanceof Error ? error.message : error),
  );
}
