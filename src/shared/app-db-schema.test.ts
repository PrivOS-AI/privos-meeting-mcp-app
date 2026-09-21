import { describe, expect, it } from 'vitest';

import { COLLECTION_NAMES, SCHEMAS } from './app-db-schema.js';

describe('app-db schema contract', () => {
  it('declares exactly the seven Phase-1 collections', () => {
    expect(COLLECTION_NAMES).toEqual([
      'speaker_profiles',
      'app_settings',
      'meetings',
      'meeting_speakers',
      'action_items',
      'bookmarks',
      'processing_jobs',
    ]);
  });

  it('keeps speaker_profiles and app_settings global (room-less), the rest room-scoped', () => {
    const byName = Object.fromEntries(SCHEMAS.map((s) => [s.collection, s.scope]));
    expect(byName.speaker_profiles).toBe('global');
    expect(byName.app_settings).toBe('global');
    expect(byName.meetings).toBe('room');
    expect(byName.processing_jobs).toBe('room');
  });

  it('uses only the App-DB-supported field types', () => {
    const allowed = new Set(['string', 'number', 'boolean', 'date', 'array', 'reference']);
    for (const schema of SCHEMAS) {
      for (const field of schema.fields) {
        expect(allowed.has(field.type), `${schema.collection}.${field.name}=${field.type}`).toBe(true);
      }
    }
  });

  it('gives app_settings.key and processing_jobs.meetingId a unique index', () => {
    const appSettings = SCHEMAS.find((s) => s.collection === 'app_settings');
    const jobs = SCHEMAS.find((s) => s.collection === 'processing_jobs');
    expect(appSettings?.indexes.some((i) => i.unique && i.fields.key === 1)).toBe(true);
    expect(jobs?.indexes.some((i) => i.unique && i.fields.meetingId === 1)).toBe(true);
  });
});
