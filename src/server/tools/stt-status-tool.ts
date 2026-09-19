/**
 * `meeting_stt_status` — reports the status of BOTH STT vendors (realtime +
 * async), including the one not currently selected, so an admin can compare
 * before switching (QĐ-15). There is no API-key input field (QĐ-08); this
 * only ever exposes configured/ok booleans, model names and (for ElevenLabs)
 * account usage figures — never a key.
 *
 * Admin-only: a non-admin verified caller gets `{ ok }` only (plan.md § Tool
 * trạng thái STT — "người khác chỉ { ok }"), computed from whichever provider
 * is currently ACTIVE so a non-admin still sees "is live captioning up" without
 * seeing which vendor or its usage.
 */
import { requireVerifiedActor } from './authz.js';
import { canManageRoomSettings } from './can-manage-room-settings.js';
import { AppDbBotClient } from '../hub/app-db-bot-client.js';
import { env } from '../env.js';
import { allProviderStatuses, realtimeProviderFor, resolveAsyncVendor, resolveRealtimeVendor } from '../stt/stt-provider-registry.js';
import { countActiveRealtimeRecordings } from './realtime-token-tool.js';
import type { AppTool } from './registry.js';

export const sttStatusTool: AppTool = {
  name: 'meeting_stt_status',
  title: 'Trạng thái nhận dạng giọng nói',
  description: 'Trạng thái của cả hai nhà cung cấp STT để quản trị viên so sánh.',
  inputSchema: { type: 'object', properties: {} },
  async execute(_args, context) {
    const actor = requireVerifiedActor(context);
    // Bind to the caller's room so the global `app_settings` reads resolve to the granted `room` permission context.
    const db = new AppDbBotClient(actor.roomId ?? context.roomId);
    const realtimeVendor = await resolveRealtimeVendor(db).catch(() => undefined);

    if (!canManageRoomSettings(actor)) {
      // Not a room member: only "is the currently active realtime provider usable" —
      // never the vendor name, model, or usage.
      const ok = realtimeVendor ? (await realtimeProviderFor(realtimeVendor).status()).ok : false;
      return { ok };
    }

    const [statuses, asyncVendor, activeSessions] = await Promise.all([
      allProviderStatuses(),
      resolveAsyncVendor(db).catch(() => undefined),
      countActiveRealtimeRecordings().catch(() => undefined),
    ]);

    return {
      ok: true,
      activeRealtimeProvider: realtimeVendor,
      activeAsyncProvider: asyncVendor,
      providers: statuses,
      liveConcurrency: { active: activeSessions, max: env.liveMaxConcurrentRecordings },
      checkedAt: new Date().toISOString(),
    };
  },
};
