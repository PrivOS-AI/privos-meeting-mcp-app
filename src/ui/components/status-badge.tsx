/**
 * Meeting status badge (phase-07 § Requirements: "Summarized green / Processing
 * orange / Failed red / Private gray"). `meetings.status` values are
 * `recording|uploading|processing|failed|interrupted|summarized`
 * (`shared/app-db-schema.ts`); anything not explicitly green/orange/red falls
 * back to the neutral "Private" tone — matching the design's 4th badge state
 * for a status this app does not otherwise surface a distinct color for.
 */
import { useI18n } from '../i18n/i18n-provider.js';

type Tone = 'success' | 'warning' | 'danger' | 'neutral';

const TONE_BY_STATUS: Record<string, Tone> = {
  summarized: 'success',
  processing: 'warning',
  recording: 'warning',
  uploading: 'warning',
  failed: 'danger',
};

export interface StatusBadgeProps {
  status?: string;
}

export function StatusBadge({ status }: StatusBadgeProps) {
  const { t } = useI18n();
  const tone = (status && TONE_BY_STATUS[status]) || 'neutral';
  const labelKey = status && TONE_BY_STATUS[status] ? `status.${status}` : 'status.private';
  return <span className={`ma-status-badge ma-status-badge--${tone}`}>{t(labelKey)}</span>;
}
