/**
 * Type-to-filter room member search for `speaker_resolve`'s `mode:'user'`
 * (plan.md § UI: `member-picker.tsx`). Debounces 250ms before calling
 * `channels.members` (`room-members.ts` already enforces an 8s timeout);
 * degrades to free-text entry when the search fails (missing `rooms:read`
 * grant, or outside a room) — matches the manifest's documented
 * `degradedBehavior` for that scope.
 */
import { useEffect, useState } from 'react';
import { usePrivosApp, usePrivosContext } from '@privos_ai/app-react';

import { searchRoomMembers, type RoomMember } from '../data/room-members.js';
import { useI18n } from '../i18n/i18n-provider.js';

export interface MemberPickerProps {
  onSelect(member: RoomMember): void;
  selectedLabel?: string;
}

const DEBOUNCE_MS = 250;

export function MemberPicker({ onSelect, selectedLabel }: MemberPickerProps) {
  const app = usePrivosApp();
  const { roomId } = usePrivosContext();
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<RoomMember[]>([]);
  const [degraded, setDegraded] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (degraded || !roomId || query.trim().length === 0) {
      setResults([]);
      return undefined;
    }
    let cancelled = false;
    setLoading(true);
    const timer = setTimeout(() => {
      searchRoomMembers(app, roomId, query, 8)
        .then((members) => {
          if (!cancelled) setResults(members);
        })
        .catch(() => {
          if (!cancelled) setDegraded(true);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [app, roomId, query, degraded]);

  if (degraded || !roomId) {
    return (
      <div className="ma-member-picker ma-member-picker--degraded">
        <input
          className="ma-member-picker__input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('speaker.memberPicker.degradedPlaceholder')}
        />
        <button type="button" className="ma-member-picker__confirm" disabled={!query.trim()} onClick={() => onSelect({ id: query.trim(), username: '', name: query.trim() })}>
          {t('speaker.memberPicker.useTyped')}
        </button>
        <p className="ma-member-picker__hint">{t('speaker.memberPicker.degradedHint')}</p>
      </div>
    );
  }

  return (
    <div className="ma-member-picker">
      <input
        className="ma-member-picker__input"
        value={selectedLabel ?? query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t('speaker.memberPicker.placeholder')}
      />
      {loading ? <p className="ma-member-picker__hint">{t('speaker.memberPicker.searching')}</p> : null}
      {results.length > 0 ? (
        <ul className="ma-member-picker__list">
          {results.map((m) => (
            <li key={m.id}>
              <button
                type="button"
                onClick={() => {
                  onSelect(m);
                  setQuery('');
                  setResults([]);
                }}
              >
                {m.name}
                {m.username ? ` (@${m.username})` : ''}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
