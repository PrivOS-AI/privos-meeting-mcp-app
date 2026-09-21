/**
 * `speaker_profile_list` / `_update` / `_delete` — the workspace-wide (global,
 * room-less) speaker-identity registry. `_list` returns display data ONLY,
 * never a vector, and is readable by any verified user (plan.md: showing the
 * roster workspace-wide is an accepted, documented trade-off). `_update`/
 * `_delete` require `createdByUserId === actor.userId || isWorkspaceAdmin`.
 *
 * `_update`'s `action:'reenrol'` deliberately does NOT exist yet — it needs
 * `meetings.audioDeletedAt`/re-decode plumbing this tool does not have
 * access to without a `roomId` (this collection is global). It responds with
 * a clear "not yet supported" AppError rather than silently no-op'ing, so a
 * caller cannot mistake acceptance for having actually re-embedded anything.
 */
import { sanitizeDisplayName } from '../../shared/sanitize-display-name.js';
import { AppError } from '../../shared/app-error.js';
import { AppDbBotClient } from '../hub/app-db-bot-client.js';
import { readKnownRooms } from '../jobs/known-rooms-store.js';
import * as profileStore from '../speaker/profile-store.js';
import { readMatchThreshold } from '../speaker/resolve-speakers.js';
import { logEvent } from '../speaker/speaker-diagnostics-log.js';
import { isWorkspaceAdmin, requireVerifiedActor } from './authz.js';
import type { AppTool } from './registry.js';
import type { VerifiedActor } from '@privos_ai/app-server';

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** The exact rule for `_update`/`_delete` AND for whether `_list` includes health — never diverge (a profile you cannot edit must not leak biometric-adjacent health numbers either). */
function canEditProfile(profile: profileStore.SpeakerProfile, actor: VerifiedActor): boolean {
  return profile.createdByUserId === actor.userId || isWorkspaceAdmin(actor);
}

/**
 * Display-only projection of a profile — no `embeddings`/`centroid` ever
 * leave this module. `health` (vector-count/coherence SCALARS only, never a
 * vector) is attached ONLY when the caller may edit this profile — `_list`
 * itself stays readable by any verified user, but per-profile hygiene numbers
 * are biometric-adjacent and gated the same as `_update`/`_delete`.
 */
function toListItem(profile: profileStore.SpeakerProfile, health?: profileStore.ProfileHealth) {
  return {
    id: profile.id,
    displayName: profile.displayName,
    privosUserId: profile.privosUserId,
    privosUsername: profile.privosUsername,
    colorKey: profile.colorKey,
    sampleCount: profile.sampleCount,
    lastSeenAt: profile.lastSeenAt,
    createdByUserId: profile.createdByUserId,
    meetingCount: new Set(profile.embeddings.map((e) => e.meetingId).filter(Boolean)).size,
    ...(health ? { health } : {}),
  };
}

export const speakerProfileListTool: AppTool = {
  name: 'speaker_profile_list',
  title: 'List voiceprint profiles',
  description: 'List every voiceprint profile in the workspace (name, links, sample count) — never returns the vector.',
  inputSchema: { type: 'object', properties: {} },
  async execute(_args, context) {
    const actor = requireVerifiedActor(context);
    const db = new AppDbBotClient(actor.roomId ?? context.roomId);
    const [profiles, threshold] = await Promise.all([profileStore.listProfiles(db), readMatchThreshold(db)]);
    return { profiles: profiles.map((p) => toListItem(p, canEditProfile(p, actor) ? profileStore.profileHealth(p, threshold) : undefined)) };
  },
};

/**
 * Sentinel `meetingId` for diagnostics events that are NOT tied to any one
 * meeting (a workspace-level profile hygiene action) — reuses the existing
 * per-key JSONL diagnostics store as a small operator-only audit log rather
 * than inventing a second logging path. Must pass `isSafeMeetingId`.
 */
