/**
 * Shared "is the current caller a workspace admin" probe for the panels that
 * need to hide/disable admin-only controls (Privacy, AI summary) but do not
 * otherwise need STT status data (`speech-recognition-panel.tsx` derives the
 * same signal from its own `meeting_stt_status` payload shape and does not
 * use this hook — one probe call is enough there). `meeting_stt_status` is
 * reused here rather than adding a dedicated "am I admin" tool: an admin
 * caller gets the full `{providers: [...]}` shape back, anyone else gets
 * `{ok}` only — the shape itself is the signal (plan.md § Tool trạng thái STT).
 */
import { useEffect, useState } from 'react';
import { parseToolResult, usePrivosApp } from '@privos_ai/app-react';

export function useWorkspaceAdmin(): { isAdmin: boolean; loading: boolean } {
  const app = usePrivosApp();
  const [isAdmin, setIsAdmin] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    app
      .callServerTool({ name: 'meeting_stt_status', arguments: {} })
      .then((raw) => {
        if (cancelled) return;
        const result = parseToolResult(raw) as Record<string, unknown>;
        setIsAdmin('providers' in result);
      })
      .catch(() => {
        if (!cancelled) setIsAdmin(false);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [app]);

  return { isAdmin, loading };
}
