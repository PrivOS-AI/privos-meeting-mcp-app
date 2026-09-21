/**
 * Warns when the installation bot cannot act on the app's behalf. Checked
 * once on mount via `meeting_agent_bot_credential_check`; renders nothing
 * while loading or once the credential is confirmed valid.
 */
import { useEffect, useState } from 'react';
import { parseToolResult, usePrivosApp } from '@privos_ai/app-react';

import { useI18n } from '../i18n/i18n-provider.js';
import { Icon } from './icon.js';

type BotCredentialStatus = 'valid' | 'not-configured' | 'invalid' | 'hub-unreachable';

interface BotCredentialCheckResult {
  status: BotCredentialStatus;
  botId?: string;
  username?: string;
}

function isBotCredentialStatus(value: unknown): value is BotCredentialStatus {
  return value === 'valid' || value === 'not-configured' || value === 'invalid' || value === 'hub-unreachable';
}

export function BotCredentialBanner() {
  const app = usePrivosApp();
  const { t } = useI18n();
  const [status, setStatus] = useState<BotCredentialStatus | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    app
      .callServerTool({ name: 'meeting_agent_bot_credential_check', arguments: {} })
      .then((raw) => {
        if (cancelled) return;
        const parsed = parseToolResult(raw) as Partial<BotCredentialCheckResult>;
        setStatus(isBotCredentialStatus(parsed.status) ? parsed.status : 'hub-unreachable');
      })
      .catch(() => {
        // A failed check degrades to "unreachable" rather than blocking render;
        // the rest of the shell must still work when the Hub is briefly down.
        if (!cancelled) setStatus('hub-unreachable');
      });
    return () => {
      cancelled = true;
    };
  }, [app]);

  if (dismissed || status === null || status === 'valid') return null;

  const copyKey =
    status === 'not-configured'
      ? 'banner.botCredential.notConfigured'
      : status === 'invalid'
        ? 'banner.botCredential.invalid'
        : 'banner.botCredential.hub-unreachable';

  return (
    <div className="ma-banner" role="status" aria-live="polite">
      <span className="ma-banner__icon">
        <Icon name="alert-circle" size={18} />
      </span>
      <span className="ma-banner__body">{t(copyKey)}</span>
      <button
        type="button"
        className="ma-banner__dismiss"
        aria-label={t('banner.dismiss')}
        onClick={() => setDismissed(true)}
      >
        <Icon name="checkmark" size={14} />
      </button>
    </div>
  );
}
