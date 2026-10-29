/**
 * Does the app remember voices across meetings? End to end through the real
 * code: the embedding model, `findOrCreateProfileAndEnrol` (AES-GCM-sealed
 * vectors in `speaker_profiles`), `listProfiles` (decrypt + HMAC check), and
 * both recognition paths of a later meeting:
 *
 *  - live: the session registry fed utterance by utterance, then
 *    `matchPendingAgainstProfiles` (what the live speaker panel shows);
 *  - post-meeting: `resolveSpeakers` on the meeting's wav (what the summary,
 *    transcript and auto-enrolment use).
 *
 * App DB is an in-memory table; nothing reaches a Hub.
 *
 *   npx tsx scripts/eval-voice-memory.ts <dir with speakerN_{a,b}_<lang>_16k.wav>
 *
 * Meeting 1 names every speaker that has an `a` recording, except one held
 * back as a stranger (`STRANGER`, default the last one). Meeting 2 interleaves
 * short turns (`TURN_SEC`, default 3) from the `b` recordings of the enrolled
 * people plus the stranger's audio. Pass = every returning person is named
 * correctly, the stranger is named nobody.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.MEETING_DATA_DIR ??= mkdtempSync(path.join(os.tmpdir(), 'voice-memory-'));
process.env.VOICEPRINT_ENC_KEY ??= randomBytes(32).toString('base64');

const sherpa = (await import('sherpa-onnx-node')).default;
const { computeEmbedding } = await import('../src/server/speaker/embedding-extractor.js');
const profileStore = await import('../src/server/speaker/profile-store.js');
const { resolveSpeakers } = await import('../src/server/speaker/resolve-speakers.js');
const { MeetingSessionRegistry } = await import('../src/server/speaker/session-speaker-registry.js');
const { matchPendingAgainstProfiles } = await import('../src/server/live-speakers/chunk-worker.js');

const RATE = 16000;
const dir = process.argv[2];
if (!dir) {
  console.error('usage: eval-voice-memory.ts <dir>');
  process.exit(2);
}
const TURN_SEC = Number(process.env.TURN_SEC ?? 3);

// ---- in-memory App DB: just what profile-store and app-settings call ----
type Row = Record<string, unknown> & { _id: string };
const tables = new Map<string, Row[]>();
const table = (name: string) => tables.get(name) ?? tables.set(name, []).get(name)!;
let nextId = 1;
const db = {
  boundRoomId: 'eval-room',
  async create(collection: string, _scope: string, data: Record<string, unknown>) {
    const row = { ...structuredClone(data), _id: `row${nextId++}` };
    table(collection).push(row);
    return structuredClone(row);
  },
  async update(collection: string, _scope: string, id: string, data: Record<string, unknown>) {
    const row = table(collection).find((r) => r._id === id);
    if (!row) throw new Error('not found');
    Object.assign(row, structuredClone(data));
    return structuredClone(row);
  },
  async getById(collection: string, _scope: string, id: string) {
    const row = table(collection).find((r) => r._id === id);
    return row ? structuredClone(row) : null;
  },
  async query(collection: string, _scope: string, args: { where?: { field: string; value: unknown }[]; limit?: number } = {}) {
    const rows = table(collection).filter((r) => (args.where ?? []).every((w) => r[w.field] === w.value));
    return { records: structuredClone(rows.slice(0, args.limit ?? 1000)), total: rows.length };
  },
  async delete() {
    return {};
  },
} as never;

// ---- recordings ----
interface Recording {
  person: string;
  take: string;
  samples: Float32Array;
}
const recordings: Recording[] = readdirSync(dir)
  .filter((f) => /^speaker\d+_[ab]_\w+_16k\.wav$/.test(f))
  .map((f) => {
    const [, n, take, lang] = /^speaker(\d+)_([ab])_(\w+)_16k\.wav$/.exec(f)!;
    return { person: `${lang}${n}`, take, samples: sherpa.readWave(path.join(dir, f)).samples };
  });
const people = [...new Set(recordings.filter((r) => r.take === 'a').map((r) => r.person))].sort();
const stranger = process.env.STRANGER ?? people.at(-1)!;
const enrolled = people.filter((p) => p !== stranger);
const take = (person: string, t: string) => recordings.find((r) => r.person === person && r.take === t);

function cut(samples: Float32Array, seconds: number): Float32Array[] {
  const size = Math.round(seconds * RATE);
  const out: Float32Array[] = [];
  for (let at = 0; at + size / 2 <= samples.length; at += size) out.push(samples.subarray(at, Math.min(samples.length, at + size)));
  return out;
}
/** 16 kHz mono 16-bit PCM with the plain 44-byte header `readWavPcm` expects. */
function wav16(samples: Float32Array): Buffer {
  const out = Buffer.alloc(44 + samples.length * 2);
  out.write('RIFF', 0);
  out.writeUInt32LE(36 + samples.length * 2, 4);
  out.write('WAVEfmt ', 8);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(RATE, 24);
  out.writeUInt32LE(RATE * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write('data', 36);
  out.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), 44 + i * 2);
  return out;
}
function average(vectors: Float32Array[]): Float32Array {
  const out = new Float32Array(vectors[0].length);
  for (const v of vectors) for (let i = 0; i < v.length; i++) out[i] += v[i] / vectors.length;
  return out;
}

