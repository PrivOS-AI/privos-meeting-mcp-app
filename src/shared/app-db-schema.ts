/**
 * Single source of truth for EVERY App DB collection this app uses, across all
 * phases. `meeting_bootstrap` registers these through the installation bot;
 * the iframe never registers schema (it only reads for display).
 *
 * App DB fields are `string | number | boolean | date | array | reference`
 * only — structured values are stored as JSON strings. `registerCollection` is
 * NOT idempotent on the Hub, so `ensureAppDbSchema` treats "already registered"
 * as success then reconciles drift via `updateSchema` (see `app-db-bot-client`).
 *
 * `scope:'global'` collections (speaker_profiles, app_settings) register and
 * read room-lessly. `scope:'room'` collections carry `roomId` and require it.
 */

export type DbFieldType = 'string' | 'number' | 'boolean' | 'date' | 'array' | 'reference';

export interface CollectionField {
  name: string;
  type: DbFieldType;
  required?: boolean;
  maxLength?: number;
  refCollection?: string;
  onDelete?: 'cascade' | 'setNull' | 'restrict';
}

export interface CollectionIndex {
  fields: Record<string, 1 | -1>;
  unique?: boolean;
}

export interface CollectionSchema {
  collection: string;
  scope: 'global' | 'room';
  fields: readonly CollectionField[];
  indexes: readonly CollectionIndex[];
}

