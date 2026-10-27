/**
 * Shared "may the current caller change this room's settings" probe (room
 * owners, moderators and workspace admins — enforced server-side in
 * `can-manage-room-settings.ts`) for the panels that disable those controls
 * (Privacy, AI summary, speaker threshold). `speech-recognition-panel.tsx`
 * derives the same signal from its own `meeting_stt_status` payload and does
 * not use this hook. `meeting_stt_status` is reused rather than adding an
 * "am I allowed" tool: a caller who may manage gets the full
 * `{providers: [...]}` shape back, anyone else gets `{ok}` only — the shape
 * itself is the signal. UX only; the server still decides every write.
 */
import { useEffect, useState } from 'react';
import { parseToolResult, usePrivosApp } from '@privos_ai/app-react';

export function useCanManageRoomSettings(): { canManage: boolean; loading: boolean } {
  const app = usePrivosApp();
  const [canManage, setCanManage] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    app
      .callServerTool({ name: 'meeting_stt_status', arguments: {} })
      .then((raw) => {
        if (cancelled) return;
        const result = parseToolResult(raw) as Record<string, unknown>;
        setCanManage('providers' in result);
      })
      .catch(() => {
        if (!cancelled) setCanManage(false);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [app]);

  return { canManage, loading };
}
