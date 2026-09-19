/**
 * History table row "⋯" menu (phase-07 § Requirements: "Open, Rename, Export
 * SRT, Export DOCX, Delete"). "Delete" is only rendered for the meeting owner
 * (`canDelete`, resolved by the caller from `ownerUserId === userId` — phase
 * risk table: "only the meeting owner sees the Delete button").
 */
import { useEffect, useRef, useState } from 'react';

import { useI18n } from '../i18n/i18n-provider.js';
import { Icon } from './icon.js';

export interface MeetingRowMenuProps {
  canDelete: boolean;
  onOpen(): void;
  onRename(): void;
  onExportSrt(): void;
  onExportDocx(): void;
  onDelete(): void;
}

export function MeetingRowMenu({ canDelete, onOpen, onRename, onExportSrt, onExportDocx, onDelete }: MeetingRowMenuProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    function onDocumentClick(event: MouseEvent): void {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDocumentClick);
    return () => document.removeEventListener('mousedown', onDocumentClick);
  }, [open]);

  function run(action: () => void): void {
    setOpen(false);
    action();
  }

  return (
    <div className="ma-row-menu" ref={containerRef}>
      <button type="button" className="ma-row-menu__trigger" aria-label={t('history.rowMenu.label')} onClick={() => setOpen((v) => !v)}>
        <Icon name="more" size={16} />
      </button>
      {open ? (
        <ul className="ma-row-menu__list" role="menu">
          <li>
            <button type="button" role="menuitem" onClick={() => run(onOpen)}>
              {t('history.rowMenu.open')}
            </button>
          </li>
          <li>
            <button type="button" role="menuitem" onClick={() => run(onRename)}>
              {t('history.rowMenu.rename')}
            </button>
          </li>
          <li>
            <button type="button" role="menuitem" onClick={() => run(onExportSrt)}>
              {t('history.rowMenu.exportSrt')}
            </button>
          </li>
          <li>
            <button type="button" role="menuitem" onClick={() => run(onExportDocx)}>
              {t('history.rowMenu.exportDocx')}
            </button>
          </li>
          {canDelete ? (
            <li>
              <button type="button" role="menuitem" className="ma-row-menu__danger" onClick={() => run(onDelete)}>
                {t('history.rowMenu.delete')}
              </button>
            </li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}
