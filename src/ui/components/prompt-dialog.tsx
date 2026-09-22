/**
 * In-app single-line text prompt. Replaces `window.prompt()`, which the Hub's
 * sandboxed app iframe silently ignores (no `allow-modals`) — the native call
 * returns null and the action (e.g. history "Rename") looked dead. Shares the
 * modal shell with {@link ConfirmDialog}; portaled to body, Enter submits,
 * Escape / backdrop cancels, and an empty value disables submit.
 */
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

export interface PromptDialogProps {
  title: string;
  initialValue: string;
  confirmLabel: string;
  cancelLabel: string;
  maxLength?: number;
  onSubmit(value: string): void;
  onCancel(): void;
}

export function PromptDialog({ title, initialValue, confirmLabel, cancelLabel, maxLength, onSubmit, onCancel }: PromptDialogProps) {
  const [value, setValue] = useState(initialValue);

  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      if (event.key === 'Escape') onCancel();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const trimmed = value.trim();

  function submit(): void {
    if (trimmed) onSubmit(trimmed);
  }

  return createPortal(
    <div className="ma-modal-overlay" role="presentation" onClick={onCancel}>
      <div
        className="ma-modal ma-confirm-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ma-prompt-dialog-title"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id="ma-prompt-dialog-title" className="ma-confirm-dialog__title">
          {title}
        </h2>
        <input
          className="ma-prompt-dialog__input"
          value={value}
          maxLength={maxLength}
          autoFocus
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') submit();
          }}
        />
        <div className="ma-confirm-dialog__actions">
          <button type="button" className="ma-confirm-dialog__cancel" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button type="button" className="ma-confirm-dialog__confirm" disabled={!trimmed} onClick={submit}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