// ---- meeting 1: the owner names each person; their voice is enrolled (user-post, as speaker_resolve / the job do) ----
console.log(`enrolled in meeting 1: ${enrolled.join(', ')}; stranger in meeting 2: ${stranger}; turns of ${TURN_SEC} s`);
for (const person of enrolled) {
  const rec = take(person, 'a')!;
  // resolveSpeakers' plan: up to 8 ranges, ~25 s, averaged into one representative vector.
  const ranges = cut(rec.samples, 4).slice(0, 6);
  const vectors: Float32Array[] = [];
  for (const r of ranges) vectors.push(await computeEmbedding(r));
  const result = await profileStore.findOrCreateProfileAndEnrol(
    db,
    { displayName: person, createdByUserId: 'owner' },
    average(vectors),
    { meetingId: 'meeting-1', durationSec: ranges.reduce((s, r) => s + r.length / RATE, 0), source: 'user-post', speakerKey: person },
  );
  if (!result?.enrolled) throw new Error(`enrolment of ${person} failed`);
}

// ---- storage: nothing readable at rest, and it decrypts back ----
const rows = table('speaker_profiles');
const atRest = JSON.stringify(rows);
const sealedOk = rows.every((r) => Array.isArray(r.embeddings) && (r.embeddings as unknown[]).every((e) => typeof e === 'string' && /"ct":/.test(e) && /"hmac":/.test(e)));
const plaintextLeak = /\[-?\d\.\d{3,},/.test(atRest);
profileStore.invalidateProfileCache();
const loaded = await profileStore.listProfiles(db);
console.log(
  `\nstorage: ${rows.length} profiles, vectors sealed: ${sealedOk ? 'yes' : 'NO'}, plaintext floats at rest: ${plaintextLeak ? 'YES' : 'no'}, decrypted back: ${loaded
    .map((p) => `${p.displayName}=${p.embeddings.length}`)
    .join(' ')}`,
);
const tampered = structuredClone(rows[0]);
(tampered.embeddings as string[])[0] = (tampered.embeddings as string[])[0].replace(/"ct":"(.)/, (_m, c: string) => `"ct":"${c === 'A' ? 'B' : 'A'}`);
rows.push({ ...tampered, _id: 'tampered', displayName: 'tampered' });
const withTampered = (await profileStore.listProfiles(db)).find((p) => p.id === 'tampered');
rows.pop();
console.log(`tampered vector rejected: ${withTampered && withTampered.embeddings.length === 0 ? 'yes' : 'NO'}`);

// ---- meeting 2: returning people (their `b` takes) + the stranger, interleaved short turns ----
const sources = [...enrolled.filter((p) => take(p, 'b')).map((p) => ({ person: p, samples: take(p, 'b')!.samples })), { person: stranger, samples: take(stranger, 'a')!.samples }];
const queues = sources.map((s) => cut(s.samples, TURN_SEC).map((pcm) => ({ person: s.person, pcm })));
const turns: { person: string; pcm: Float32Array; startSec: number; endSec: number }[] = [];
let clock = 0;
for (let round = 0; queues.some((q) => q.length > round); round++) {
  for (const q of queues) {
    const t = q[round];
    if (!t) continue;
    turns.push({ ...t, startSec: clock, endSec: clock + t.pcm.length / RATE });
    clock += t.pcm.length / RATE + 0.8;
  }
}

function verdict(namesByPerson: Map<string, Set<string>>): string[] {
  return sources.map(({ person }) => {
    const names = [...(namesByPerson.get(person) ?? [])];
    const expected = person === stranger ? '(nobody)' : person;
    const got = names.length ? names.join(' + ') : '(nobody)';
    return `${person.padEnd(6)} -> ${got.padEnd(14)} ${got === expected ? 'OK' : 'WRONG'}`;
  });
}

// live: one session registry, each turn observed with its own one-off label (as local-attribution.ts does), profile pass every 3 turns
const registry = new MeetingSessionRegistry('meeting-2');
const ownerOfTurn: string[] = [];
const namedAfterSec = new Map<string, number>();
for (const [i, t] of turns.entries()) {
  const label = `local:${i}`;
  registry.observe(label, await computeEmbedding(t.pcm), t.pcm.length / RATE, { speaker: label, startMs: Math.round(t.startSec * 1000), endMs: Math.round(t.endSec * 1000), final: true });
  const owner = registry.snapshot().find((s) => s.sonioxLabels.includes(label));
  ownerOfTurn.push(owner ? (owner.mergedInto ?? owner.sessionSpeakerId) : '');
  if (i % 3 === 2 || i === turns.length - 1) {
    await matchPendingAgainstProfiles(db, registry);
    for (const s of registry.snapshot()) if (s.displayName && !namedAfterSec.has(s.sessionSpeakerId)) namedAfterSec.set(s.sessionSpeakerId, t.endSec);
  }
}
const finalSnapshot = registry.snapshot();
const nameOf = (id: string) => {
  let s = finalSnapshot.find((x) => x.sessionSpeakerId === id);
  while (s?.mergedInto) s = finalSnapshot.find((x) => x.sessionSpeakerId === s!.mergedInto);
  return s?.displayName;
};
const liveNames = new Map<string, Set<string>>();
turns.forEach((t, i) => {
  const name = nameOf(ownerOfTurn[i]);
  if (name) (liveNames.get(t.person) ?? liveNames.set(t.person, new Set()).get(t.person)!).add(name);
});
const firstSpoke = new Map<string, number>();
for (const t of turns) if (!firstSpoke.has(t.person)) firstSpoke.set(t.person, t.startSec);
console.log(`\nmeeting 2 live (${turns.length} turns, ${new Set(ownerOfTurn).size} session speakers):`);
for (const line of verdict(liveNames)) console.log(`  ${line}`);
for (const [id, at] of namedAfterSec) {
  const person = turns.find((_, i) => ownerOfTurn[i] === id)?.person;
  console.log(`  named ${nameOf(id)} at ${at.toFixed(1)} s (${person} first spoke at ${firstSpoke.get(person ?? '')?.toFixed(1)} s)`);
}

// post-meeting: resolveSpeakers on the wav; diarization taken as perfect (speakerId = person) so this measures the profile part only
const wavPath = path.join(process.env.MEETING_DATA_DIR!, 'meeting-2.wav');
const audio = new Float32Array(Math.ceil((clock + 1) * RATE));
for (const t of turns) audio.set(t.pcm, Math.round(t.startSec * RATE));
writeFileSync(wavPath, wav16(audio));
const segments = turns.map((t, i) => ({ id: `s${i}`, speakerId: t.person, startSec: t.startSec, endSec: t.endSec, text: 'one two three four five', lang: 'en', tokenCount: 5 }));
const resolved = await resolveSpeakers(db, wavPath, segments, 'meeting-2');
const postNames = new Map<string, Set<string>>();
for (const r of resolved) if (r.displayName) postNames.set(r.speakerId, new Set([r.displayName]));
console.log('\nmeeting 2 post-meeting:');
for (const line of verdict(postNames)) console.log(`  ${line}`);
console.log(`  confidence: ${resolved.map((r) => `${r.speakerId}=${r.confidence?.toFixed(2) ?? '-'}`).join(' ')}`);
const after = await profileStore.listProfiles(db);
console.log(`  profiles after meeting 2: ${after.map((p) => `${p.displayName}=${p.embeddings.length} vectors`).join(', ')} (auto-enrol adds a vector on a confident match)`);
process.exit(0);
