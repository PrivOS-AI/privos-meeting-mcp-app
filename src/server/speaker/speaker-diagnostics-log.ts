/**
 * Per-meeting speaker-identification diagnostics — scores and metadata only,
 * NEVER a vector (raw or sealed), transcript text, or audio. Enforced by a
 * per-event-type FIELD ALLOWLIST (`applyAllowlist`), not by array-shape
 * heuristics: embedding dim is model-defined at runtime and score arrays are
 * legitimately numeric, so "looks like a vector" cannot be the guard.
 *
 * Two audiences, two copies:
 *  - NODE copy (`data/diagnostics/<meetingId>.jsonl`, operator-only via SSH —
 *    same trust level as `.env` access): every event, `profile-match` with
 *    real `profileId`s. This is the only copy written continuously (one
 *    `flush()` per chunk from the live path, one `logEvent()` per call from
 *    post-meeting/tool code that has no live registry).
 *  - ROOM copy (uploaded to the meeting's Files folder, readable by room
 *    members): derived from the node copy at UPLOAD time (`uploadRoomCopy`),
 *    never written continuously. `profile-match` is omitted outright — a
 *    per-profile cosine in a room folder would be a cross-room biometric
 *    oracle (`speaker_profiles` is workspace-global). Every `enrol.profile`
 *    is replaced by a per-meeting alias (`p1`, `p2`, …) before the allowlist
 *    filter runs, so a real `profileId` never reaches the room copy.
 *
 * The write buffer itself hangs off `MeetingSessionRegistry` (`pushDiagnosticEvent`/
 * `drainDiagnosticEvents`), never a module-level map — it is flushed once per
 * chunk and is gone the moment its registry is TTL/LRU-evicted. This module
 * never holds meeting-keyed state of its own.
 *
 * Logging failure NEVER fails a chunk or a job: every disk/network operation
 * here is caught internally and only warns.
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises';

import type { RoomBoundHubClient } from '@privos_ai/app-server';

import { uploadBotFile } from '../files/hub-file-upload.js';
import { applyAllowlist, NODE_ALLOWLISTS, ROOM_ALLOWLISTS, SHARED_FIELDS, type DiagnosticEvent } from './speaker-diagnostics-events.js';
import { diagnosticsDir, diagnosticsFilePath, isSafeMeetingId } from './speaker-diagnostics-paths.js';

export type {
  ChunkEvent,
  GapEvent,
  ObserveEvent,
  MergeEvent,
  CentroidsEvent,
  ProfileMatchEvent,
  EnrolEvent,
  PruneEvent,
  DiagnosticEvent,
} from './speaker-diagnostics-events.js';
// Re-exported so callers only need one import path for the whole diagnostics API.
export { sweepLocal, type SweepLocalOptions, type SweepLocalResult } from './speaker-diagnostics-retention.js';

/** Minimal registry surface this module needs — matches `MeetingSessionRegistry`, kept narrow so this module never has to import the whole class. */
export interface DiagnosticsBufferHost {
  readonly meetingId: string;
  pushDiagnosticEvent(event: Record<string, unknown>): void;
  drainDiagnosticEvents(): Record<string, unknown>[];
}

async function writeNodeCopy(meetingId: string, events: readonly Record<string, unknown>[]): Promise<void> {
  if (events.length === 0) return;
  if (!isSafeMeetingId(meetingId)) throw new Error(`speaker-diagnostics-log: unsafe meetingId "${meetingId}"`);
  const filtered = events.map((event) => {
    const type = event.type as DiagnosticEvent['type'] | undefined;
    const allowed = type && type in NODE_ALLOWLISTS ? NODE_ALLOWLISTS[type] : SHARED_FIELDS;
    return applyAllowlist(event, allowed);
  });
  const lines = filtered.map((event) => `${JSON.stringify(event)}\n`).join('');
  await mkdir(diagnosticsDir(), { recursive: true });
  await appendFile(diagnosticsFilePath(meetingId), lines, 'utf8');
}

/**
 * Buffers one event onto `host` (the live meeting's registry) — no I/O here.
 * `t`/`meetingId` are stamped by the caller before this (the registry itself
 * never knows the diagnostics event shape, see `DiagnosticsBufferHost`).
 */
