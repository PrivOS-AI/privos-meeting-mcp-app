/**
 * Local retention sweep over `data/diagnostics` — age (90d default) AND a
 * total byte cap (oldest first), independent of any room/App DB (this is
 * node-local operator diagnostics, not room content). Called once per cycle
 * from `audio-retention-job.ts`'s `sweepAllKnownRooms` (boot + every 6h).
 */
import { readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';

import { diagnosticsDir, isSafeMeetingId } from './speaker-diagnostics-paths.js';

const DEFAULT_MAX_AGE_DAYS = 90;
/** Generous node-local cap — this is raw operator diagnostics, not a user-facing quota. */
const DEFAULT_MAX_TOTAL_BYTES = 500 * 1024 * 1024;

export interface SweepLocalOptions {
  now?: number;
  maxAgeDays?: number;
  maxTotalBytes?: number;
  /**
   * When given, any `<meetingId>.jsonl` whose id is not in this set is
   * deleted regardless of age/cap (the meeting row is gone). Left unwired for
   * now — no code path in this app deletes a `meetings` row today, and a
   * cross-room existence check would risk deleting another room's still-valid
   * log if called incorrectly; age + the byte cap already reclaim orphans.
   */
  existingMeetingIds?: ReadonlySet<string>;
}

export interface SweepLocalResult {
  deletedByAge: number;
  deletedByCap: number;
  deletedOrphaned: number;
}

interface FileInfo {
  filePath: string;
  meetingId: string;
  mtimeMs: number;
  size: number;
}

/** Age (90d) + total byte cap (oldest first) sweep over `data/diagnostics` — never throws (a missing/unreadable directory is treated as "nothing to sweep"). */
export async function sweepLocal(options: SweepLocalOptions = {}): Promise<SweepLocalResult> {
  const result: SweepLocalResult = { deletedByAge: 0, deletedByCap: 0, deletedOrphaned: 0 };
  const dir = diagnosticsDir();
  const maxAgeDays = options.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS;
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  const now = options.now ?? Date.now();

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return result; // no diagnostics directory yet — nothing to sweep.
  }

  const files: FileInfo[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
    const meetingId = entry.name.slice(0, -'.jsonl'.length);
    if (!isSafeMeetingId(meetingId)) continue;
    const filePath = path.join(dir, entry.name);
    const info = await stat(filePath).catch(() => null);
    if (!info) continue;
    files.push({ filePath, meetingId, mtimeMs: info.mtimeMs, size: info.size });
  }

  const ageCutoffMs = now - maxAgeDays * 24 * 60 * 60 * 1000;
  const remaining: FileInfo[] = [];
  for (const file of files) {
    if (options.existingMeetingIds && !options.existingMeetingIds.has(file.meetingId)) {
      await rm(file.filePath, { force: true }).catch(() => undefined);
      result.deletedOrphaned++;
      continue;
    }
    if (file.mtimeMs < ageCutoffMs) {
      await rm(file.filePath, { force: true }).catch(() => undefined);
      result.deletedByAge++;
      continue;
    }
    remaining.push(file);
  }

  remaining.sort((a, b) => a.mtimeMs - b.mtimeMs); // oldest first
  let totalBytes = remaining.reduce((sum, f) => sum + f.size, 0);
  for (const file of remaining) {
    if (totalBytes <= maxTotalBytes) break;
    await rm(file.filePath, { force: true }).catch(() => undefined);
    totalBytes -= file.size;
    result.deletedByCap++;
  }

  return result;
}
