import { describe, expect, it } from 'vitest';

import { MeetingClock } from './meeting-clock.js';
import type { LiveTurn } from './realtime-client.js';

function turn(id: string, speakerKey: string, startMs: number, endMs: number, final: boolean): LiveTurn {
  return { id, speakerKey, startMs, endMs, text: 'x', final };
}

describe('MeetingClock', () => {
  it('maps two sessions with different offsets to the same meeting timeline', () => {
    const clock = new MeetingClock(1_000);
    clock.registerSessionStart(0, 1_500); // offset 500ms
    clock.registerSessionStart(1, 10_000); // offset 9000ms (session 1 started later, e.g. after a reconnect)

    expect(clock.toMeetingMs(0, 2_000)).toBe(2_500);
    expect(clock.toMeetingMs(1, 2_000)).toBe(11_000);
  });

  it('flags a part approxClock when the resync skew exceeds 1.5s', () => {
    const clock = new MeetingClock(0);
    clock.registerSessionStart(0, 0); // offset 0

    const small = clock.resyncOnPartClose(0, 60_000, 59_800);
    expect(small.approxClock).toBe(false);
    expect(small.skewMs).toBe(200);

    const big = clock.resyncOnPartClose(0, 120_000, 116_000);
    expect(big.approxClock).toBe(true);
    expect(big.skewMs).toBe(4_000);
  });

  it('applies the latest resynced skew to subsequent conversions', () => {
    const clock = new MeetingClock(0);
    clock.registerSessionStart(0, 0);
    clock.resyncOnPartClose(0, 60_000, 58_000); // skew = 2000
    expect(clock.toMeetingMs(0, 1_000)).toBe(3_000);
  });

  it('serializes recorderEpochMs + sessions for sttSessionMeta', () => {
    const clock = new MeetingClock(42);
    clock.registerSessionStart(0, 42);
    clock.registerSessionStart(1, 5_042);
    const meta = clock.toSttSessionMeta();
    expect(meta.recorderEpochMs).toBe(42);
    expect(meta.sessions.map((s) => s.index)).toEqual([0, 1]);
  });

  describe('turnsInPart', () => {
    it('selects turns that started inside the part window', () => {
      const clock = new MeetingClock(0);
      const turns = [turn('t1', 's0:1', 0, 20_000, true), turn('t2', 's0:2', 70_000, 90_000, true)];
      const selected = clock.turnsInPart(turns, { seq: 0, startMs: 0, endMs: 60_000 });
      expect(selected.map((t) => t.id)).toEqual(['t1']);
    });

    it('resends a not-yet-final turn that spans a part boundary, without truncating it', () => {
      const clock = new MeetingClock(0);
      let turns = [turn('t1', 's0:1', 55_000, 61_000, false)];
      const part0 = clock.turnsInPart(turns, { seq: 0, startMs: 0, endMs: 60_000 });
      expect(part0.map((t) => t.id)).toEqual(['t1']);

      // By part 1 the turn has grown and finalized, but still "started" in part 0's window.
      turns = [turn('t1', 's0:1', 55_000, 63_000, true)];
      const part1 = clock.turnsInPart(turns, { seq: 1, startMs: 60_000, endMs: 120_000 });
      expect(part1.map((t) => t.id)).toEqual(['t1']);
      expect(part1[0].text).toBe('x');
    });

    it('never resends a turn once its final form has been returned once', () => {
      const clock = new MeetingClock(0);
      const finalTurn = [turn('t1', 's0:1', 10_000, 20_000, true)];
      const part0 = clock.turnsInPart(finalTurn, { seq: 0, startMs: 0, endMs: 60_000 });
      expect(part0.map((t) => t.id)).toEqual(['t1']);

      const part1 = clock.turnsInPart(finalTurn, { seq: 1, startMs: 60_000, endMs: 120_000 });
      expect(part1).toEqual([]);
    });
  });

  it('measuredPartMs advances from the last boundary each call', () => {
    const clock = new MeetingClock(0);
    expect(clock.measuredPartMs(60_000)).toBe(60_000);
    expect(clock.measuredPartMs(125_000)).toBe(65_000);
  });
});
