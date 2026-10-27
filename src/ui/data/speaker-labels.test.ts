import { describe, expect, it } from 'vitest';

import { labelUnnamedSpeakers } from './speaker-labels.js';

const numbered = (n: number) => `Speaker ${n}`;

describe('labelUnnamedSpeakers', () => {
  it('numbers unnamed speakers from their id and keeps saved names', () => {
    const labelled = labelUnnamedSpeakers(
      [
        { speakerId: 'speaker_0', displayName: 'Ngân', named: true, colorKey: 'blue' },
        { speakerId: 'speaker_2', displayName: 'speaker_2', named: false, colorKey: 'gold' },
        { speakerId: 'guest', displayName: 'guest', named: false, colorKey: 'teal' },
      ],
      numbered,
    );
    expect(labelled.map((s) => s.displayName)).toEqual(['Ngân', 'Speaker 3', 'Speaker 3']);
  });
});
