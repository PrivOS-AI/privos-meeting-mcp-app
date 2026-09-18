/**
 * Phase 6 "Việc cần làm" panel: checkbox toggle `done`, owner/due display,
 * click a timestamp to seek the (P7) audio player, and "Push to Smart List"
 * (idempotent — `action-list-provisioner.ts` skips items that already carry
 * a `listItemId`). The push button is hidden when the room lacks
 * `lists:write` (manifest `degradedBehavior`).
 */
import { useState } from 'react';
import { usePrivosApp, usePrivosContext } from '@privos_ai/app-react';

import { pushActionItems } from '../data/action-list-provisioner.js';
import { toggleActionItemDone, type ActionItemRecord } from '../data/action-item-read-model.js';
import { formatClock } from '../data/format-time.js';
import { useI18n } from '../i18n/i18n-provider.js';
import { Icon } from './icon.js';

export interface ActionItemsCardProps {
  roomId: string;
  meetingTitle: string;
  items: ActionItemRecord[];
  onSeek?(atSec: number): void;
  onChanged(): void;
}

export function ActionItemsCard({ roomId, meetingTitle, items, onSeek, onChanged }: ActionItemsCardProps) {
  const app = usePrivosApp();
  const { effectiveScopes } = usePrivosContext();
  const { t } = useI18n();
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

      {items.length === 0 ? (
        <p className="ma-action-items-card__empty">{t('actionItems.empty')}</p>
      ) : (
        <ul className="ma-action-items-card__list">
          {items.map((item) => (
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
                <span className={item.done ? 'ma-action-items-card__task ma-action-items-card__task--done' : 'ma-action-items-card__task'}>{item.task}</span>
                <div className="ma-action-items-card__meta">
                  {item.owner ? <span>{item.owner}</span> : null}
                  {item.due ? <span>{item.due}</span> : null}
                  {item.atSec !== null && onSeek ? (
                    <button type="button" className="ma-action-items-card__at" onClick={() => onSeek(item.atSec as number)}>
                      <Icon name="play" size={12} /> {formatClock(item.atSec)}
                    </button>
                  ) : null}
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
