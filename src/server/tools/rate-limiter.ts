/**
 * In-process sliding-window rate limiter keyed by `feature:key`. Sufficient for
 * a single pm2 instance (this app never runs more than one replica); a
 * distributed limiter is out of scope. Used by `meeting_realtime_token`
 * (30/hour per user+meeting) and `meeting_translate` (per meeting).
 */
const hits = new Map<string, number[]>();

/**
 * Record one attempt for `feature:key` and report whether it is within
 * `limit` occurrences in the trailing `windowMs`. Mutates the bucket only on
 * success so a caller that is rejected can retry once the window rolls off.
 */
export function checkRateLimit(feature: string, key: string, limit: number, windowMs: number): boolean {
  const bucketKey = `${feature}:${key}`;
  const now = Date.now();
  const cutoff = now - windowMs;
  const recent = (hits.get(bucketKey) ?? []).filter((t) => t > cutoff);
  if (recent.length >= limit) {
    hits.set(bucketKey, recent);
    return false;
  }
  recent.push(now);
  hits.set(bucketKey, recent);
  return true;
}

/** Test-only: drop every tracked bucket so suites do not leak state. */
export function resetRateLimits(): void {
  hits.clear();
}
