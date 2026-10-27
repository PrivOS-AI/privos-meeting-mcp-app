import type { MeetingSpeakerSummary } from './meeting-read-model.js';

/**
 * Replaces the raw id of a speaker nobody has named yet (`speaker_2`) with a readable
 * "Speaker 3". The number comes from the id itself so it stays the same across screens
 * and reloads; an id without a trailing number falls back to its position in the list.
 */
export function labelUnnamedSpeakers(speakers: readonly MeetingSpeakerSummary[], numbered: (n: number) => string): MeetingSpeakerSummary[] {
  return speakers.map((speaker, index) => {
    if (speaker.named) return speaker;
    const match = /(\d+)$/.exec(speaker.speakerId);
    return { ...speaker, displayName: numbered(match ? Number(match[1]) + 1 : index + 1) };
  });
}
