/**
 * "Send to Chat room" button (phase-06 § Requirements/Architecture).
 * `meeting_send_to_chat` builds the text server-side and NEVER swallows a
 * Hub rejection (see `send-to-chat-tool.ts`) — "no silent failure". Whether
 * the bot can actually post depends on its identity (spike P1-6,
 * `mcpapp.bot.getMe`), never observed against a live Hub in this static-only
 * phase; plan default: the button stays ENABLED whenever the room grants
 * `bot:message:send` and a summary exists, and a Hub-side failure surfaces
 * inline with the button re-enabled for retry. Missing scope alone disables
 * it up front with a tooltip (manifest `degradedBehavior`).
 */
import { useState } from 'react';
import { parseToolResult, usePrivosApp, usePrivosContext } from '@privos_ai/app-react';

import { useI18n } from '../i18n/i18n-provider.js';
import { Icon } from './icon.js';

export interface SendToChatButtonProps {
  roomId: string;
  meetingId: string;
  hasSummary: boolean;
  sentToChatAt?: string;
  onSent(): void;
}

export function SendToChatButton({ roomId, meetingId, hasSummary, sentToChatAt, onSent }: SendToChatButtonProps) {
  const app = usePrivosApp();
  const { effectiveScopes } = usePrivosContext();
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hasScope = !effectiveScopes || effectiveScopes.includes('bot:message:send');
  const alreadySent = Boolean(sentToChatAt);
  const disabled = !hasScope || !hasSummary || busy || alreadySent;

  async function send(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const raw = await app.callServerTool({ name: 'meeting_send_to_chat', arguments: { roomId, meetingId } });
      parseToolResult(raw);
      onSent();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const title = !hasScope ? t('sendToChat.noScope') : alreadySent ? t('sendToChat.alreadySent') : undefined;

  return (
    <div className="ma-send-to-chat">
      <button type="button" className="ma-send-to-chat__button" disabled={disabled} title={title} onClick={() => void send()}>
        <Icon name="chat" size={14} /> {busy ? t('sendToChat.sending') : alreadySent ? t('sendToChat.sent') : t('sendToChat.send')}
      </button>
      {error ? (
        <span className="ma-send-to-chat__error" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}
