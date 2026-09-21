/**
 * mm:ss / h:mm:ss formatting shared by the audio player, transcript lines,
 * action items and history table durations — the one place this app turns a
 * second count into a clock string, so every screen agrees on the format.
 */

/** `m:ss` under an hour, `h:mm:ss` at/above one hour. Negative/NaN input clamps to 0. */
export function formatClock(totalSec: number): string {
  const sec = Number.isFinite(totalSec) ? Math.max(0, Math.round(totalSec)) : 0;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Compact duration for stat cards / table cells, e.g. "2h 15m" / "45m" / "30s". */
export function formatDurationLong(totalSec: number): string {
  const sec = Number.isFinite(totalSec) ? Math.max(0, Math.round(totalSec)) : 0;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${sec}s`;
}
