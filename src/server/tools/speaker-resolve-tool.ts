/**
 * `speaker_resolve {roomId, meetingId, assignments[]}` — owner only. For each
 * still-unresolved `meeting_speakers` row, applies one of 4 modes against its
 * `pendingEmbedding` (sealed by `resolve-speakers.ts`'s embed step):
 *   - `user`   — link a specific PrivOS member (biometric identity claim).
 *   - `name`   — free-text name; creates/reuses a profile by that name.
 *   - `merge`  — enrol into an EXISTING profile the caller picked.
 *   - `skip`   — leave the numbered placeholder as-is.
 *
 * `user`/`merge` REQUIRE a coherent cluster (plan.md's enrolment gate — see
 * `resolve-speakers.ts` header) and are rejected per-assignment when it is
 * not: `{enrolled:false, reason:'cluster_not_coherent'}`. `name` degrades
 * gracefully instead of rejecting — the meeting gets a display name even when
 * the voiceprint itself is not trustworthy enough to enrol.
 *
 * Also the quick-assign code path mid-meeting: when `meetings.status ===
 * 'recording'`, `speakerId` in an assignment is treated as a
 * `sessionSpeakerId` lookup (P5 registry — falls through to "not found" until
 * P5 ships, which is expected and non-fatal for this phase).
 *
 * `pendingEmbedding` is intentionally NEVER cleared here (plan.md: "keep it
 * until the async job finishes... do not clear it at speaker_resolve time")
 * — only `profileId`/`displayName`/`resolved`/`nameSource`/`privosUserId` change.
 */
import { sanitizeDisplayName } from '../../shared/sanitize-display-name.js';
import { AppError } from '../../shared/app-error.js';
import { AppDbBotClient, extractDbRecords, type DbRow } from '../hub/app-db-bot-client.js';
import * as profileStore from '../speaker/profile-store.js';
import { openPendingEmbedding, readMatchThreshold } from '../speaker/resolve-speakers.js';
import { logEvent } from '../speaker/speaker-diagnostics-log.js';
import { requireMeetingOwner, requireVerifiedActor } from './authz.js';
import type { AppTool } from './registry.js';

/**
 * Logs one `enrol` event for a `speaker_resolve` confirmation — every mode
 * here is a human-confirmed identity, so `source` is always `'user'`.
 * Awaited (not fire-and-forget) so the event is durably on disk before this
 * tool call returns; `logEvent` itself never throws (see
 * `speaker-diagnostics-log.ts`), so awaiting it adds no failure mode here.
 */
