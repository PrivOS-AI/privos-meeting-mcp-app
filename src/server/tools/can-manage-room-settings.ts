/**
 * Who may change a room's settings (STT provider, retention, thresholds…):
 * the room's owners and moderators, and workspace admins.
 *
 * Roles come from the Hub-signed `room_roles` / `workspace_roles` claims, which
 * the Hub adds only when the app holds `rooms:roles:read` (the SDK lifts them
 * to `actor.roomRoles` / `actor.workspaceRoles`). FAIL CLOSED: without them —
 * scope not granted, or a dispatch path that does not carry roles (the
 * managed runtime in `@privos_ai/app-server` 0.12) — nobody can write, and the
 * room keeps its current values / the defaults.
 */
import type { VerifiedActor } from '@privos_ai/app-server';

import { isWorkspaceAdmin } from './is-workspace-admin.js';

const ROOM_MANAGER_ROLES = ['owner', 'moderator'];

export function canManageRoomSettings(actor: VerifiedActor): boolean {
  if (typeof actor.roomId !== 'string' || actor.roomId.length === 0) return false;
  if (isWorkspaceAdmin(actor)) return true;
  return (actor.roomRoles ?? []).some((role) => ROOM_MANAGER_ROLES.includes(role));
}
