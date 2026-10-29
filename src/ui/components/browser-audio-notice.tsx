/**
 * Shown while a Room-browser recording cannot hear the browser: none running
 * in the Room yet, no sound output, another listener, or Remote Browser
 * unreachable. The server keeps retrying; the notice goes away once it hears it.
 */
import type { BrowserAudioProblem } from '../data/browser-audio-client.js';
import { useI18n } from '../i18n/i18n-provider.js';
import { Icon } from './icon.js';

export function BrowserAudioNotice({ problem }: { problem: BrowserAudioProblem }) {
  const { t } = useI18n();
  return (
    <div className="ma-notice ma-notice--warning" role="status">
      <Icon name="globe" size={16} />
      <span>{t(`recording.browser.${problem}`)}</span>
    </div>
  );
}
