/**
 * Shared authorization helpers for every backend tool that touches a meeting
 * or a Files object. A bot credential ignores the Hub's own per-user room
 * membership boundary, so this app's own checks are the only thing standing
 * between "verified user" and "reads/writes any room's data" — every tool in
 * this phase (and the ones before it) must run through here, fail closed.
 */
import type { RoomBoundHubClient, ToolCallContext, VerifiedActor } from '@privos_ai/app-server';

import { AppError } from '../../shared/app-error.js';
import { env, isDevelopmentRuntime } from '../env.js';
import type { AppDbBotClient, DbRow } from '../hub/app-db-bot-client.js';
import { getFileMetadata } from '../media/hub-file-download.js';
import { isWorkspaceAdmin } from './is-workspace-admin.js';

/** Re-exported so every existing `import { isWorkspaceAdmin } from './authz.js'` keeps working — the implementation lives in `is-workspace-admin.ts` (plan.md P8 file ownership). */
export { isWorkspaceAdmin };

/**
 * Fail closed unless the caller is a verified actor. Mirrors the same check
 * `mcp-handler.ts` already runs before ANY tool executes, duplicated here so
 * this module — and every tool that calls it — is independently correct and
 * testable without a live dispatch path. The dev escape hatch is identical to
 * `mcp-handler.ts`'s: `NODE_ENV!=='production' && ALLOW_UNVERIFIED_ACTOR==='1'`,
 * and even then only when an actor claim is actually present.
 */
export function requireVerifiedActor(context: ToolCallContext): VerifiedActor {
  const verified = Boolean(context.actor) && context.identityState === 'verified';
  if (verified) return context.actor as VerifiedActor;
  if (isDevelopmentRuntime() && env.allowUnverifiedActor && context.actor) return context.actor;
  throw new AppError('Request denied: a verified user identity is required.');
}

/**
 * Loads `meetingId` and asserts: it belongs to `roomId`, `roomId` matches the
 * verified actor's own room (confused-deputy guard — a bot credential has no
 * per-user room boundary of its own), and the actor is the meeting's owner.
 * Returns the raw row so callers can read whatever fields they need.
 */
export async function requireMeetingOwner(
  db: AppDbBotClient,
  actor: VerifiedActor,
  roomId: string,
  meetingId: string,
): Promise<DbRow> {
  if (actor.roomId !== roomId) {
    throw new AppError('Invalid request for this room.');
  }
  const meeting = await db.getById('meetings', 'room', meetingId);
  if (!meeting || meeting.roomId !== roomId) {
    throw new AppError('Meeting not found in this room.');
  }
  if (meeting.ownerUserId !== actor.userId) {
    throw new AppError('Only the meeting owner can perform this action.');
  }
  return meeting;
}

/**
 * Loads `meetingId` and asserts it belongs to `roomId`, which must match the
 * verified actor's own room — no ownership check (any room member may read
 * status). Used by tools that only need "am I looking at my own room's data".
 */
export async function requireRoomMeeting(
  db: AppDbBotClient,
  actor: VerifiedActor,
  roomId: string,
  meetingId: string,
): Promise<DbRow> {
  if (actor.roomId !== roomId) {
    throw new AppError('Invalid request for this room.');
  }
  const meeting = await db.getById('meetings', 'room', meetingId);
  if (!meeting || meeting.roomId !== roomId) {
    throw new AppError('Meeting not found in this room.');
  }
  return meeting;
}

/**
 * Re-reads a fileId's OWN metadata from Files and asserts its `channel_id`
 * equals `roomId` — never trusts a list response, a client-supplied id, or a
 * value cached from an earlier call. Throws a clear `AppError` when the file
 * is missing or belongs to a different room.
 */
export async function assertFileInRoom(hub: RoomBoundHubClient, fileId: string, roomId: string, signal?: AbortSignal) {
  const meta = await getFileMetadata(hub, fileId, signal);
  if (!meta || meta.channel_id !== roomId) {
    throw new AppError(`File not found or does not belong to this room (fileId=${fileId}).`);
  }
  return meta;
}
