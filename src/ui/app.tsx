/**
 * App shell: fixed rail + top bar around whichever screen is active.
 *
 * This is the Phase 1 UI scaffold only — no recording/AI logic. The one piece
 * of backend wiring here is `meeting_bootstrap`, fired once per mount so the
 * room's App DB schema and bot membership are ready before later phases add
 * real screens; its result/failure never blocks the shell from rendering.
 */
import { useEffect, useRef, useState } from 'react';
import { parseToolResult, usePrivosApp, usePrivosContext } from '@privos_ai/app-react';

import { AppRail } from './components/app-rail.js';
import { BotCredentialBanner } from './components/bot-credential-banner.js';
import { TopBar } from './components/top-bar.js';
import { useI18n } from './i18n/i18n-provider.js';
import { HistoryScreen } from './screens/history-screen.js';
import { LiveScreen } from './screens/live-screen.js';
import { MeetingDetailScreen } from './screens/meeting-detail-screen.js';
import { NewMeetingScreen } from './screens/new-meeting-screen.js';
import { ProcessingScreen } from './screens/processing-screen.js';
import { RecoveryBanner } from './screens/recovery-banner.js';
import { SettingsScreen } from './screens/settings-screen.js';
import { RecordingStoreProvider } from './stores/recording-store.js';

export type Route = 'new' | 'live' | 'processing' | 'detail' | 'history' | 'settings';

const TITLE_KEY_BY_ROUTE: Record<Route, string> = {
  new: 'screen.new.title',
  live: 'screen.live.title',
  processing: 'processing.title',
  detail: 'screen.detail.title',
  history: 'screen.history.title',
  settings: 'screen.settings.title',
};

export function App() {
  const { t } = useI18n();
  const app = usePrivosApp();
  const context = usePrivosContext();
  const [route, setRoute] = useState<Route>('new');

  // Bootstrap runs once per mount, guarded by a ref rather than an effect
  // dependency array: `roomId` can change identity across re-renders while the
  // room itself has not, and re-running the tool per render would be wasteful
  // (it is idempotent server-side, but still a network round trip).
  const bootstrapped = useRef(false);
  useEffect(() => {
    if (bootstrapped.current) return;
    if (!context.roomId) return;
    bootstrapped.current = true;
    app
      .callServerTool({ name: 'meeting_bootstrap', arguments: { roomId: context.roomId } })
      .then((raw) => parseToolResult(raw))
      .catch((error: unknown) => {
        // Bootstrap failure must not block the shell from rendering; later
        // phases that depend on it will surface their own errors.
        console.error('meeting_bootstrap failed', error);
      });
  }, [app, context.roomId]);

  return (
    <RecordingStoreProvider>
      <div className="ma-app">
        <AppRail current={route} onNavigate={setRoute} />
        <div className="ma-app__column">
          <TopBar title={t(TITLE_KEY_BY_ROUTE[route])} />
          <BotCredentialBanner />
          <RecoveryBanner />
          <main className={route === 'live' ? 'ma-body ma-body--live' : 'ma-body'}>
            {route === 'new' ? <NewMeetingScreen onStarted={() => setRoute('live')} /> : null}
            {route === 'live' ? <LiveScreen onEnded={() => setRoute('processing')} /> : null}
            {route === 'processing' ? <ProcessingScreen onDone={() => setRoute('history')} /> : null}
            {route === 'detail' ? <MeetingDetailScreen /> : null}
            {route === 'history' ? <HistoryScreen /> : null}
            {route === 'settings' ? <SettingsScreen /> : null}
          </main>
        </div>
      </div>
    </RecordingStoreProvider>
  );
}
