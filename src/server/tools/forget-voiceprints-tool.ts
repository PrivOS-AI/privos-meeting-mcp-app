/**
 * `meeting_forget_voiceprints {roomId, meetingId}` — removes every voice sample
 * taken from this meeting from the workspace's voiceprint profiles, and its
 * node-local diagnostics. The iframe calls it before deleting a meeting: the
 * meeting row's delete cascades its `meeting_speakers`, after which nothing
 * links the samples back to it. Only the meeting owner — the samples came from
 * their recording, whoever's profile they were added to. Idempotent.
 */
import { rm } from 'node:fs/promises';

import { AppError } from '../../shared/app-error.js';
import { AppDbBotClient } from '../hub/app-db-bot-client.js';
import { forgetMeetingVoiceprints } from '../speaker/profile-store.js';
import { diagnosticsFilePath, isSafeMeetingId } from '../speaker/speaker-diagnostics-paths.js';
import { requireMeetingOwner, requireVerifiedActor } from './authz.js';
import type { AppTool } from './registry.js';
import { ROOM_AND_MEETING } from './schema-parts.js';

export const forgetVoiceprintsTool: AppTool = {
  name: 'meeting_forget_voiceprints',
  title: 'Forget meeting voiceprints',
  description: "Remove every voice sample taken from this meeting from the workspace's voiceprint profiles — run before deleting the meeting; only the meeting owner.",
  inputSchema: { type: 'object', required: ['roomId', 'meetingId'], properties: { ...ROOM_AND_MEETING } },
  async execute(args, context) {
    const actor = requireVerifiedActor(context);
    const roomId = typeof args.roomId === 'string' ? args.roomId.trim() : '';
    const meetingId = typeof args.meetingId === 'string' ? args.meetingId.trim() : '';
    if (!roomId || !meetingId) throw new AppError('roomId and meetingId are required.', 'INVALID_INPUT');

    const db = new AppDbBotClient(roomId);
    await requireMeetingOwner(db, actor, roomId, meetingId);
    const profilesChanged = await forgetMeetingVoiceprints(db, meetingId);
    if (isSafeMeetingId(meetingId)) await rm(diagnosticsFilePath(meetingId), { force: true }).catch(() => undefined);
    return { profilesChanged };
  },
};
