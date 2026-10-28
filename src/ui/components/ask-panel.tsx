/**
 * "Ask about this meeting": a question box, the answers of this session (newest
 * first), each with the transcript lines it rests on — click one to jump there —
 * and "Save to Files", which appends that exact answer to the meeting's qa.md
 * (visible to the whole room, hence an explicit click; asking alone stores nothing).
 */
import { useState, type FormEvent } from 'react';
import { usePrivosApp } from '@privos_ai/app-react';

import type { LiveSummaryLine } from '../data/live-summary-api.js';
import { askMeeting, saveAnswer, type AskResult } from '../data/meeting-qa-api.js';
import { formatClock } from '../data/format-time.js';
import { useI18n } from '../i18n/i18n-provider.js';
import { Icon } from './icon.js';
import { MarkdownText } from './markdown-text.js';

export interface AskPanelProps {
  roomId: string;
  meetingId: string;
  /** While recording: the caption lines so far. Absent after the meeting (the server reads the transcript). */
  getLiveLines?: () => LiveSummaryLine[];
  onSeek?(atSec: number): void;
}

interface Exchange {
  id: number;
  question: string;
  result?: AskResult;
  error?: string;
  save?: 'saving' | 'saved' | 'already' | { error: string };
}

const MAX_QUESTION = 500;

export function AskPanel({ roomId, meetingId, getLiveLines, onSeek }: AskPanelProps) {
  const app = usePrivosApp();
  const { t, language } = useI18n();
  const [question, setQuestion] = useState('');
  const [exchanges, setExchanges] = useState<Exchange[]>([]);
  const [busy, setBusy] = useState(false);

  const update = (id: number, patch: Partial<Exchange>) => setExchanges((prev) => prev.map((e) => (e.id === id ? { ...e, ...patch } : e)));

  async function ask(event: FormEvent): Promise<void> {
    event.preventDefault();
    const q = question.trim();
    if (!q || busy) return;
    const id = Date.now();
    setExchanges((prev) => [{ id, question: q }, ...prev]);
    setQuestion('');
    setBusy(true);
    try {
      const segments = getLiveLines?.();
      if (getLiveLines && (!segments || segments.length === 0)) throw new Error(t('ask.nothingYet'));
      update(id, { result: await askMeeting(app, { roomId, meetingId, question: q, language, segments }) });
    } catch (err) {
      update(id, { error: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  }

  async function save(exchange: Exchange): Promise<void> {
    if (!exchange.result) return;
    const { saveToken, ...answer } = exchange.result;
    update(exchange.id, { save: 'saving' });
    try {
      const out = await saveAnswer(app, { roomId, meetingId, question: exchange.question, answer, saveToken });
      update(exchange.id, { save: out.alreadySaved ? 'already' : 'saved' });
    } catch (err) {
      update(exchange.id, { save: { error: err instanceof Error ? err.message : String(err) } });
    }
  }

  return (
    <section className="ma-ask">
      <form className="ma-ask__form" onSubmit={(e) => void ask(e)}>
        <label className="ma-visually-hidden" htmlFor={`ma-ask-${meetingId}`}>
          {t('ask.label')}
        </label>
        <input
          id={`ma-ask-${meetingId}`}
          className="ma-ask__input"
          value={question}
          maxLength={MAX_QUESTION}
          placeholder={t('ask.placeholder')}
          onChange={(e) => setQuestion(e.target.value)}
        />
        <button type="submit" className="ma-ask__submit" disabled={busy || !question.trim()}>
          {busy ? t('ask.asking') : t('ask.submit')}
        </button>
      </form>
      <p className="ma-ask__hint">{t('ask.hint')}</p>

      {exchanges.length === 0 ? <p className="ma-side-panel__empty">{t('ask.empty')}</p> : null}
      <ul className="ma-ask__list">
        {exchanges.map((exchange) => (
          <li key={exchange.id} className="ma-ask__item">
            <p className="ma-ask__question">{exchange.question}</p>
            {!exchange.result && !exchange.error ? <p className="ma-ask__pending">{t('ask.asking')}</p> : null}
            {exchange.error ? (
              <p className="ma-ask__error" role="alert">
                {exchange.error}
              </p>
            ) : null}
            {exchange.result ? (
              <>
                <MarkdownText source={exchange.result.answer} className={exchange.result.insufficient ? 'ma-ask__answer ma-ask__answer--unknown' : 'ma-ask__answer'} />
                {exchange.result.citations.length > 0 ? (
                  <ul className="ma-ask__citations">
                    {exchange.result.citations.map((c) => (
                      <li key={c.lineId}>
                        <button type="button" className="ma-ask__citation" onClick={() => onSeek?.(c.atSec)} disabled={!onSeek}>
                          <span className="ma-ask__citation-meta">
                            <Icon name="play" size={12} /> {formatClock(c.atSec)} · {c.speaker}
                          </span>
                          <q>{c.quote}</q>
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
                <div className="ma-ask__actions">
                  {exchange.save === 'saved' || exchange.save === 'already' ? (
                    <span className="ma-ask__saved">
                      <Icon name="checkmark" size={12} /> {exchange.save === 'saved' ? t('ask.saved') : t('ask.alreadySaved')}
                    </span>
                  ) : (
                    <button type="button" className="ma-ask__save" disabled={exchange.save === 'saving'} onClick={() => void save(exchange)}>
                      <Icon name="document" size={12} /> {exchange.save === 'saving' ? t('ask.saving') : t('ask.save')}
                    </button>
                  )}
                  {typeof exchange.save === 'object' ? <span className="ma-ask__error">{exchange.save.error}</span> : null}
                </div>
              </>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
