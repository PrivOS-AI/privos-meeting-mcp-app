/**
 * Pulsing REC dot + mm:ss timer. The timer is the RECORDER's clock
 * (`elapsedSec`), never a separate wall clock (D-17).
 */
export interface RecIndicatorProps {
  elapsedSec: number;
  paused: boolean;
}

function formatDuration(totalSec: number): string {
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export function RecIndicator({ elapsedSec, paused }: RecIndicatorProps) {
  return (
    <div className="ma-rec" aria-live="off">
      <span className={`ma-rec__dot${paused ? ' ma-rec__dot--paused' : ''}`} aria-hidden="true" />
      <span className="ma-rec__label">{paused ? 'PAUSE' : 'REC'}</span>
      <span className="ma-rec__time">{formatDuration(elapsedSec)}</span>
    </div>
  );
}
