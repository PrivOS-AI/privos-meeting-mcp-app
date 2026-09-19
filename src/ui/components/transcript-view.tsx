/**
 * Simple fixed-row-height virtualization (phase-07 risk table: "Favor
 * simplicity: measure a fixed height from the estimated line count" — no windowing
 * library). Renders only the segments whose estimated slot intersects the
 * visible scroll range (+ buffer rows); top/bottom spacer `div`s keep the
 * native scrollbar's size and position correct without measuring real DOM
 * heights.
 */
import { useEffect, useMemo, useRef, useState } from 'react';

import { TranscriptLine, type TranscriptLineData } from './transcript-line.js';

const ROW_HEIGHT_PX = 76;
const BUFFER_ROWS = 10;

export interface TranscriptViewProps {
  segments: TranscriptLineData[];
  displayNameBySpeaker: Record<string, string>;
  colorKeyBySpeaker: Record<string, string>;
  activeSegmentId?: string;
  showTranslation: boolean;
  highlightQuery?: string;
  autoScroll: boolean;
  speakerFilter?: ReadonlySet<string>;
  onSeek(sec: number): void;
}

export function TranscriptView({
  segments,
  displayNameBySpeaker,
  colorKeyBySpeaker,
  activeSegmentId,
  showTranslation,
  highlightQuery,
  autoScroll,
  speakerFilter,
  onSeek,
}: TranscriptViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(600);

  const filtered = useMemo(
    () => (speakerFilter && speakerFilter.size > 0 ? segments.filter((segment) => speakerFilter.has(segment.speakerId)) : segments),
    [segments, speakerFilter],
  );

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return undefined;
    function onScroll(): void {
      setScrollTop(el!.scrollTop);
    }
    setViewportHeight(el.clientHeight);
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    if (!autoScroll || !activeSegmentId) return;
    const index = filtered.findIndex((segment) => segment.id === activeSegmentId);
    if (index === -1) return;
    const el = containerRef.current;
    if (!el) return;
    const targetTop = index * ROW_HEIGHT_PX;
    if (targetTop < el.scrollTop || targetTop > el.scrollTop + el.clientHeight - ROW_HEIGHT_PX) {
      el.scrollTo({ top: Math.max(0, targetTop - el.clientHeight / 2), behavior: 'smooth' });
    }
  }, [activeSegmentId, autoScroll, filtered]);

  const startIndex = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT_PX) - BUFFER_ROWS);
  const endIndex = Math.min(filtered.length, Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT_PX) + BUFFER_ROWS);
  const visible = filtered.slice(startIndex, endIndex);

  return (
    <div className="ma-transcript-view" ref={containerRef}>
      <div style={{ height: startIndex * ROW_HEIGHT_PX }} />
      {visible.map((segment) => (
        <TranscriptLine
          key={segment.id}
          segment={segment}
          speakerName={displayNameBySpeaker[segment.speakerId] ?? segment.speakerId}
          colorKey={colorKeyBySpeaker[segment.speakerId] ?? 'blue'}
          active={segment.id === activeSegmentId}
          showTranslation={showTranslation}
          highlightQuery={highlightQuery}
          onSeek={onSeek}
        />
      ))}
      <div style={{ height: Math.max(0, (filtered.length - endIndex) * ROW_HEIGHT_PX) }} />
    </div>
  );
}
