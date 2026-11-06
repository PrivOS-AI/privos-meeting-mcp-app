/**
 * Shown while a Room-browser recording cannot hear the browser: none running
 * in the Room yet, no sound output, another listener, or Remote Browser
 * unreachable. The server keeps retrying; the notice goes away once it hears it.
 * Once the server stopped the recording by itself (`endReason`: the longest
 * allowed time, a long silence, the browser not reached), it says so instead:
 * the meeting is already being processed.
 */
import type { BrowserAudioEndReason, BrowserAudioProblem } from '../data/browser-audio-client.js';
import { useI18n } from '../i18n/i18n-provider.js';
import { Icon } from './icon.js';

export function BrowserAudioNotice({ problem, endReason, title }: { problem?: BrowserAudioProblem; endReason?: BrowserAudioEndReason; title?: string }) {
  const { t } = useI18n();
  if (endReason) {
    return (
      <div className="ma-notice ma-notice--warning" role="status">
        <Icon name="globe" size={16} />
        <span>
          {t(`recovery.browser.ended.${endReason}`, { title: title || t('screen.new.untitled') })} {t('recovery.browser.ended.processing')}
        </span>
      </div>
    );
  }
  if (!problem) return null;
  return (
    <div className="ma-notice ma-notice--warning" role="status">
      <Icon name="globe" size={16} />
      <span>{t(`recording.browser.${problem}`)}</span>
    </div>
  );
}