export const SCHEMAS: readonly CollectionSchema[] = [
  {
    collection: 'speaker_profiles',
    scope: 'global',
    fields: [
      { name: 'displayName', type: 'string', required: true, maxLength: 200 },
      { name: 'displayNameNormalized', type: 'string', required: true, maxLength: 200 },
      { name: 'privosUserId', type: 'string' },
      { name: 'privosUsername', type: 'string' },
      { name: 'colorKey', type: 'string' },
      { name: 'createdByUserId', type: 'string', required: true },
      { name: 'createdInRoomId', type: 'string' },
      // Element = JSON string {ct,iv,tag,hmac,meetingId,durationSec,createdAt}.
      { name: 'embeddings', type: 'array' },
      // Ciphertext centroid (base64 Float32 encrypted).
      { name: 'centroid', type: 'string' },
      { name: 'dim', type: 'number' },
      { name: 'sampleCount', type: 'number' },
      { name: 'lastSeenAt', type: 'date' },
    ],
    indexes: [
      { fields: { privosUserId: 1 } },
      { fields: { displayNameNormalized: 1 } },
      { fields: { createdByUserId: 1 } },
    ],
  },
  {
    collection: 'app_settings',
    scope: 'global',
    fields: [
      { name: 'key', type: 'string', required: true, maxLength: 120 },
      { name: 'valueJson', type: 'string', required: true, maxLength: 20000 },
    ],
    indexes: [{ fields: { key: 1 }, unique: true }],
  },
  {
    collection: 'meetings',
    scope: 'room',
    fields: [
      { name: 'roomId', type: 'string', required: true },
      { name: 'title', type: 'string', maxLength: 300 },
      { name: 'slug', type: 'string', maxLength: 200 },
      { name: 'startedAt', type: 'date' },
      { name: 'endedAt', type: 'date' },
      { name: 'durationSec', type: 'number' },
      { name: 'language', type: 'string' },
      { name: 'translationEnabled', type: 'boolean' },
      { name: 'translationLang', type: 'string' },
      { name: 'ownerUserId', type: 'string', required: true },
      // recording | uploading | processing | summarized | failed | interrupted
      { name: 'status', type: 'string' },
      { name: 'folderId', type: 'string' },
      { name: 'partCount', type: 'number' },
      { name: 'lastPartAt', type: 'date' },
      { name: 'keepAudio', type: 'boolean' },
      // JSON {recorderEpochMs, sessions:[{index,wsSessionOffsetMs,startedAt,clockSkewMs}]}
      { name: 'sttSessionMeta', type: 'string', maxLength: 20000 },
      { name: 'liveTurnsFileId', type: 'string' },
      { name: 'audioFileId', type: 'string' },
      { name: 'transcriptJsonFileId', type: 'string' },
      { name: 'transcriptMdFileId', type: 'string' },
      { name: 'srtFileId', type: 'string' },
      { name: 'summaryFileId', type: 'string' },
      { name: 'summaryText', type: 'string', maxLength: 20000 },
      { name: 'keyTopics', type: 'array' },
      { name: 'speakerCount', type: 'number' },
      { name: 'audioDeletedAt', type: 'date' },
      { name: 'sentToChatAt', type: 'date' },
      { name: 'summaryError', type: 'string', maxLength: 4000 },
    ],
    indexes: [{ fields: { startedAt: -1 } }, { fields: { status: 1 } }],
  },
  {
    collection: 'meeting_speakers',
    scope: 'room',
    fields: [
      { name: 'meeting', type: 'reference', refCollection: 'meetings', onDelete: 'cascade' },
      { name: 'speakerId', type: 'string' },
      { name: 'sessionSpeakerId', type: 'string' },
      // Merged realtime `speaker` labels, `s{sessionIndex}:{label}[@n]`.
      { name: 'sonioxLabels', type: 'array' },
      { name: 'profileId', type: 'string' },
      { name: 'displayName', type: 'string', maxLength: 200 },
      // user | async | live
      { name: 'nameSource', type: 'string' },
      { name: 'privosUserId', type: 'string' },
      { name: 'confidence', type: 'number' },
      { name: 'liveConfidence', type: 'number' },
      { name: 'liveSpeechSec', type: 'number' },
      { name: 'liveUpdatedAt', type: 'date' },
      { name: 'snapshotHash', type: 'string' },
      { name: 'resolved', type: 'boolean' },
      { name: 'totalSpeakSec', type: 'number' },
      { name: 'colorKey', type: 'string' },
      { name: 'sampleStartSec', type: 'number' },
      { name: 'sampleEndSec', type: 'number' },
      // Ciphertext + hmac, kept until the async job finishes then cleared.
      { name: 'pendingEmbedding', type: 'string', maxLength: 20000 },
    ],
    indexes: [{ fields: { meeting: 1 } }],
  },
  {
    collection: 'action_items',
    scope: 'room',
    fields: [
      { name: 'meeting', type: 'reference', refCollection: 'meetings', onDelete: 'cascade' },
      { name: 'task', type: 'string', required: true, maxLength: 2000 },
      { name: 'owner', type: 'string', maxLength: 200 },
      { name: 'due', type: 'date' },
      { name: 'atSec', type: 'number' },
      { name: 'done', type: 'boolean' },
      { name: 'listItemId', type: 'string' },
    ],
    indexes: [{ fields: { meeting: 1 } }, { fields: { done: 1 } }],
  },
  {
    collection: 'bookmarks',
    scope: 'room',
    fields: [
      { name: 'meeting', type: 'reference', refCollection: 'meetings', onDelete: 'cascade' },
      { name: 'atSec', type: 'number', required: true },
      { name: 'quote', type: 'string', maxLength: 2000 },
      { name: 'createdBy', type: 'string' },
    ],
    indexes: [{ fields: { meeting: 1 } }],
  },
  {
    collection: 'processing_jobs',
    scope: 'room',
    fields: [
      { name: 'meetingId', type: 'string', required: true },
      { name: 'roomId', type: 'string', required: true },
      { name: 'jobId', type: 'string', required: true },
      { name: 'language', type: 'string' },
      { name: 'title', type: 'string', maxLength: 300 },
      { name: 'keepAudio', type: 'boolean' },
      { name: 'partFileIds', type: 'array' },
      { name: 'audioFileId', type: 'string' },
      { name: 'providerFileId', type: 'string' },
      { name: 'providerTranscriptionId', type: 'string' },
      // queued | processing | completed | failed
      { name: 'status', type: 'string' },
      { name: 'step', type: 'string' },
      { name: 'progress', type: 'number' },
      { name: 'error', type: 'string', maxLength: 4000 },
      { name: 'resultJson', type: 'string', maxLength: 20000 },
      { name: 'startedAt', type: 'date' },
      { name: 'heartbeatAt', type: 'date' },
      { name: 'finishedAt', type: 'date' },
    ],
    indexes: [{ fields: { meetingId: 1 }, unique: true }, { fields: { jobId: 1 } }, { fields: { status: 1 } }],
  },
] as const;

/** Just the collection names, for assertions and bootstrap verification. */
export const COLLECTION_NAMES = SCHEMAS.map((s) => s.collection);
