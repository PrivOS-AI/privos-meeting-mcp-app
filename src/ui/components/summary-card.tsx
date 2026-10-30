/**
 * Phase 6 "Summary" panel — narrative summary (`meetings.summaryText`) +
 * `key_topics` chips + copy + "Regenerate summary" (re-runs `meeting_summarize`,
 * useful right after a Hub AI failure or after speakers were relabeled).
 * Decisions and action-item owner/due are NOT re-shown here: `meeting-job.ts`
 * only persists `payload.summary`/`payload.key_topics` onto `meetings` —
 * decisions live in the saved `summary.md` (via "Save to Files"), action
 * items in their own `action-items-card.tsx`.
 */
import { useState } from 'react';
import { parseToolResult, usePrivosApp } from '@privos_ai/app-react';

import { copyText } from '../data/copy-text.js';
import { useI18n } from '../i18n/i18n-provider.js';
import { MarkdownText } from './markdown-text.js';
import { Icon } from './icon.js';

export interface SummaryCardProps {
  roomId: string;
  meetingId: string;
  summaryText?: string;
  keyTopics?: string[];
  summaryError?: string;
  onRegenerated(): void;
}

export function SummaryCard({ roomId, meetingId, summaryText, keyTopics, summaryError, onRegenerated }: SummaryCardProps) {
  const app = usePrivosApp();
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function regenerate(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const raw = await app.callServerTool({ name: 'meeting_summarize', arguments: { roomId, meetingId } });
      parseToolResult(raw);
      onRegenerated();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function copy(): Promise<void> {
    if (!summaryText) return;
    // Without the Clipboard API (blocked in the Hub's iframe) the text stays selectable on screen.
    if (await copyText(summaryText)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }

  return (
    <section className="ma-summary-card">
      <header className="ma-summary-card__header">
        <h3 className="ma-summary-card__title">
          <Icon name="sparkle" size={16} /> {t('summary.title')}
        </h3>
        <div className="ma-summary-card__actions">
          {summaryText ? (
            <button type="button" onClick={() => void copy()} className="ma-summary-card__action">
              <Icon name="copy" size={14} /> {copied ? t('summary.copied') : t('summary.copy')}
            </button>
          ) : null}
          <button type="button" onClick={() => void regenerate()} disabled={busy} className="ma-summary-card__action">
            {busy ? t('summary.regenerating') : t('summary.regenerate')}
          </button>
        </div>
      </header>

      {summaryError ? (
        <p className="ma-summary-card__error" role="alert">
          {summaryError}
        </p>
      ) : null}
      {error ? (
        <p className="ma-summary-card__error" role="alert">
          {error}
        </p>
      ) : null}

      {summaryText ? <MarkdownText source={summaryText} className="ma-summary-card__text" /> : <p className="ma-summary-card__empty">{t('summary.empty')}</p>}

      {keyTopics && keyTopics.length > 0 ? (
        <ul className="ma-summary-card__topics">
          {keyTopics.map((topic) => (
            <li key={topic}>{topic}</li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
