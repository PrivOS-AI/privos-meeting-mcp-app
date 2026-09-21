/**
 * Reads and appends `live-turns.json` in the meeting's Files folder. P5's
 * chunk worker (`live-speakers/chunk-worker.ts`) calls `appendLiveTurns`
 * after every chunk with the turns it just settled — `speakerKey` there
 * carries the LIVE `sessionSpeakerId`, not a Soniox label, so P3/P6's
 * `computeAsyncToLiveMap`/`applyLiveReconciliation` (`jobs/meeting-job.ts`) can
 * align it against the async pass's own spans via `caption-aligner.alignByMaxOverlap`. Reading
 * happens BOTH ways: the reconcile hook reads the finished file, and
 * `appendLiveTurns` itself reads-then-writes since there is no server-side
 * "append to file" primitive on Files — safe here because App DB's
 * `snapshotHash` gate already limits chunk writes to at most once per part,
 * so nothing else is racing this read-modify-write for the same meeting
 * (chunks are processed serially per meeting, `keyed-serial-queue.ts`).
 * Absent until the first chunk ever lands, so a miss is normal, not an error.
 */
import type { RoomBoundHubClient } from '@privos_ai/app-server';

import { uploadBotFile } from '../files/hub-file-upload.js';
import { fetchFileReadable, listRoomFolderFiles } from './hub-file-download.js';

export interface LiveTurnSpan {
  id: string;
  /** The live `sessionSpeakerId` this span belongs to (P5) — NOT a raw Soniox label. */
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

/**
 * Appends `newTurns` to the meeting's `live-turns.json`, creating it on the
 * first call. A no-op when `newTurns` is empty — the chunk worker calls this
 * unconditionally, so an idle/silent chunk must not still trigger a Files
 * write. Failures are the caller's to handle (chunk-worker.ts already treats
 * the whole chunk as best-effort and never lets this throw past its own
 * `catch`).
 */
export async function appendLiveTurns(
  hub: RoomBoundHubClient,
  roomId: string,
  folderId: string,
  newTurns: readonly LiveTurnSpan[],
  signal?: AbortSignal,
): Promise<void> {
  if (newTurns.length === 0) return;
  const existing = await readLiveTurns(hub, roomId, folderId, signal);
  const merged: LiveTurnsFile = { turns: [...(existing?.turns ?? []), ...newTurns] };
  await uploadBotFile({
    hub,
    roomId,
    folderId,
    fileName: LIVE_TURNS_FILE_NAME,
    mimeType: 'application/json',
    data: Buffer.from(JSON.stringify(merged), 'utf8'),
    duplicateAction: 'replace',
    signal,
  });
}
