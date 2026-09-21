/**
 * Who may change a room's settings (STT provider, retention, thresholds…).
 *
 * INTERIM POLICY: any verified member of the room. The Hub's user token carries
 * identity only (`sub`, `preferred_username`, `rid`) — no workspace role and no
 * room role (owner/moderator) — and the role lookups an app could make are not
 * usable server-side (the room is a private group, `channels.*` rejects it, the
 * subscription exposes no roles). Until the Hub delivers a room-role signal to
 * apps, owner-only gating cannot be enforced honestly, so it is not pretended:
 * settings are per room (see `roomSettingKey`), which bounds the blast radius of
 * this policy to the caller's own room. Tighten HERE once the Hub exposes roles.
 */
import type { VerifiedActor } from '@privos_ai/app-server';

export function canManageRoomSettings(actor: VerifiedActor): boolean {
  return typeof actor.roomId === 'string' && actor.roomId.length > 0;
}