const PROFILE_AUDIT_LOG_KEY = 'profile-audit';

export const speakerProfileUpdateTool: AppTool = {
  name: 'speaker_profile_update',
  title: 'Update voiceprint profile',
  description: 'Rename, link a PrivOS user, re-enrol, or prune bad voice samples for a profile — only the profile creator or a workspace admin.',
  inputSchema: {
    type: 'object',
    required: ['profileId'],
    properties: {
      profileId: { type: 'string' },
      displayName: { type: 'string', maxLength: 80 },
      privosUserId: { type: 'string' },
      privosUsername: { type: 'string' },
      action: { type: 'string', enum: ['reenrol', 'pruneOutliers'] },
    },
  },
  async execute(args, context) {
    const actor = requireVerifiedActor(context);
    const profileId = asString(args.profileId);
    if (!profileId) throw new AppError('profileId is required.');

    const db = new AppDbBotClient();
    const profile = await profileStore.getProfile(db, profileId);
    if (!profile) throw new AppError('Voiceprint profile not found.');
    if (!canEditProfile(profile, actor)) {
      throw new AppError('Only the profile creator or a workspace admin can edit this profile.');
    }

    if (args.action === 'reenrol') {
      // Re-embedding from stored audio needs a room-bound Files read this
      // global-scope tool does not have (no `roomId` in its input by design —
      // plan.md keeps `speaker_profile_*` room-less). Surfacing this clearly
      // beats silently accepting a request that does nothing.
      throw new AppError('Re-enrolling voice from stored audio is not supported in this version.');
    }

    let pruned: number | undefined;
    if (args.action === 'pruneOutliers') {
      const threshold = await readMatchThreshold(db);
      const result = await profileStore.pruneOutlierEmbeddings(db, profileId, threshold);
      pruned = result.removed;
      // Counts only — never a vector, never which meeting a pruned sample came from.
      await logEvent(PROFILE_AUDIT_LOG_KEY, {
        t: Date.now(),
        meetingId: PROFILE_AUDIT_LOG_KEY,
        type: 'prune',
        profile: profileId,
        removedCount: result.removed,
        remainingCount: result.remaining,
      });
    }

    if (typeof args.displayName === 'string') {
      const displayName = sanitizeDisplayName(args.displayName);
      if (!displayName) throw new AppError('Invalid display name.');
      await profileStore.renameProfile(db, profileId, displayName);
    }
    if (typeof args.privosUserId === 'string' && args.privosUserId) {
      await profileStore.linkPrivosUser(db, profileId, args.privosUserId, typeof args.privosUsername === 'string' ? args.privosUsername : undefined);
    }

    const updated = await profileStore.getProfile(db, profileId);
    const threshold = await readMatchThreshold(db);
    return {
      profile: updated ? toListItem(updated, profileStore.profileHealth(updated, threshold)) : null,
      ...(pruned !== undefined ? { pruned } : {}),
    };
  },
};

export const speakerProfileDeleteTool: AppTool = {
  name: 'speaker_profile_delete',
  title: 'Delete voiceprint profile',
  description: 'Permanently delete a voiceprint profile and all its links across every room — only the profile creator or a workspace admin.',
  inputSchema: { type: 'object', required: ['profileId'], properties: { profileId: { type: 'string' } } },
  async execute(args, context) {
    const actor = requireVerifiedActor(context);
    const profileId = asString(args.profileId);
    if (!profileId) throw new AppError('profileId is required.');

    const db = new AppDbBotClient(actor.roomId ?? context.roomId);
    const profile = await profileStore.getProfile(db, profileId);
    if (!profile) throw new AppError('Voiceprint profile not found.');
    if (!canEditProfile(profile, actor)) {
      throw new AppError('Only the profile creator or a workspace admin can delete this profile.');
    }

    const knownRooms = await readKnownRooms();
    await profileStore.deleteProfile(db, profileId, knownRooms);
    return { deleted: true };
  },
};
