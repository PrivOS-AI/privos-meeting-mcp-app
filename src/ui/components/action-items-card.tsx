/**
 * Phase 6 "To-do" panel: the meeting's decisions, then its tasks, requests and
 * open questions — who asked → who does it, the deadline (with its date when
 * known), the words that stated it, a filter by person — checkbox toggle `done`,
 * click a timestamp to seek the (P7) audio player, and "Push to Smart List"
 * (idempotent — `action-list-provisioner.ts` skips items that already carry
 * a `listItemId`). The push button is hidden when the room lacks
 * `lists:write` (manifest `degradedBehavior`).
 */
import { useState } from 'react';
import { usePrivosApp, usePrivosContext } from '@privos_ai/app-react';

import { pushActionItems } from '../data/action-list-provisioner.js';
import { peopleOf, toggleActionItemDone, type ActionItemRecord, type DecisionRecord } from '../data/action-item-read-model.js';
import { formatClock } from '../data/format-time.js';
import { useI18n } from '../i18n/i18n-provider.js';
import { Icon } from './icon.js';

export interface ActionItemsCardProps {
  roomId: string;
  meetingTitle: string;
  items: ActionItemRecord[];
  decisions?: DecisionRecord[];
  onSeek?(atSec: number): void;
  onChanged(): void;
}

