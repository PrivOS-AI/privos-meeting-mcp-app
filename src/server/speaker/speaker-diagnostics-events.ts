/**
 * Speaker-identification diagnostics event shapes + their per-type FIELD
 * ALLOWLISTS — split out of `speaker-diagnostics-log.ts` (which owns the
 * actual disk/upload I/O) purely to keep each file under a manageable size;
 * see that module's header for the full two-audience design (node vs room
 * copy, why an allowlist and not an array-shape heuristic).
 */

interface EventEnvelope {
  t: number;
  meetingId: string;
}

export interface ChunkEvent extends EventEnvelope {
  type: 'chunk';
  seq: number;
  spans: { label: string; startMs: number; endMs: number; final: boolean }[];
  clientDurationMs: number;
  decodedDurationSec: number;
  uploadLagMs: number;
  captureDriftMs: number;
  overlapSec: number;
  deferredCount: number;
  skipped: { window: number; silence: number; short: number };
  ok: boolean;
}

export interface GapEvent extends EventEnvelope {
  type: 'gap';
  fromSeq: number;
  toSeq: number;
}

export interface ObserveEvent extends EventEnvelope {
  type: 'observe';
  seq: number;
  label: string;
  startMs: number;
  endMs: number;
  durSec: number;
  final: boolean;
  targetId: string;
  decisionScore: number;
  scores: { id: string; cosCentroid: number; cosMaxHeld: number }[];
  sticky: boolean;
  action: 'folded' | 'new' | 'reinstanced';
  /** Whether this embedding touched its target's centroid — `session-speaker-centroid.ts#UpdateAction`. Independent of `action`: a `folded` turn can still be `rejected-short`/`rejected-low-cos` (attributed, never folded into the centroid). */
  updateAction: 'anchor' | 'recent' | 'rejected-low-cos' | 'rejected-short' | 'provisional';
}

export interface MergeEvent extends EventEnvelope {
  type: 'merge';
  winnerId: string;
  loserId: string;
  cos: number;
  winnerSpeechSec: number;
  loserSpeechSec: number;
  winnerNamed: boolean;
  loserNamed: boolean;
  /** The sustained-evidence streak count at the time of this check (0 when blocked by a guard, not by streak). */
  streak: number;
  /** Absent when this pair actually merged; set to why it did NOT when the pair cleared the merge threshold but was blocked. */
  blockedBy?: 'identity' | 'provider-split' | 'min-speech' | 'streak';
}

export interface CentroidsEvent extends EventEnvelope {
  type: 'centroids';
  pairs: { aId: string; bId: string; cos: number }[];
}

export interface ProfileMatchEvent extends EventEnvelope {
  type: 'profile-match';
  sessionSpeakerId: string;
  attempt: number;
  best: { profile: string; cos: number } | null;
  second: { profile: string; cos: number } | null;
  threshold: number;
  accepted: boolean;
}

export interface EnrolEvent extends EventEnvelope {
  type: 'enrol';
  /** Real `profileId` in the node copy; replaced by a per-meeting alias (`p1`, `p2`, …) in the room copy. */
  profile: string;
  /** Canonical enrolment-source taxonomy (`profile-store.ts#EnrolSource`) — the stored vector's OWN source value, never re-derived here. */
  source: 'user-live' | 'user-post' | 'auto-post';
  coherence: number;
  durationSec: number;
  vectorCountAfter: number;
}

/**
 * Voiceprint-hygiene prune (`speaker_profile_update` action `pruneOutliers`)
 * — same enrol-family taxonomy as `EnrolEvent`, counts only. Not tied to any
 * one meeting (a workspace-level profile action), so the caller stamps a
 * sentinel `meetingId` rather than a real one.
 */
export interface PruneEvent extends EventEnvelope {
  type: 'prune';
  /** Real `profileId` — see `NODE_ALLOWLISTS` comment: intentionally NEVER reaches a room copy (same cross-room biometric concern as `profile-match`). */
  profile: string;
  removedCount: number;
  remainingCount: number;
}

export type DiagnosticEvent = ChunkEvent | GapEvent | ObserveEvent | MergeEvent | CentroidsEvent | ProfileMatchEvent | EnrolEvent | PruneEvent;

/** Every event carries at least these — also the fallback allowlist for a malformed/unrecognized `type`. */
export const SHARED_FIELDS = ['t', 'meetingId', 'type'] as const;

/** Every field this event type may EVER carry to the node copy — the write path drops anything else, known or not. */
export const NODE_ALLOWLISTS: Record<DiagnosticEvent['type'], readonly string[]> = {
  chunk: [...SHARED_FIELDS, 'seq', 'spans', 'clientDurationMs', 'decodedDurationSec', 'uploadLagMs', 'captureDriftMs', 'overlapSec', 'deferredCount', 'skipped', 'ok'],
  gap: [...SHARED_FIELDS, 'fromSeq', 'toSeq'],
  observe: [...SHARED_FIELDS, 'seq', 'label', 'startMs', 'endMs', 'durSec', 'final', 'targetId', 'decisionScore', 'scores', 'sticky', 'action', 'updateAction'],
  merge: [...SHARED_FIELDS, 'winnerId', 'loserId', 'cos', 'winnerSpeechSec', 'loserSpeechSec', 'winnerNamed', 'loserNamed', 'streak', 'blockedBy'],
  centroids: [...SHARED_FIELDS, 'pairs'],
  'profile-match': [...SHARED_FIELDS, 'sessionSpeakerId', 'attempt', 'best', 'second', 'threshold', 'accepted'],
  enrol: [...SHARED_FIELDS, 'profile', 'source', 'coherence', 'durationSec', 'vectorCountAfter'],
  prune: [...SHARED_FIELDS, 'profile', 'removedCount', 'remainingCount'],
};

/** Room-audience allowlist — `profile-match` and `prune` are intentionally ABSENT (omitted outright, see `speaker-diagnostics-log.ts`): both carry a real, workspace-global `profileId` with no per-meeting alias, which would be a cross-room biometric oracle in a room folder. Every other type reuses the node list verbatim (no field in those carries a vector, text, or a workspace-global id). */
export const ROOM_ALLOWLISTS: Partial<Record<DiagnosticEvent['type'], readonly string[]>> = {
  chunk: NODE_ALLOWLISTS.chunk,
  gap: NODE_ALLOWLISTS.gap,
  observe: NODE_ALLOWLISTS.observe,
  merge: NODE_ALLOWLISTS.merge,
  centroids: NODE_ALLOWLISTS.centroids,
  enrol: NODE_ALLOWLISTS.enrol,
};

/** Keeps only the keys in `allowed` that are present on `event` — drops anything else, known or not (the enforcement point, not the event-shape types above which are just authoring convenience). */
export function applyAllowlist(event: Record<string, unknown>, allowed: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of allowed) {
    if (key in event) out[key] = event[key];
  }
  return out;
}
