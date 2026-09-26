/**
 * `speaker_resolve {roomId, meetingId, assignments[]}` — owner only. For each
 * still-unresolved `meeting_speakers` row, applies one of 4 modes against its
 * `pendingEmbedding` (sealed by `resolve-speakers.ts`/`live-speaker-repository.ts`):
 *   - `user`   — link a specific PrivOS member (biometric identity claim).
 *   - `name`   — free-text name; creates/reuses a profile by that name.
 *   - `merge`  — enrol into an EXISTING profile the caller picked.
 *   - `skip`   — leave the numbered placeholder as-is.
 *
 * The IDENTITY (`displayName`/`privosUserId`/`nameSource:'user'`/`resolved:true`)
 * is persisted for EVERY mode as soon as the human confirms it, even when
 * enrolment itself is deferred — a person named live must never be forgotten
 * within a part just because their voiceprint cluster is not enrol-worthy yet
 * (plan.md root cause 2). `already_resolved` only short-circuits once the row
 * ALSO has a `profileId` — a named-but-not-yet-enrolled row stays open to a
 * later resolve attempt.
 *
 * A row found via `sessionSpeakerId` (no `speakerId` — a still-live, not yet
 * async-reconciled row) reads a LIVE-sourced envelope and is held to the
 * stricter one-shot live enrolment bar (`resolve-speakers.ts#isLiveEnrolBarMet`)
 * instead of the post-meeting coherence rule; when this process holds the
 * meeting's registry, the identity mutation + row write both run on the SAME
 * keyed queue the chunk worker uses (`chunk-worker.ts#runOnMeetingQueue`) so
 * they can never interleave with a chunk's own `upsertAll`.
 *
 * `pendingEmbedding` is intentionally NEVER cleared here (plan.md: "keep it
 * until the async job finishes... do not clear it at speaker_resolve time")
 * — only identity/enrolment fields change.
 */
import { sanitizeDisplayName } from '../../shared/sanitize-display-name.js';
import { AppError } from '../../shared/app-error.js';
import { AppDbBotClient, extractDbRecords, type DbRow } from '../hub/app-db-bot-client.js';
import * as profileStore from '../speaker/profile-store.js';
import type { EnrolIdentity, EnrolSource } from '../speaker/profile-store.js';
import { isLiveEnrolBarMet, isPostMeetingCoherent, openPendingEmbedding, readMatchThreshold } from '../speaker/resolve-speakers.js';
import { sessionRegistries } from '../speaker/session-speaker-registry.js';
import { logEvent } from '../speaker/speaker-diagnostics-log.js';
import { invalidateProfileCache, runOnMeetingQueue } from '../live-speakers/chunk-worker.js';
import { requireMeetingOwner, requireVerifiedActor } from './authz.js';
import type { AppTool } from './registry.js';

/**
 * Logs one `enrol` event for a `speaker_resolve` confirmation — every mode
 * here is a human-confirmed identity, so `source` is always one of the
 * `user-*` values. Awaited (not fire-and-forget) so the event is durably on
 * disk before this tool call returns; `logEvent` itself never throws (see
 * `speaker-diagnostics-log.ts`), so awaiting it adds no failure mode here.
 */
async function logResolveEnrol(meetingId: string, profileId: string, source: EnrolSource, coherence: number, durationSec: number, vectorCountAfter: number): Promise<void> {
  await logEvent(meetingId, { t: Date.now(), meetingId, type: 'enrol', profile: profileId, source, coherence, durationSec, vectorCountAfter });
}

type Mode = 'user' | 'name' | 'merge' | 'skip';

interface Assignment {
  speakerId: string;
  mode: Mode;
  privosUserId?: string;
  displayName?: string;
  profileId?: string;
}

interface AssignmentResult {
  speakerId: string;
  enrolled: boolean;
  profileId?: string;
  displayName?: string;
  reason?: string;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asAssignment(value: unknown): Assignment | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const speakerId = asString(raw.speakerId);
  const mode = raw.mode;
  if (!speakerId || (mode !== 'user' && mode !== 'name' && mode !== 'merge' && mode !== 'skip')) return null;
  return {
    speakerId,
    mode,
    privosUserId: typeof raw.privosUserId === 'string' ? raw.privosUserId : undefined,
    displayName: typeof raw.displayName === 'string' ? raw.displayName : undefined,
    profileId: typeof raw.profileId === 'string' ? raw.profileId : undefined,
  };
}

