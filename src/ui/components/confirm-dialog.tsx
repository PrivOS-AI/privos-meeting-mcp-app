/**
 * In-app confirmation dialog. Replaces `window.confirm()`, which the Hub's
 * sandboxed app iframe silently ignores — without the `allow-modals` sandbox
 * token (set Hub-side, not by this app) a native `confirm()` never shows and
 * returns `false`, so any action gated on it (e.g. the history row "Delete")
 * looked dead on click. Portaled to `document.body` to escape the history
 * table's `overflow` scroll ancestors, and dismissable via Escape or backdrop.
 */
import { useEffect } from 'react';
import { createPortal } from 'react-dom';

export interface ConfirmDialogProps {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  /** Style the confirm button as destructive (red). */
  danger?: boolean;
  onConfirm(): void;
  onCancel(): void;
}

export function ConfirmDialog({ title, message, confirmLabel, cancelLabel, danger, onConfirm, onCancel }: ConfirmDialogProps) {
  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      if (event.key === 'Escape') onCancel();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return createPortal(
    <div className="ma-modal-overlay" role="presentation" onClick={onCancel}>
      <div
        className="ma-modal ma-confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="ma-confirm-dialog-title"
        aria-describedby="ma-confirm-dialog-message"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id="ma-confirm-dialog-title" className="ma-confirm-dialog__title">
          {title}
        </h2>
        <p id="ma-confirm-dialog-message" className="ma-confirm-dialog__message">
          {message}
        </p>
        <div className="ma-confirm-dialog__actions">
          <button type="button" className="ma-confirm-dialog__cancel" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={danger ? 'ma-confirm-dialog__confirm ma-confirm-dialog__confirm--danger' : 'ma-confirm-dialog__confirm'}
            onClick={onConfirm}
            autoFocus
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