async function logResolveEnrol(meetingId: string, profileId: string, coherence: number, durationSec: number, vectorCountAfter: number): Promise<void> {
  await logEvent(meetingId, { t: Date.now(), meetingId, type: 'enrol', profile: profileId, source: 'user', coherence, durationSec, vectorCountAfter });
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
  // Quick-assign path (mid-meeting, P5 registry): `speakerId` may be a `sessionSpeakerId`.
  const bySession = await db.query('meeting_speakers', 'room', {
    where: [{ field: 'meeting', op: '==', value: meetingId }, { field: 'sessionSpeakerId', op: '==', value: speakerId }],
    limit: 1,
  });
  return extractDbRecords(bySession)[0] ?? null;
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
    const resolved: AssignmentResult[] = [];

    for (const assignment of assignments) {
      const row = await findSpeakerRow(db, meetingId, assignment.speakerId);
      if (!row) {
        resolved.push({ speakerId: assignment.speakerId, enrolled: false, reason: 'not_found' });
        continue;
      }
      if (row.resolved === true) {
        resolved.push({
          speakerId: assignment.speakerId,
          enrolled: Boolean(row.profileId),
          profileId: typeof row.profileId === 'string' && row.profileId ? row.profileId : undefined,
          reason: 'already_resolved',
        });
        continue;
      }

      if (assignment.mode === 'skip') {
        resolved.push({ speakerId: assignment.speakerId, enrolled: false, reason: 'skipped' });
        continue;
      }

      const pendingJson = typeof row.pendingEmbedding === 'string' && row.pendingEmbedding ? row.pendingEmbedding : null;
      const pending = pendingJson ? openPendingEmbedding(pendingJson) : null;
      const coherent = pending ? pending.rangeCount < 2 || pending.minPairwiseCosine >= threshold : false;

      if (assignment.mode === 'name') {
        const displayName = sanitizeDisplayName(assignment.displayName ?? '');
        if (!displayName) {
          resolved.push({ speakerId: assignment.speakerId, enrolled: false, reason: 'invalid_display_name' });
          continue;
        }
        if (pending && coherent) {
          let profile = await profileStore.findProfileByName(db, displayName);
          if (!profile) profile = await profileStore.createProfile(db, { displayName, createdByUserId: actor.userId, createdInRoomId: roomId });
          const vectorCountAfter = await profileStore.enrolEmbedding(db, profile.id, { vector: pending.vector, meetingId, durationSec: pending.durationSec });
          await logResolveEnrol(meetingId, profile.id, pending.minPairwiseCosine, pending.durationSec, vectorCountAfter);
          await db.update('meeting_speakers', 'room', row._id, { profileId: profile.id, displayName, nameSource: 'user', resolved: true });
          resolved.push({ speakerId: assignment.speakerId, enrolled: true, profileId: profile.id, displayName });
        } else {
          await db.update('meeting_speakers', 'room', row._id, { displayName, nameSource: 'user', resolved: true });
          resolved.push({
            speakerId: assignment.speakerId,
            enrolled: false,
            displayName,
            reason: pending ? 'cluster_not_coherent' : 'no_pending_embedding',
          });
        }
        continue;
      }

      // `user` and `merge` both require a coherent voiceprint cluster — reject per-assignment, not the whole call.
      if (!pending || !coherent) {
        resolved.push({ speakerId: assignment.speakerId, enrolled: false, reason: pending ? 'cluster_not_coherent' : 'no_pending_embedding' });
        continue;
      }

      if (assignment.mode === 'user') {
        if (!assignment.privosUserId) {
          resolved.push({ speakerId: assignment.speakerId, enrolled: false, reason: 'missing_privos_user_id' });
          continue;
        }
        let profile = await profileStore.findProfileByPrivosUserId(db, assignment.privosUserId);
        const displayName = sanitizeDisplayName(assignment.displayName ?? '') || `User ${assignment.privosUserId.slice(0, 6)}`;
        if (!profile) {
          profile = await profileStore.createProfile(db, {
            displayName,
            createdByUserId: actor.userId,
            createdInRoomId: roomId,
            privosUserId: assignment.privosUserId,
          });
        } else {
          await profileStore.linkPrivosUser(db, profile.id, assignment.privosUserId);
        }
        const vectorCountAfter = await profileStore.enrolEmbedding(db, profile.id, { vector: pending.vector, meetingId, durationSec: pending.durationSec });
        await logResolveEnrol(meetingId, profile.id, pending.minPairwiseCosine, pending.durationSec, vectorCountAfter);
        await db.update('meeting_speakers', 'room', row._id, {
          profileId: profile.id,
          displayName: profile.displayName || displayName,
          privosUserId: assignment.privosUserId,
          nameSource: 'user',
          resolved: true,
        });
        resolved.push({ speakerId: assignment.speakerId, enrolled: true, profileId: profile.id });
        continue;
      }

      // mode === 'merge'
      if (!assignment.profileId) {
        resolved.push({ speakerId: assignment.speakerId, enrolled: false, reason: 'missing_profile_id' });
        continue;
      }
      const target = await profileStore.getProfile(db, assignment.profileId);
      if (!target) {
        resolved.push({ speakerId: assignment.speakerId, enrolled: false, reason: 'profile_not_found' });
        continue;
      }
      const vectorCountAfter = await profileStore.enrolEmbedding(db, target.id, { vector: pending.vector, meetingId, durationSec: pending.durationSec });
      await logResolveEnrol(meetingId, target.id, pending.minPairwiseCosine, pending.durationSec, vectorCountAfter);
      await db.update('meeting_speakers', 'room', row._id, { profileId: target.id, displayName: target.displayName, nameSource: 'user', resolved: true });
      resolved.push({ speakerId: assignment.speakerId, enrolled: true, profileId: target.id, displayName: target.displayName });
    }

    return { resolved };
  },
};
