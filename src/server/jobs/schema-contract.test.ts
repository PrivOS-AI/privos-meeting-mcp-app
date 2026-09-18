import { describe, expect, it } from 'vitest';

import { SCHEMAS } from '../../shared/app-db-schema.js';

/**
 * Every field `job-repository.ts` actually reads/writes on the `processing_jobs`
 * row (see `fromRow`/`claim`/`patch`/`finish`/`fail`). Kept as a flat list here,
 * independent of the `JobRecord` TS type, so this test breaks the moment either
 * side drifts from the other — the exact failure mode plan.md's contract test
 * exists to catch ("ghi/lọc trường chưa đăng ký").
 */
const JOB_RECORD_DB_FIELDS = [
  'meetingId',
  'roomId',
  'jobId',
  'partFileIds',
  'audioFileId',
  'sttProvider',
  'providerFileId',
  'providerTranscriptionId',
  'language',
  'title',
  'keepAudio',
  'status',
  'step',
  'progress',
  'error',
  'resultJson',
  'startedAt',
  'heartbeatAt',
  'finishedAt',
];

describe('processing_jobs schema <-> JobRecord contract', () => {
  const schema = SCHEMAS.find((s) => s.collection === 'processing_jobs');

  it('declares the processing_jobs collection', () => {
    expect(schema).toBeDefined();
  });

  it('has a schema field for every DB field job-repository.ts writes', () => {
    const schemaFieldNames = new Set(schema!.fields.map((f) => f.name));
    for (const field of JOB_RECORD_DB_FIELDS) {
      expect(schemaFieldNames.has(field), `processing_jobs schema is missing "${field}"`).toBe(true);
    }
  });

  it('has no schema field job-repository.ts never writes (catches drift the other way)', () => {
    const known = new Set(JOB_RECORD_DB_FIELDS);
    for (const field of schema!.fields) {
      expect(known.has(field.name), `processing_jobs schema has an unused field "${field.name}"`).toBe(true);
    }
  });
});
