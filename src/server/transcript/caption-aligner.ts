/**
 * Max-overlap alignment between two sets of time spans (D-17). Built for P3's
 * reconcile hook — mapping the async pass's segments against P5's
 * `live-turns.json` — but generic enough for P5 to reuse verbatim for its own
 * in-session matching.
 */
export interface TimeSpan {
  startMs: number;
  endMs: number;
}

export interface AlignOptions {
  /** Edges may miss by up to this much and still count as overlapping. */
  toleranceMs?: number;
  /** Added to every `b` span's timestamps before comparing (resyncs clock drift, D-17). */
  skewMs?: number;
}

export interface AlignResult<A extends TimeSpan, B extends TimeSpan> {
  a: A;
  b: B | undefined;
}

const DEFAULT_TOLERANCE_MS = 1500;

/**
 * For each span of `a`, picks the span of `b` with the largest overlapping
 * duration (after compensating `b` by `skewMs`), allowing edges to miss by up
 * to `toleranceMs`. A tie is won by the LONGER `b` span. No span of `b`
 * overlaps within tolerance → `b` is `undefined` for that entry.
 */
export function alignByMaxOverlap<A extends TimeSpan, B extends TimeSpan>(
  a: readonly A[],
  b: readonly B[],
  options: AlignOptions = {},
): Array<AlignResult<A, B>> {
  const toleranceMs = options.toleranceMs ?? DEFAULT_TOLERANCE_MS;
  const skewMs = options.skewMs ?? 0;
  const shiftedB = b.map((span) => ({ span, startMs: span.startMs + skewMs, endMs: span.endMs + skewMs }));

  return a.map((spanA) => {
    let best: { span: B; overlap: number; duration: number } | undefined;
    for (const { span, startMs, endMs } of shiftedB) {
      const overlapStart = Math.max(spanA.startMs - toleranceMs, startMs);
      const overlapEnd = Math.min(spanA.endMs + toleranceMs, endMs);
      const overlap = overlapEnd - overlapStart;
      if (overlap <= 0) continue;
      const duration = endMs - startMs;
      if (!best || overlap > best.overlap || (overlap === best.overlap && duration > best.duration)) {
        best = { span, overlap, duration };
      }
    }
    return { a: spanA, b: best?.span };
  });
}
