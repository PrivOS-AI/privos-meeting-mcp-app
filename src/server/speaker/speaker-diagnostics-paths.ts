/**
 * `data/diagnostics/<meetingId>.jsonl` path resolution + the meetingId safety
 * check every caller must pass before this id ever reaches `path.join` —
 * shared by `speaker-diagnostics-log.ts` (write/read/upload) and
 * `speaker-diagnostics-retention.ts` (the local sweep).
 */
import path from 'node:path';

import { dataDir } from '../paths.js';

const SAFE_MEETING_ID_RE = /^[a-zA-Z0-9_-]{1,200}$/;

/** No path separators, no `.`/`..`, bounded length. */
export function isSafeMeetingId(meetingId: string): boolean {
  return SAFE_MEETING_ID_RE.test(meetingId);
}

export function diagnosticsDir(): string {
  return path.join(dataDir, 'diagnostics');
}

export function diagnosticsFilePath(meetingId: string): string {
  return path.join(diagnosticsDir(), `${meetingId}.jsonl`);
}