export function append(host: DiagnosticsBufferHost, event: DiagnosticEvent): void {
  // `pushDiagnosticEvent` takes an opaque record (the registry never imports these event types) — a structural cast, not a lossy one.
  host.pushDiagnosticEvent(event as unknown as Record<string, unknown>);
}

/** Drains `host`'s buffer and appends every event to the node-local JSONL file — never throws (logging failure must never fail a chunk or job). */
export async function flush(host: DiagnosticsBufferHost): Promise<void> {
  const events = host.drainDiagnosticEvents();
  if (events.length === 0) return;
  try {
    await writeNodeCopy(host.meetingId, events);
  } catch (error) {
    console.warn('[speaker-diagnostics-log] failed to write node-local diagnostics (non-fatal):', host.meetingId, error instanceof Error ? error.message : error);
  }
}

/** Single-event write for call sites with no live registry (post-meeting embed pass, `speaker_resolve`, `meeting_relabel_speaker`) — never throws. */
export async function logEvent(meetingId: string, event: DiagnosticEvent): Promise<void> {
  try {
    await writeNodeCopy(meetingId, [event as unknown as Record<string, unknown>]);
  } catch (error) {
    console.warn('[speaker-diagnostics-log] failed to write node-local diagnostics (non-fatal):', meetingId, error instanceof Error ? error.message : error);
  }
}

/** Every line of `meetingId`'s node-local file, best-effort parsed — malformed lines are skipped, never thrown on. */
async function readNodeCopyEvents(meetingId: string): Promise<Record<string, unknown>[]> {
  if (!isSafeMeetingId(meetingId)) return [];
  const raw = await readFile(diagnosticsFilePath(meetingId), 'utf8').catch(() => null);
  if (raw === null) return [];
  const events: Record<string, unknown>[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed && typeof parsed === 'object') events.push(parsed as Record<string, unknown>);
    } catch {
      // Skip a corrupt line (e.g. truncated by a crash mid-append) — the rest of the file is still useful.
    }
  }
  return events;
}

/** Builds the room-audience JSONL text from the node copy: drops `profile-match` outright, aliases every `enrol.profile`, then applies the room allowlist. `null` when there is nothing to upload (no local log for this meeting). */
async function buildRoomCopyText(meetingId: string): Promise<string | null> {
  const events = await readNodeCopyEvents(meetingId);
  if (events.length === 0) return null;

  const aliasByProfileId = new Map<string, string>();
  const aliasFor = (profileId: string): string => {
    let alias = aliasByProfileId.get(profileId);
    if (!alias) {
      alias = `p${aliasByProfileId.size + 1}`;
      aliasByProfileId.set(profileId, alias);
    }
    return alias;
  };

  const lines: string[] = [];
  for (const event of events) {
    const type = event.type as DiagnosticEvent['type'] | undefined;
    const allowed = type ? ROOM_ALLOWLISTS[type] : undefined;
    if (!allowed) continue; // 'profile-match' (or an unrecognized type) — omitted outright.

    const withAlias = type === 'enrol' && typeof event.profile === 'string' ? { ...event, profile: aliasFor(event.profile) } : event;
    lines.push(JSON.stringify(applyAllowlist(withAlias, allowed)));
  }
  return lines.length > 0 ? `${lines.join('\n')}\n` : null;
}

/**
 * Uploads the room-audience diagnostics copy to the meeting's Files folder —
 * a no-op (not an error) when the meeting never produced a local log. Called
 * from the meeting job's `finally` (success AND failure) and from the
 * startup sweep for meetings marked `interrupted`. Never throws.
 */
export async function uploadRoomCopy(hub: RoomBoundHubClient, roomId: string, folderId: string, meetingId: string): Promise<void> {
  try {
    const text = await buildRoomCopyText(meetingId);
    if (text === null) return;
    await uploadBotFile({
      hub,
      roomId,
      folderId,
      fileName: 'speaker-diagnostics.jsonl',
      mimeType: 'application/x-ndjson',
      data: Buffer.from(text, 'utf8'),
      duplicateAction: 'replace',
    });
  } catch (error) {
    console.warn('[speaker-diagnostics-log] failed to upload room diagnostics copy (non-fatal):', meetingId, error instanceof Error ? error.message : error);
  }
}

