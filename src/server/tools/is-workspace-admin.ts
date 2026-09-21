/**
 * Best-effort workspace-admin check, shared by every tool that gates on it
 * (`meeting_settings_set`, `meeting_stt_status`, `speaker_profile_update`/
 * `_delete`). The SDK's `VerifiedActor.claims` is an untyped
 * `Record<string, unknown>` — there is no dedicated "is this user a
 * workspace admin" claim documented anywhere in this app's PrivOS dev-docs
 * references, so this reads the conventional flags a Hub-issued JWT is most
 * likely to carry (`role`/`roles`/`isAdmin`/`admin`). A caller who is NOT
 * recognized as admin by this heuristic still owns any profile they
 * created — this only ever WIDENS access for a real admin, it never narrows
 * a non-admin creator's own access. Track tightening this once a confirmed
 * Hub admin claim key is documented (plan.md open questions).
 */
import type { VerifiedActor } from '@privos_ai/app-server';

export function isWorkspaceAdmin(actor: VerifiedActor): boolean {
  const claims = actor.claims;
  if (claims.isAdmin === true || claims.admin === true) return true;
  if (typeof claims.role === 'string' && claims.role.toLowerCase() === 'admin') return true;
  if (Array.isArray(claims.roles) && claims.roles.some((r) => typeof r === 'string' && r.toLowerCase() === 'admin')) return true;
  return false;
}
