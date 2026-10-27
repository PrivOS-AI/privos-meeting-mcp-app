/**
 * Workspace-admin check, shared by every tool that gates on it
 * (`meeting_settings_set`, `meeting_stt_status`, `speaker_profile_update`/
 * `_delete`). Reads the Hub-signed `workspace_roles` claim, lifted by the SDK to
 * `actor.workspaceRoles` when the app holds `rooms:roles:read`. Absent claim =
 * not an admin (fail closed); a profile's creator keeps access to their own
 * profile either way.
 */
import type { VerifiedActor } from '@privos_ai/app-server';

export function isWorkspaceAdmin(actor: VerifiedActor): boolean {
  return actor.workspaceRoles?.includes('admin') ?? false;
}
