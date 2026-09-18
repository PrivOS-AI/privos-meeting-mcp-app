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
  throw new AppError('Yêu cầu bị từ chối: cần một người dùng đã xác minh danh tính.');
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
    throw new AppError('Yêu cầu không hợp lệ cho phòng này.');
  }
  const meeting = await db.getById('meetings', 'room', meetingId);
  if (!meeting || meeting.roomId !== roomId) {
    throw new AppError('Không tìm thấy cuộc họp trong phòng này.');
  }
  if (meeting.ownerUserId !== actor.userId) {
    throw new AppError('Chỉ chủ cuộc họp mới thực hiện được thao tác này.');
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
    throw new AppError('Yêu cầu không hợp lệ cho phòng này.');
  }
  const meeting = await db.getById('meetings', 'room', meetingId);
  if (!meeting || meeting.roomId !== roomId) {
    throw new AppError('Không tìm thấy cuộc họp trong phòng này.');
  }
  return meeting;
}

/**
 * Best-effort workspace-admin check for `speaker_profile_update`/`_delete`
 * (plan.md: "`createdByUserId` hoặc workspace admin"). The SDK's
 * `VerifiedActor.claims` is an untyped `Record<string, unknown>` — there is
 * no dedicated "is this user a workspace admin" claim documented anywhere in
 * this app's PrivOS dev-docs references, so this reads the conventional
 * flags a Hub-issued JWT is most likely to carry (`role`/`roles`/`isAdmin`).
 * A caller who is NOT recognized as admin by this heuristic still owns any
 * profile they created — this only ever WIDENS access for a real admin, it
 * never narrows a non-admin creator's own access. Track tightening this once
 * a confirmed Hub admin claim key is documented (see plan.md open questions).
 */
export function isWorkspaceAdmin(actor: VerifiedActor): boolean {
  const claims = actor.claims;
  if (claims.isAdmin === true || claims.admin === true) return true;
  if (typeof claims.role === 'string' && claims.role.toLowerCase() === 'admin') return true;
  if (Array.isArray(claims.roles) && claims.roles.some((r) => typeof r === 'string' && r.toLowerCase() === 'admin')) return true;
  return false;
}

/**
 * Re-reads a fileId's OWN metadata from Files and asserts its `channel_id`
 * equals `roomId` — never trusts a list response, a client-supplied id, or a
 * value cached from an earlier call. Throws a clear Vietnamese `AppError` when
 * the file is missing or belongs to a different room.
 */
export async function assertFileInRoom(hub: RoomBoundHubClient, fileId: string, roomId: string, signal?: AbortSignal) {
  const meta = await getFileMetadata(hub, fileId, signal);
  if (!meta || meta.channel_id !== roomId) {
    throw new AppError(`Không tìm thấy tệp hoặc tệp không thuộc phòng này (fileId=${fileId}).`);
  }
  return meta;
}
