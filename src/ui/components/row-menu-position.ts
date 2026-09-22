/**
 * Pure viewport math for the history row "⋯" dropdown (see
 * `meeting-row-menu.tsx`). Kept free of React/DOM so it can be unit-tested in
 * the node vitest environment.
 *
 * Invariant: the returned position ALWAYS carries both `top` and `bottom`,
 * exactly one numeric and the other `'auto'`. The list is portaled to body at
 * `position:fixed`; if the unused side were left unset, a stale stylesheet
 * rule (e.g. `top:100%`) could leak through and push the menu off-screen.
 */
export interface AnchorRect {
  top: number;
  bottom: number;
  right: number;
}

export interface ViewportSize {
  width: number;
  height: number;
}

export interface RowMenuPosition {
  top: number | 'auto';
  bottom: number | 'auto';
  right: number;
  /** True when the list is anchored above the trigger. */
  opensUpward: boolean;
}

export interface RowMenuPositionOptions {
  /** Gap in px between the trigger edge and the list. */
  gap: number;
  /** Estimated max list height; below this much free space the list flips up. */
  maxHeight: number;
}

export function computeRowMenuPosition(anchor: AnchorRect, viewport: ViewportSize, { gap, maxHeight }: RowMenuPositionOptions): RowMenuPosition {
  // Right-align the list to the trigger's right edge, in viewport coordinates.
  const right = viewport.width - anchor.right;
  const spaceBelow = viewport.height - anchor.bottom - gap;

  if (spaceBelow < maxHeight) {
    // Not enough room below: anchor the list's bottom edge just above the
    // trigger so it grows upward. `bottom` is measured from the viewport
    // bottom, so it is never negative for a trigger inside the viewport.
    return { top: 'auto', bottom: viewport.height - anchor.top + gap, right, opensUpward: true };
  }
  return { top: anchor.bottom + gap, bottom: 'auto', right, opensUpward: false };
}