export function ActionItemsCard({ roomId, meetingTitle, items, decisions = [], onSeek, onChanged }: ActionItemsCardProps) {
  const app = usePrivosApp();
  const { effectiveScopes } = usePrivosContext();
  const { t, language } = useI18n();
  const [person, setPerson] = useState<string | null>(null);
  const people = peopleOf(items);
  const shown = person ? items.filter((item) => item.owner === person || item.requester === person) : items;
  const [pushing, setPushing] = useState(false);
  const [pushResult, setPushResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // `effectiveScopes` is undefined on hosts that do not report it yet — degrade to "show the button" rather than
  // hide a working feature; a genuinely missing scope still surfaces as a thrown error from `pushActionItems`.
  const canPush = !effectiveScopes || effectiveScopes.includes('lists:write');

  async function toggle(item: ActionItemRecord): Promise<void> {
    setError(null);
    try {
      await toggleActionItemDone(app, item.id, !item.done);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function push(): Promise<void> {
    setPushing(true);
    setError(null);
    setPushResult(null);
    try {
      const result = await pushActionItems(app, roomId, meetingTitle, items);
      setPushResult(t('actionItems.pushResult', { pushed: result.pushed, skipped: result.skipped }));
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPushing(false);
    }
  }

  return (
    <section className="ma-action-items-card">
      <header className="ma-action-items-card__header">
        <h3 className="ma-action-items-card__title">
          <Icon name="checkmark-circle" size={16} /> {t('actionItems.title')}
        </h3>
        {canPush ? (
          <button type="button" onClick={() => void push()} disabled={pushing || items.length === 0} className="ma-action-items-card__push">
            {pushing ? t('actionItems.pushing') : t('actionItems.push')}
          </button>
        ) : null}
      </header>

      {error ? (
        <p className="ma-action-items-card__error" role="alert">
          {error}
        </p>
      ) : null}
      {pushResult ? <p className="ma-action-items-card__result">{pushResult}</p> : null}

      {decisions.length > 0 ? (
        <div className="ma-action-items-card__decisions">
          <h4 className="ma-action-items-card__subtitle">{t('actionItems.decisions')}</h4>
          <ul>
            {decisions.map((decision) => (
              <li key={decision.id}>
                <span>{decision.text}</span>
                {decision.by || decision.atSec !== null ? (
                  <span className="ma-action-items-card__meta">
                    {decision.by ? <span>{t('actionItems.decidedBy', { name: decision.by })}</span> : null}
                    {decision.atSec !== null && onSeek ? <SeekButton atSec={decision.atSec} onSeek={onSeek} /> : null}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {people.length > 1 ? (
        <div className="ma-action-items-card__people" role="group" aria-label={t('actionItems.filterByPerson')}>
          <button type="button" aria-pressed={person === null} onClick={() => setPerson(null)}>
            {t('actionItems.everyone')}
          </button>
          {people.map((name) => (
            <button key={name} type="button" aria-pressed={person === name} onClick={() => setPerson(person === name ? null : name)}>
              {name}
            </button>
          ))}
        </div>
      ) : null}

      {items.length === 0 ? (
        <p className="ma-action-items-card__empty">{t('actionItems.empty')}</p>
      ) : (
        <ul className="ma-action-items-card__list">
          {shown.map((item) => (
            <li key={item.id} className="ma-action-items-card__row">
              <button
                type="button"
                className="ma-action-items-card__checkbox"
                onClick={() => void toggle(item)}
                aria-pressed={item.done}
                aria-label={item.done ? t('actionItems.markUndone') : t('actionItems.markDone')}
              >
                <Icon name={item.done ? 'checkbox-checked' : 'checkbox-unchecked'} size={16} />
              </button>
              <div className="ma-action-items-card__body">
                <span className={item.done ? 'ma-action-items-card__task ma-action-items-card__task--done' : 'ma-action-items-card__task'}>
                  {item.type !== 'task' ? <span className={`ma-action-items-card__type ma-action-items-card__type--${item.type}`}>{t(`actionItems.type.${item.type}`)}</span> : null}
                  {item.task}
                </span>
                {item.requester || item.owner ? (
                  <span className="ma-action-items-card__people-line">
                    {/* A lone name reads as the owner; a lone requester says so. */}
                    {item.requester && !item.owner ? <span>{t('actionItems.requester')}:</span> : null}
                    {item.requester ? <Person name={item.requester} linked={Boolean(item.requesterUserId)} title={t('actionItems.requester')} /> : null}
                    {item.requester && item.owner ? <span aria-hidden="true">→</span> : null}
                    {item.owner ? <Person name={item.owner} linked={Boolean(item.ownerUserId)} title={t('actionItems.owner')} /> : null}
                  </span>
                ) : null}
                {item.quote ? <q className="ma-action-items-card__quote">{item.quote}</q> : null}
                <div className="ma-action-items-card__meta">
                  {item.due ? (
                    <span>
                      <Icon name="calendar" size={12} /> {formatDue(item.due, item.dueDate, language)}
                    </span>
                  ) : null}
                  {item.atSec !== null && onSeek ? <SeekButton atSec={item.atSec} onSeek={onSeek} /> : null}
                  {item.listItemId ? (
                    <span className="ma-action-items-card__pushed">
                      <Icon name="checkmark" size={12} /> {t('actionItems.pushed')}
                    </span>
                  ) : null}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function SeekButton({ atSec, onSeek }: { atSec: number; onSeek(atSec: number): void }) {
  return (
    <button type="button" className="ma-action-items-card__at" onClick={() => onSeek(atSec)}>
      <Icon name="play" size={12} /> {formatClock(atSec)}
    </button>
  );
}

/** A name; marked when it is linked to a PrivOS account (through that speaker's voiceprint). */
function Person({ name, linked, title }: { name: string; linked: boolean; title: string }) {
  return (
    <span className={linked ? 'ma-action-items-card__person ma-action-items-card__person--linked' : 'ma-action-items-card__person'} title={title}>
      {linked ? <Icon name="person-multiple" size={12} /> : null}
      {name}
    </span>
  );
}

/** "thứ Năm (24 thg 10)" — the deadline as said, plus its date when one was worked out and differs. */
function formatDue(due: string, dueDate: string | null, language: string): string {
  if (!dueDate) return due;
  const date = new Date(`${dueDate}T00:00:00`);
  const formatted = Number.isNaN(date.getTime()) ? dueDate : date.toLocaleDateString(language, { day: 'numeric', month: 'short' });
  return due === dueDate ? formatted : `${due} (${formatted})`;
}
