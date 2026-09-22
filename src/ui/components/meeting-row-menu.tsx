/**
 * History table row "⋯" menu (phase-07 § Requirements: "Open, Rename, Export
 * SRT, Export DOCX, Delete"). "Delete" is only rendered for the meeting owner
 * (`canDelete`, resolved by the caller from `ownerUserId === userId` — phase
 * risk table: "only the meeting owner sees the Delete button").
 *
 * The dropdown is portaled to `document.body` and positioned `fixed` against
 * the trigger's viewport rect. An in-flow `position:absolute` list is clipped
 * by scroll ancestors — the history table's `overflow-x:auto` on mobile and the
 * app column's `overflow:auto` on desktop both cut off a dropdown that opens
 * downward — which made the menu look dead. A portal escapes every such box.
 *
 * Direction heuristic: if less than MENU_MAX_HEIGHT px remain below the
 * trigger, the list opens upward (anchored to the trigger's top edge) instead
 * of downward, so rows near the bottom of the viewport are never clipped.
 */
import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { useI18n } from '../i18n/i18n-provider.js';
import { Icon } from './icon.js';
import { computeRowMenuPosition, type RowMenuPosition } from './row-menu-position.js';

const MENU_GAP = 4;
// Estimated max height of the menu list (5 items × ~36 px + 16 px padding).
const MENU_MAX_HEIGHT = 220;

export interface MeetingRowMenuProps {
  canDelete: boolean;
  /** True while deleteMeeting is in flight — shows "Deleting…" and disables the trigger. */
  isDeleting?: boolean;
  onOpen(): void;
  onRename(): void;
  onExportSrt(): void;
  onExportDocx(): void;
  onDelete(): void;
}

export function MeetingRowMenu({ canDelete, isDeleting, onOpen, onRename, onExportSrt, onExportDocx, onDelete }: MeetingRowMenuProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<RowMenuPosition | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  useLayoutEffect(() => {
    if (!open) return undefined;

    function reposition(): void {
      const el = triggerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      setCoords(
        computeRowMenuPosition(
          { top: rect.top, bottom: rect.bottom, right: rect.right },
          { width: window.innerWidth, height: window.innerHeight },
          { gap: MENU_GAP, maxHeight: MENU_MAX_HEIGHT },
        ),
      );
    }
    reposition();

    function onDocumentPointer(event: MouseEvent): void {
      const target = event.target as Node;
      // The list lives outside `triggerRef` now (portal), so it must be checked
      // separately or a click on a menu item would count as "outside" and close
      // the menu on mousedown before the item's click handler runs.
      if (triggerRef.current?.contains(target)) return;
      if (listRef.current?.contains(target)) return;
      setOpen(false);
    }

    document.addEventListener('mousedown', onDocumentPointer);
    // Fixed coords go stale when the page or any scroll ancestor moves.
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    return () => {
      document.removeEventListener('mousedown', onDocumentPointer);
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
    };
  }, [open]);

  function run(action: () => void): void {
    setOpen(false);
    action();
  }

  return (
    <div className="ma-row-menu">
      <button
        type="button"
        ref={triggerRef}
        className={isDeleting ? 'ma-row-menu__trigger ma-row-menu__trigger--deleting' : 'ma-row-menu__trigger'}
        aria-label={isDeleting ? t('history.rowMenu.deleting') : t('history.rowMenu.label')}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={isDeleting}
        onClick={() => setOpen((v) => !v)}
      >
        {isDeleting ? <span className="ma-row-menu__deleting-label">{t('history.rowMenu.deleting')}</span> : <Icon name="more" size={16} />}
      </button>
      {open && coords
        ? createPortal(
            <ul
              className="ma-row-menu__list"
              role="menu"
              ref={listRef}
              style={{ position: 'fixed', top: coords.top, bottom: coords.bottom, right: coords.right, margin: 0 }}
            >
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
            </ul>,
            document.body,
          )
        : null}
    </div>
  );
}