async function findSpeakerRow(db: AppDbBotClient, meetingId: string, speakerId: string): Promise<DbRow | null> {
  const bySpeakerId = await db.query('meeting_speakers', 'room', {
    where: [{ field: 'meeting', op: '==', value: meetingId }, { field: 'speakerId', op: '==', value: speakerId }],
    limit: 1,
  });
  const direct = extractDbRecords(bySpeakerId)[0];
  if (direct) return direct;
  // Quick-assign path (mid-meeting, or a user-named live row the post-meeting job kept because it never mapped to an async speaker): `speakerId` may be a `sessionSpeakerId`.
  const bySession = await db.query('meeting_speakers', 'room', {
    where: [{ field: 'meeting', op: '==', value: meetingId }, { field: 'sessionSpeakerId', op: '==', value: speakerId }],
    limit: 1,
  });
  return extractDbRecords(bySession)[0] ?? null;
}

/** Applies the identity to this process's in-memory registry (if it holds one for this meeting) — a no-op when this process is not running that meeting's live worker. Call only from inside the meeting's queued task (see `execute` below) so it never races the chunk worker's own registry reads/writes. */
function applyRegistryIdentity(meetingId: string, sessionSpeakerId: string, identity: { displayName: string; privosUserId?: string; profileId?: string }): void {
  if (!sessionRegistries.has(meetingId)) return;
  sessionRegistries.get(meetingId).applyUserIdentity(sessionSpeakerId, identity);
}

