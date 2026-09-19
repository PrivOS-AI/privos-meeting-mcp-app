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
import { Icon } from './components/icon.js';
import { HistoryScreen } from './screens/history-screen.js';
import { LiveScreen } from './screens/live-screen.js';
import { MeetingDetailScreen } from './screens/meeting-detail-screen.js';
import { NewMeetingScreen } from './screens/new-meeting-screen.js';
import { ProcessingScreen } from './screens/processing-screen.js';
import { RecoveryBanner } from './screens/recovery-banner.js';
import { SettingsScreen } from './screens/settings-screen.js';
import { useI18n } from './i18n/i18n-provider.js';
import { RecordingStoreProvider, useRecordingState } from './stores/recording-store.js';

export type Route = 'new' | 'live' | 'processing' | 'detail' | 'history' | 'settings';

export function App() {
  const app = usePrivosApp();
  const context = usePrivosContext();
  const { t } = useI18n();
  const [route, setRoute] = useState<Route>('new');
  // Mobile-only: the rail is an off-canvas drawer toggled by the hamburger below.
  const [railOpen, setRailOpen] = useState(false);
  // History → detail navigation carries the picked meeting id; owned here (not in RecordingStore) since it has
  // nothing to do with the in-progress recording state machine (phase-07 § Related Code Files: `app.tsx` route `detail/:meetingId`).
  const [selectedMeetingId, setSelectedMeetingId] = useState<string | null>(null);

  function openMeeting(meetingId: string): void {
    setSelectedMeetingId(meetingId);
    setRoute('detail');
  }

  // Bootstrap runs once per mount, guarded by a ref rather than an effect
  // dependency array: `roomId` can change identity across re-renders while the
  // room itself has not, and re-running the tool per render would be wasteful
  // (it is idempotent server-side, but still a network round trip).
  const bootstrapped = useRef(false);
  useEffect(() => {
    if (bootstrapped.current) return;
    if (!context.roomId) return;
    bootstrapped.current = true;
    // The Hub gates every room-scoped call the installation bot makes on the
    // bot being a MEMBER of that room (a non-member resolves to an empty ACL,
    // i.e. "Insufficient scope" for db:*/files:*), and only a user-execution
    // call may add it (`bot:room:join` is user-only). So join from here, as
    // the current room member, BEFORE the backend bootstrap that runs as the
    // bot. Idempotent; a refusal must not block the bootstrap attempt.
    app
      .callServerTool({ name: 'mcpapp.bot.joinCurrentRoom', arguments: {} })
      .catch((error: unknown) => console.warn('mcpapp.bot.joinCurrentRoom failed', error))
      .then(() => app.callServerTool({ name: 'meeting_bootstrap', arguments: { roomId: context.roomId } }))
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
        <button
          type="button"
          className="ma-rail-toggle"
          aria-label={t(railOpen ? 'rail.close' : 'rail.open')}
          aria-expanded={railOpen}
          onClick={() => setRailOpen((v) => !v)}
        >
          <Icon name={railOpen ? 'close' : 'menu'} size={22} />
        </button>
        <AppRail current={route} onNavigate={setRoute} open={railOpen} onClose={() => setRailOpen(false)} />
        <div className="ma-app__column">
          <BotCredentialBanner />
          <RecoveryBanner />
          <main className={route === 'live' ? 'ma-body ma-body--live' : 'ma-body'}>
            <RoutedScreens route={route} setRoute={setRoute} selectedMeetingId={selectedMeetingId} openMeeting={openMeeting} />
          </main>
        </div>
      </div>
    </RecordingStoreProvider>
  );
}

interface RoutedScreensProps {
  route: Route;
  setRoute(route: Route): void;
  selectedMeetingId: string | null;
  openMeeting(meetingId: string): void;
}

/** Inside the store provider so it can see whether a recording is running. */
function RoutedScreens({ route, setRoute, selectedMeetingId, openMeeting }: RoutedScreensProps) {
  const recording = useRecordingState();
  const recordingActive = recording.status === 'recording' || recording.status === 'paused' || recording.status === 'ending';
  // Keep a running meeting alive in the background: navigating away and back to
  // "New meeting" returns to the live session instead of a fresh start form.
  const showLive = route === 'live' || (route === 'new' && recordingActive);
  return (
    <>
      {route === 'new' && !recordingActive ? <NewMeetingScreen onStarted={() => setRoute('live')} /> : null}
      {showLive ? <LiveScreen onEnded={() => setRoute('processing')} /> : null}
      {route === 'processing' ? <ProcessingScreen onDone={() => setRoute('history')} onOpenMeeting={openMeeting} /> : null}
      {route === 'detail' && selectedMeetingId ? <MeetingDetailScreen meetingId={selectedMeetingId} onBack={() => setRoute('history')} /> : null}
      {route === 'history' ? <HistoryScreen onStartRecording={() => setRoute('new')} onOpenMeeting={openMeeting} /> : null}
      {route === 'settings' ? <SettingsScreen /> : null}
    </>
  );
}
