/**
 * `meeting_stt_status` — reports the status of BOTH STT vendors (realtime +
 * async), including the one not currently selected, so an admin can compare
 * before switching (QĐ-15). There is no API-key input field (QĐ-08); this only
 * exposes configured/ok booleans and model names, never a key.
 *
 * Admin-only gating of the detailed view is hardened in P8; the scaffold returns
 * the (secret-free) detail to every verified caller.
 */
import { AppDbBotClient } from '../hub/app-db-bot-client.js';
import { allProviderStatuses, resolveAsyncVendor, resolveRealtimeVendor } from '../stt/stt-provider-registry.js';
import type { AppTool } from './registry.js';

export const sttStatusTool: AppTool = {
  name: 'meeting_stt_status',
  title: 'Trạng thái nhận dạng giọng nói',
  description: 'Trạng thái của cả hai nhà cung cấp STT để quản trị viên so sánh.',
  inputSchema: { type: 'object', properties: {} },
  async execute() {
    const db = new AppDbBotClient();
    const [statuses, realtimeVendor, asyncVendor] = await Promise.all([
      allProviderStatuses(),
      resolveRealtimeVendor(db).catch(() => undefined),
      resolveAsyncVendor(db).catch(() => undefined),
    ]);
    return {
      ok: true,
      activeRealtimeProvider: realtimeVendor,
      activeAsyncProvider: asyncVendor,
      providers: statuses,
    };
  },
};
