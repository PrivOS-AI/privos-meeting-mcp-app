/**
 * "Save to PrivOS Files" confirmation modal (phase-06 § Requirements): shows
 * the meeting folder path and each of the 5 stored artifacts' saved/pending
 * state, plus a best-effort "Open in Files" deep link.
 *
 * OPEN QUESTION (static-only phase, no live pairing): the exact URI scheme
 * the Hub resolves for a cross-app folder deep link was never observed.
 * `privos://files/<id>` mirrors `send-to-chat-tool.ts`'s own best-effort file
 * link convention (plan default); if the host does not handle it the button
 * just opens a blank/failed tab, degrading silently rather than breaking the
 * modal.
 */
import { folderName } from '../../shared/meeting-slug.js';
import { useI18n } from '../i18n/i18n-provider.js';
import { Icon } from './icon.js';

export interface SaveToFilesArtifact {
  labelKey: string;
  fileId?: string;
}

export interface SaveToFilesModalProps {
  title: string;
  meetingId: string;
  startedAt?: string;
  folderId?: string;
  artifacts: SaveToFilesArtifact[];
  onClose(): void;
}

export function SaveToFilesModal({ title, meetingId, startedAt, folderId, artifacts, onClose }: SaveToFilesModalProps) {
  const { t } = useI18n();
  const path = folderName(title, meetingId, startedAt ? new Date(startedAt) : new Date());

  return (
    <div className="ma-modal-overlay" role="dialog" aria-modal="true" aria-labelledby="ma-save-to-files-title">
      <div className="ma-modal ma-save-to-files">
        <h2 id="ma-save-to-files-title">{t('saveToFiles.title')}</h2>
        <p className="ma-save-to-files__path">
          <Icon name="document" size={14} /> {path}
        </p>

        <ul className="ma-save-to-files__list">
          {artifacts.map((artifact) => (
            <li key={artifact.labelKey} className="ma-save-to-files__row">
              <span>{t(artifact.labelKey)}</span>
              <span className={artifact.fileId ? 'ma-save-to-files__status ma-save-to-files__status--saved' : 'ma-save-to-files__status'}>
                <Icon name={artifact.fileId ? 'checkmark-circle' : 'clock'} size={14} />
                {artifact.fileId ? t('saveToFiles.saved') : t('saveToFiles.pending')}
              </span>
            </li>
          ))}
        </ul>

        <div className="ma-save-to-files__actions">
          {folderId ? (
            <button
              type="button"
              className="ma-save-to-files__open"
              onClick={() => window.open(`privos://files/${encodeURIComponent(folderId)}`, '_blank')}
            >
              <Icon name="arrow-export" size={14} /> {t('saveToFiles.openInFiles')}
            </button>
          ) : null}
          <button type="button" className="ma-save-to-files__close" onClick={onClose}>
            {t('saveToFiles.close')}
          </button>
        </div>
      </div>
    </div>
  );
}
