/**
 * Reads `live-turns.json` from the meeting's Files folder — P5 appends live
 * speaker spans there after every part, P3 only reads it (the reconcile hook
 * this phase leaves in place, see `jobs/meeting-job.ts`). Absent until P5
 * ships, so a miss is normal, not an error.
 */
import type { RoomBoundHubClient } from '@privos_ai/app-server';

import { fetchFileReadable, listRoomFolderFiles } from './hub-file-download.js';

export interface LiveTurnSpan {
  id: string;
  speakerKey: string;
  /** Meeting-clock milliseconds (already offset-adjusted client-side). */
  startMs: number;
  endMs: number;
  text: string;
  sessionIndex: number;
}

export interface LiveTurnsFile {
  turns: LiveTurnSpan[];
}

const LIVE_TURNS_FILE_NAME = 'live-turns.json';

async function readStreamToString(stream: AsyncIterable<Buffer | string>): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function asLiveTurn(value: unknown): LiveTurnSpan | null {
  if (!value || typeof value !== 'object') return null;
  const r = value as Record<string, unknown>;
  if (typeof r.id !== 'string' || typeof r.speakerKey !== 'string') return null;
  if (!Number.isFinite(r.startMs) || !Number.isFinite(r.endMs)) return null;
  return {
    id: r.id,
    speakerKey: r.speakerKey,
    startMs: Number(r.startMs),
    endMs: Number(r.endMs),
    text: typeof r.text === 'string' ? r.text : '',
    sessionIndex: typeof r.sessionIndex === 'number' ? r.sessionIndex : 0,
  };
}

/** `null` when the meeting has no `live-turns.json` yet (normal before P5), or on any parse/network failure. */
export async function readLiveTurns(
  hub: RoomBoundHubClient,
  roomId: string,
  folderId: string,
  signal?: AbortSignal,
): Promise<LiveTurnsFile | null> {
  try {
    const files = await listRoomFolderFiles(hub, roomId, folderId, signal);
    const file = files.find((f) => f.name === LIVE_TURNS_FILE_NAME);
    if (!file) return null;
    const stream = await fetchFileReadable(hub, file._id, signal);
    const text = await readStreamToString(stream);
    const parsed = JSON.parse(text) as { turns?: unknown };
    const turns = Array.isArray(parsed.turns) ? parsed.turns.map(asLiveTurn).filter((t): t is LiveTurnSpan => t !== null) : [];
    return { turns };
  } catch {
    return null;
  }
}
