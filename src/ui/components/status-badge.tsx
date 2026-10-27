import { useI18n } from '../i18n/i18n-provider.js';

type Tone = 'success' | 'warning' | 'danger' | 'neutral';

/** Every status a meeting row is written with (UI recorder, `meeting-job.ts`, `startup-sweep.ts`). */
const TONE_BY_STATUS: Record<string, Tone> = {
  summarized: 'success',
  transcriptOnly: 'neutral',
  processing: 'warning',
  recording: 'warning',
  uploading: 'warning',
  interrupted: 'danger',
  failed: 'danger',
};

export interface StatusBadgeProps {
  status?: string;
  /**
   * A finished meeting whose summary step failed is still `summarized` on the row (the transcript is kept);
   * pass `false` to label it "Transcript only" instead of claiming a summary exists.
   */
  hasSummary?: boolean;
}

export function StatusBadge({ status, hasSummary }: StatusBadgeProps) {
  const { t } = useI18n();
  const shown = status === 'summarized' && hasSummary === false ? 'transcriptOnly' : status;
  const known = Boolean(shown && TONE_BY_STATUS[shown]);
  const tone = known ? TONE_BY_STATUS[shown as string] : 'neutral';
  return <span className={`ma-status-badge ma-status-badge--${tone}`}>{t(known ? `status.${shown}` : 'status.unknown')}</span>;
}