export const speakerResolveTool: AppTool = {
  name: 'speaker_resolve',
  title: 'Resolve speakers',
  description: "Confirm, name, or merge a meeting's unidentified speakers into voiceprint profiles.",
  inputSchema: {
    type: 'object',
    required: ['roomId', 'meetingId', 'assignments'],
    properties: {
      roomId: { type: 'string' },
      meetingId: { type: 'string' },
      assignments: {
        type: 'array',
        items: {
          type: 'object',
          required: ['speakerId', 'mode'],
          properties: {
            speakerId: { type: 'string' },
            mode: { type: 'string', enum: ['user', 'name', 'merge', 'skip'] },
            privosUserId: { type: 'string' },
            displayName: { type: 'string', maxLength: 80 },
            profileId: { type: 'string' },
          },
        },
      },
    },
  },
  async execute(args, context) {
    const actor = requireVerifiedActor(context);
    const roomId = asString(args.roomId);
    const meetingId = asString(args.meetingId);
    if (!roomId || !meetingId) throw new AppError('roomId and meetingId are required.');

    const assignmentsRaw = Array.isArray(args.assignments) ? args.assignments : [];
    const assignments = assignmentsRaw.map(asAssignment).filter((a): a is Assignment => a !== null);
    if (assignments.length === 0) throw new AppError('assignments is invalid or empty.');

    const db = new AppDbBotClient(roomId);
    await requireMeetingOwner(db, actor, roomId, meetingId);

    const threshold = await readMatchThreshold(db);
    // Whether THIS process is running the meeting's live chunk worker — decided
    // once, before the loop: it cannot change mid-call, and it is what gates
    // whether an assignment's row-write + registry-mutation must be
    // queue-serialized against that worker's own `upsertAll` (plan.md § "no
    // interleaving"). A meeting no longer live (registry evicted — recording
    // ended, or the post-meeting job already took over) has no such worker to
    // race, so a plain `await` is correct and cheaper.
    const holdsRegistry = sessionRegistries.has(meetingId);

    async function resolveOneAssignment(assignment: Assignment): Promise<AssignmentResult> {
      const row = await findSpeakerRow(db, meetingId, assignment.speakerId);
      if (!row) {
        return { speakerId: assignment.speakerId, enrolled: false, reason: 'not_found' };
      }
      // Only a row the USER already confirmed as this same identity (and enrolled) short-circuits. A profile
      // the system GUESSED (live/async match) must never swallow the user's correction — it used to return
      // `already_resolved` untouched, so the UI showed the new name for one poll and then snapped back.
      const existingProfileId = typeof row.profileId === 'string' ? row.profileId : '';
      const sameIdentity =
        assignment.mode === 'merge' ? assignment.profileId === existingProfileId : sanitizeDisplayName(assignment.displayName ?? '') === row.displayName;
      if (row.resolved === true && existingProfileId && row.nameSource === 'user' && sameIdentity) {
        return { speakerId: assignment.speakerId, enrolled: true, profileId: existingProfileId, reason: 'already_resolved' };
      }

      if (assignment.mode === 'skip') {
        return { speakerId: assignment.speakerId, enrolled: false, reason: 'skipped' };
      }

      // A row found via `sessionSpeakerId` with no `speakerId` is still LIVE (never async-reconciled) — its
      // envelope was sealed under a `live:` id and is held to the stricter one-shot live enrolment bar.
      const isLive = Boolean(row.sessionSpeakerId) && !(typeof row.speakerId === 'string' && row.speakerId);
      const rowKey = isLive ? (row.sessionSpeakerId as string) : (typeof row.speakerId === 'string' ? row.speakerId : assignment.speakerId);
      const expectedProfileId = isLive ? `live:${meetingId}:${rowKey}` : `pending:${meetingId}:${rowKey}`;
      const pendingJson = typeof row.pendingEmbedding === 'string' && row.pendingEmbedding ? row.pendingEmbedding : null;
      const pending = pendingJson ? openPendingEmbedding(pendingJson, expectedProfileId) : null;
      const coherent = pending ? (isLive ? isLiveEnrolBarMet(pending) : isPostMeetingCoherent(pending, threshold)) : false;

      let displayName: string | undefined;
      let privosUserId: string | undefined;
      let identity: EnrolIdentity | null = null;

      if (assignment.mode === 'name') {
        displayName = sanitizeDisplayName(assignment.displayName ?? '');
        if (!displayName) {
          return { speakerId: assignment.speakerId, enrolled: false, reason: 'invalid_display_name' };
        }
        identity = { displayName, createdByUserId: actor.userId, createdInRoomId: roomId };
      } else if (assignment.mode === 'user') {
        if (!assignment.privosUserId) {
          return { speakerId: assignment.speakerId, enrolled: false, reason: 'missing_privos_user_id' };
        }
        privosUserId = assignment.privosUserId;
        displayName = sanitizeDisplayName(assignment.displayName ?? '') || `User ${privosUserId.slice(0, 6)}`;
        identity = { displayName, privosUserId, createdByUserId: actor.userId, createdInRoomId: roomId };
      } else {
        // mode === 'merge'
        if (!assignment.profileId) {
          return { speakerId: assignment.speakerId, enrolled: false, reason: 'missing_profile_id' };
        }
        const target = await profileStore.getProfile(db, assignment.profileId);
        if (!target) {
          return { speakerId: assignment.speakerId, enrolled: false, reason: 'profile_not_found' };
        }
        displayName = target.displayName;
        identity = { displayName, profileId: target.id, createdByUserId: actor.userId, createdInRoomId: roomId };
      }

      // Replaces any guessed profile: the profile the user picked (merge), else none until an enrol below sets one.
      const confirmedProfileId = identity.profileId ?? '';
      const identityPatch: Record<string, unknown> = { displayName, nameSource: 'user', resolved: true, profileId: confirmedProfileId };
      if (privosUserId) identityPatch.privosUserId = privosUserId;

      if (pending && coherent) {
        const source: EnrolSource = isLive ? 'user-live' : 'user-post';
        const enrolResult = await profileStore.findOrCreateProfileAndEnrol(db, identity, pending.vector, {
          meetingId,
          durationSec: pending.durationSec,
          source,
          speakerKey: rowKey,
        });
        if (!enrolResult) {
          // mode 'merge' pointed at a profile that vanished between the read above and here — extremely rare, never silently drop the identity.
          await db.update('meeting_speakers', 'room', row._id, identityPatch);
          applyRegistryIdentity(meetingId, rowKey, { displayName: displayName!, privosUserId, profileId: confirmedProfileId || undefined });
          return { speakerId: assignment.speakerId, enrolled: false, displayName, reason: 'profile_not_found' };
        }
        identityPatch.profileId = enrolResult.profile.id;
        identityPatch.displayName = enrolResult.profile.displayName || displayName;
        await db.update('meeting_speakers', 'room', row._id, identityPatch);
        await logResolveEnrol(meetingId, enrolResult.profile.id, source, pending.minPairwiseCosine, pending.durationSec, enrolResult.vectorCountAfter);
        if (isLive) invalidateProfileCache();
        applyRegistryIdentity(meetingId, rowKey, { displayName: identityPatch.displayName as string, privosUserId, profileId: enrolResult.profile.id });
        return { speakerId: assignment.speakerId, enrolled: true, profileId: enrolResult.profile.id, displayName: identityPatch.displayName as string };
      }

      await db.update('meeting_speakers', 'room', row._id, identityPatch);
      applyRegistryIdentity(meetingId, rowKey, { displayName: displayName!, privosUserId, profileId: confirmedProfileId || undefined });
      const reason = isLive ? 'enrol_deferred' : pending ? 'cluster_not_coherent' : 'no_pending_embedding';
      return { speakerId: assignment.speakerId, enrolled: false, displayName, reason };
    }

    const resolved: AssignmentResult[] = [];
    for (const assignment of assignments) {
      // While this process holds the meeting's live registry, the ENTIRE
      // per-assignment read-decide-write (including the registry mutation)
      // runs as ONE task on the SAME keyed queue the chunk worker uses — the
      // whole point is that nothing else touching this meetingId's registry
      // or `meeting_speakers` rows can run in between (plan.md § "no
      // interleaving"); splitting the DB write and the registry mutation into
      // two separate queued calls would reopen exactly that window.
      resolved.push(holdsRegistry ? await runOnMeetingQueue(meetingId, () => resolveOneAssignment(assignment)) : await resolveOneAssignment(assignment));
    }

    return { resolved };
  },
};
