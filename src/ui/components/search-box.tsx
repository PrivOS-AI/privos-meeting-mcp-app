/**
 * Shared search input with a ⌘K/Ctrl+K focus shortcut (phase-07 §
 * Implementation Steps 4: "search box (⌘K focus)"). Used by both the history
 * screen (meeting search) and the meeting detail screen (transcript search).
 */
import { useEffect, useRef } from 'react';

import { useI18n } from '../i18n/i18n-provider.js';
import { Icon } from './icon.js';

export interface SearchBoxProps {
  value: string;
  onChange(value: string): void;
  placeholder?: string;
}

export function SearchBox({ value, onChange, placeholder }: SearchBoxProps) {
  const { t } = useI18n();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        inputRef.current?.focus();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <div className="ma-search-box">
      <Icon name="search" size={16} />
      <input
        ref={inputRef}
        type="search"
        className="ma-search-box__input"
        value={value}
        placeholder={placeholder ?? t('search.placeholder')}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}
