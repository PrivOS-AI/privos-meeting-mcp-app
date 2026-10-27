/**
 * Shown when a backend call failed with `ASSISTANT_NOT_IN_ROOM`: the
 * installation bot is not a member of this room, so the Hub refuses every
 * scope it uses (that is not a missing grant). Offers the fix — add it through
 * `mcpapp.bot.joinCurrentRoom`, run as the current user — and, when that is
 * refused (no `bot:room:join`, or the user may not add members), says how to
 * invite the bot by hand.
 */
import { useState } from 'react';
import { usePrivosApp } from '@privos_ai/app-react';

import { useI18n } from '../i18n/i18n-provider.js';
import { Icon } from './icon.js';

interface AssistantRoomBannerProps {
  botSlug: string;
  /** Re-run whatever failed once the bot has joined. */
  onJoined(): void;
}

export function AssistantRoomBanner({ botSlug, onJoined }: AssistantRoomBannerProps) {
  const app = usePrivosApp();
  const { t } = useI18n();
  const [state, setState] = useState<'idle' | 'joining' | 'manual'>('idle');

  async function join(): Promise<void> {
    setState('joining');
    try {
      await app.callServerTool({ name: 'mcpapp.bot.joinCurrentRoom', arguments: {} });
      onJoined();
    } catch {
      setState('manual');
    }
  }

  return (
    <div className="ma-banner" role="status" aria-live="polite">
      <span className="ma-banner__icon">
        <Icon name="alert-circle" size={18} />
      </span>
      <span className="ma-banner__body">
        {state === 'manual' ? t('banner.assistantNotInRoom.manual', { slug: botSlug }) : t('banner.assistantNotInRoom.message')}
      </span>
      {state === 'manual' ? null : (
        <button type="button" className="ma-banner__action" disabled={state === 'joining'} onClick={() => void join()}>
          {t(state === 'joining' ? 'banner.assistantNotInRoom.adding' : 'banner.assistantNotInRoom.add')}
        </button>
      )}
    </div>
  );
}
