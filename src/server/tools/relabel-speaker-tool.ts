/**
 * `meeting_relabel_speaker {roomId, meetingId, speakerId, profileId|displayName}`
 * — owner only, reused as-is by P7 (meeting detail review). Moves this ONE
 * meeting's voiceprint contribution from whichever profile it is currently
 * enrolled under (if any) to the corrected one:
 *   1. If the row already has a `profileId`, pull that meeting's OWN embedding
 *      back out of the OLD profile (`removeEmbeddingsOfMeeting`) — its vector
 *      is the one that gets re-enrolled, no re-embedding from audio needed.
 *   2. Else fall back to the row's still-parked `pendingEmbedding`, subject to
 *      the SAME cluster-coherence gate `speaker_resolve` uses — an incoherent
 *      cluster still gets the corrected NAME, just not a biometric enrolment.
 *   3. If neither exists, this is a name-only correction.
 *
 * `transcript.md`/`.srt` are never rewritten — display name is resolved from
 * `meeting_speakers` at render time (plan.md).
 */
import { sanitizeDisplayName } from '../../shared/sanitize-display-name.js';
import { AppError } from '../../shared/app-error.js';
import { AppDbBotClient, extractDbRecords } from '../hub/app-db-bot-client.js';
import * as profileStore from '../speaker/profile-store.js';
import { openPendingEmbedding, readMatchThreshold } from '../speaker/resolve-speakers.js';
import { logEvent } from '../speaker/speaker-diagnostics-log.js';
import { requireMeetingOwner, requireVerifiedActor } from './authz.js';
import type { AppTool } from './registry.js';

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export const relabelSpeakerTool: AppTool = {
  name: 'meeting_relabel_speaker',
  title: 'Relabel speaker',
  description: "Change a meeting's speaker to the correct profile or a different name, and update the matching voiceprint profile.",
  inputSchema: {
    type: 'object',
    required: ['roomId', 'meetingId', 'speakerId'],
    properties: {
      roomId: { type: 'string' },
      meetingId: { type: 'string' },
      speakerId: { type: 'string' },
      profileId: { type: 'string' },
      displayName: { type: 'string', maxLength: 80 },
    },
  },
  async execute(args, context) {
    const actor = requireVerifiedActor(context);
    const roomId = asString(args.roomId);
    const meetingId = asString(args.meetingId);
    const speakerId = asString(args.speakerId);
    if (!roomId || !meetingId || !speakerId) throw new AppError('roomId, meetingId, and speakerId are required.');
    const targetProfileId = asString(args.profileId);
    const rawDisplayName = typeof args.displayName === 'string' ? sanitizeDisplayName(args.displayName) : '';
    if (!targetProfileId && !rawDisplayName) throw new AppError('Must provide profileId or displayName.');

    const db = new AppDbBotClient(roomId);
    await requireMeetingOwner(db, actor, roomId, meetingId);

    const existingResult = await db.query('meeting_speakers', 'room', {
      where: [{ field: 'meeting', op: '==', value: meetingId }, { field: 'speakerId', op: '==', value: speakerId }],
      limit: 1,
    });
    const row = extractDbRecords(existingResult)[0];
    if (!row) throw new AppError('This speaker was not found in the meeting.');

    const oldProfileId = typeof row.profileId === 'string' && row.profileId ? row.profileId : undefined;

    // Resolve/create the destination profile.
    let target: profileStore.SpeakerProfile | null = null;
    if (targetProfileId) {
      target = await profileStore.getProfile(db, targetProfileId);
      if (!target) throw new AppError('Target voiceprint profile not found.');
    } else {
      target = await profileStore.findProfileByName(db, rawDisplayName);
      if (!target) target = await profileStore.createProfile(db, { displayName: rawDisplayName, createdByUserId: actor.userId, createdInRoomId: roomId });
    }
    const displayName = rawDisplayName || target.displayName;

    let movedVector: Float32Array | null = null;
    let movedDurationSec = 0;
    // No fresh coherence measurement when re-homing an already-enrolled vector (it was already confirmed once) — logged as 1.
    let movedCoherence = 1;

    if (oldProfileId && oldProfileId !== target.id) {
      const oldProfile = await profileStore.getProfile(db, oldProfileId);
      const own = oldProfile?.embeddings.find((e) => e.meetingId === meetingId);
      if (own) {
        movedVector = own.vector;
        movedDurationSec = own.durationSec;
        await profileStore.removeEmbeddingsOfMeeting(db, oldProfileId, meetingId);
      }
    } else if (!oldProfileId) {
      const pendingJson = typeof row.pendingEmbedding === 'string' && row.pendingEmbedding ? row.pendingEmbedding : null;
      const pending = pendingJson ? openPendingEmbedding(pendingJson) : null;
      if (pending) {
        const threshold = await readMatchThreshold(db);
        const coherent = pending.rangeCount < 2 || pending.minPairwiseCosine >= threshold;
        if (coherent) {
          movedVector = pending.vector;
          movedDurationSec = pending.durationSec;
          movedCoherence = pending.minPairwiseCosine;
        }
      }
    }

    if (movedVector) {
      const vectorCountAfter = await profileStore.enrolEmbedding(db, target.id, { vector: movedVector, meetingId, durationSec: movedDurationSec });
      // A relabel is always a human correction — `source:'user'` regardless of where the vector came from.
      await logEvent(meetingId, {
        t: Date.now(),
        meetingId,
        type: 'enrol',
        profile: target.id,
        source: 'user',
        coherence: movedCoherence,
        durationSec: movedDurationSec,
        vectorCountAfter,
      });
    }

    await db.update('meeting_speakers', 'room', row._id, {
      profileId: target.id,
      displayName,
      nameSource: 'user',
      resolved: true,
    });

    return { updated: true, profileId: target.id, displayName, enrolled: Boolean(movedVector) };
  },
};
