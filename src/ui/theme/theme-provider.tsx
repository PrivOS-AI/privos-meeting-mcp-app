/**
 * Theme sync with the Hub.
 *
 * `usePrivosContext().theme` changes whenever the host switches appearance, so
 * the app follows by flipping one attribute on the document root and letting
 * the token stylesheet do the rest. An explicit in-app override exists so a
 * meeting can be read comfortably regardless of the host's current theme.
 */
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { usePrivosContext } from '@privos_ai/app-react';

export type ThemeMode = 'auto' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

const STORAGE_KEY = 'meeting-agent.theme-mode';

interface ThemeValue {
  mode: ThemeMode;
  setMode(mode: ThemeMode): void;
  /** What is actually rendered once `auto` is resolved against the host. */
  theme: ResolvedTheme;
}

const ThemeContext = createContext<ThemeValue | null>(null);

function readStoredMode(): ThemeMode {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === 'auto' || stored === 'light' || stored === 'dark') return stored;
  } catch {
    // Storage may be unavailable in the sandboxed app document.
  }
  return 'auto';
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const hostContext = usePrivosContext();
  const [mode, setModeState] = useState<ThemeMode>(readStoredMode);

  const theme: ResolvedTheme = mode === 'auto' ? (hostContext.theme === 'dark' ? 'dark' : 'light') : mode;

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const value = useMemo<ThemeValue>(
    () => ({
      mode,
      theme,
      setMode(next: ThemeMode) {
        setModeState(next);
        try {
          window.localStorage.setItem(STORAGE_KEY, next);
        } catch {
          // Best-effort persistence only.
        }
      },
    }),
    [mode, theme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error('useTheme must be used inside a ThemeProvider.');
  return value;
}
