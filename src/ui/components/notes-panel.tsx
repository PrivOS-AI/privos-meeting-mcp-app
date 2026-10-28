/**
 * The meeting owner's notes: saved automatically a few seconds after typing
 * stops (to the meeting, and to notes.md in its Files folder), and read by
 * the summary as "what the recorder found important". While recording, a
 * button stamps the current meeting time. Read-only for everyone else.
 */
import { useEffect, useRef, useState } from 'react';
import { usePrivosApp } from '@privos_ai/app-react';

import { formatClock } from '../data/format-time.js';
import { saveNotes } from '../data/meeting-qa-api.js';
import { useI18n } from '../i18n/i18n-provider.js';
import { Icon } from './icon.js';

export interface NotesPanelProps {
  roomId: string;
  meetingId: string;
  initialText: string;
  editable: boolean;
  /** While recording: the current meeting time, for "insert timestamp". */
  currentSec?: () => number;
  /** Every edit, so a parent that outlives this panel (tab switches) can hand the text back. */
  onTextChange?(text: string): void;
}

const SAVE_DELAY_MS = 3000;
const MAX_NOTES = 20_000;

type SaveState = 'idle' | 'pending' | 'saving' | 'saved' | { error: string };

export function NotesPanel({ roomId, meetingId, initialText, editable, currentSec, onTextChange }: NotesPanelProps) {
  const app = usePrivosApp();
  const { t } = useI18n();
  const [text, setText] = useState(initialText);
  const [state, setState] = useState<SaveState>('idle');
  const textRef = useRef(text);
  textRef.current = text;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const area = useRef<HTMLTextAreaElement | null>(null);

  // A newer meeting record (or another meeting) replaces what is shown, unless an edit is still unsaved.
  useEffect(() => {
    if (state !== 'pending' && state !== 'saving') setText(initialText);
    // Only an incoming value resets the box — not every save-state change.
  }, [initialText, meetingId]);

  async function flush(): Promise<void> {
    timer.current = null;
    setState('saving');
    try {
      // The clock is the revision: always higher than the last save, so a slow save can never win over a newer one.
      await saveNotes(app, { roomId, meetingId, text: textRef.current, revision: Date.now() });
      setState('saved');
    } catch (err) {
      setState({ error: err instanceof Error ? err.message : String(err) });
    }
  }

  function change(next: string): void {
    const capped = next.slice(0, MAX_NOTES);
    setText(capped);
    onTextChange?.(capped);
    setState('pending');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), SAVE_DELAY_MS);
  }

  // Leaving the panel saves what is pending instead of dropping it.
  useEffect(
    () => () => {
      if (timer.current) {
        clearTimeout(timer.current);
        void saveNotes(app, { roomId, meetingId, text: textRef.current, revision: Date.now() }).catch(() => undefined);
      }
    },
    [app, roomId, meetingId],
  );

  function insertTimestamp(): void {
    if (!currentSec) return;
    const el = area.current;
    const stamp = `[${formatClock(currentSec())}] `;
    const at = el ? el.selectionStart : text.length;
    const before = text.slice(0, at);
    const prefix = before && !before.endsWith('\n') ? '\n' : '';
    change(`${before}${prefix}${stamp}${text.slice(at)}`);
    requestAnimationFrame(() => {
      el?.focus();
      const caret = at + prefix.length + stamp.length;
      el?.setSelectionRange(caret, caret);
    });
  }

  if (!editable) {
    return <section className="ma-notes">{text.trim() ? <p className="ma-notes__readonly">{text}</p> : <p className="ma-side-panel__empty">{t('notes.empty')}</p>}</section>;
  }

  return (
    <section className="ma-notes">
      <div className="ma-notes__toolbar">
        {currentSec ? (
          <button type="button" className="ma-notes__stamp" onClick={insertTimestamp}>
            <Icon name="clock" size={12} /> {t('notes.insertTime')}
          </button>
        ) : null}
        <span className="ma-notes__state" aria-live="polite">
          {state === 'pending' || state === 'saving' ? t('notes.saving') : state === 'saved' ? t('notes.saved') : typeof state === 'object' ? state.error : ''}
        </span>
      </div>
      <label className="ma-visually-hidden" htmlFor={`ma-notes-${meetingId}`}>
        {t('notes.label')}
      </label>
      <textarea
        id={`ma-notes-${meetingId}`}
        ref={area}
        className="ma-notes__area"
        value={text}
        placeholder={t('notes.placeholder')}
        onChange={(e) => change(e.target.value)}
        onBlur={() => {
          if (timer.current) {
            clearTimeout(timer.current);
            void flush();
          }
        }}
      />
      <p className="ma-ask__hint">{t('notes.hint')}</p>
    </section>
  );
}
