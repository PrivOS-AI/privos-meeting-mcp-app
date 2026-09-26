#!/usr/bin/env -S npx tsx
/**
 * Re-runs the vendors' OWN async diarization (soniox-async, elevenlabs-batch)
 * over one meeting recording, through the exact provider + segment-builder
 * code the post-meeting job uses, and dumps raw tokens, segments and a
 * readable per-speaker turn list per provider — so a recorded meeting's
 * stored transcript can be compared against what each model says on its own.
 *
 * Runs ON THE NODE (needs the vendor keys in .env):
 *   npx tsx scripts/rediarize-meeting.ts --audio ./data/export/<name>/audio.webm \
 *     --out ./data/export/<name>/rediarize [--providers soniox,elevenlabs] [--lang vi]
 */
import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { decodeToWav16k } from '../src/server/media/decode-audio.js';
import { asyncProviderFor } from '../src/server/stt/stt-provider-registry.js';
import type { SttVendor } from '../src/server/stt/stt-provider.js';
import { buildSegments, type Segment } from '../src/server/transcript/segment-builder.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function fmt(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = (sec % 60).toFixed(1).padStart(4, '0');
  return `${m}:${s}`;
}

function turnList(segments: readonly Segment[]): string {
  const totals = new Map<string, number>();
  for (const s of segments) totals.set(s.speakerId, (totals.get(s.speakerId) ?? 0) + (s.endSec - s.startSec));
  const lines = [`# ${segments.length} segments, ${totals.size} speakers`, ''];
  for (const [id, sec] of [...totals].sort((a, b) => b[1] - a[1])) lines.push(`- ${id}: ${sec.toFixed(1)}s`);
  lines.push('');
  for (const s of segments) lines.push(`[${fmt(s.startSec)}–${fmt(s.endSec)}] ${s.speakerId}: ${s.text}`);
  return lines.join('\n');
}

async function main(): Promise<void> {
  const audio = arg('audio');
  const out = arg('out');
  if (!audio || !out) throw new Error('--audio <webm> and --out <dir> are required');
  const providers = (arg('providers') ?? 'soniox,elevenlabs').split(',') as SttVendor[];
  const lang = arg('lang') ?? 'vi';
  await mkdir(out, { recursive: true });

  const wavPath = path.join(out, 'audio-16k.wav');
  const decoded = await decodeToWav16k(audio, wavPath, new AbortController().signal);
  console.log(`decoded ${decoded.durationSec.toFixed(1)}s`);

  for (const vendor of providers) {
    const started = Date.now();
    const provider = asyncProviderFor(vendor);
    const result = await provider.transcribeFile({
      audioPath: vendor === 'elevenlabs' ? wavPath : audio,
      languageHints: [lang],
      enableSpeakerDiarization: true,
    });
    const segments = buildSegments(result.tokens, { pauseSplitSec: 1.5, tokensCarrySpacing: vendor === 'soniox' });
    await writeFile(path.join(out, `${vendor}-tokens.json`), JSON.stringify(result, null, 1));
    await writeFile(path.join(out, `${vendor}-segments.json`), JSON.stringify(segments, null, 1));
    await writeFile(path.join(out, `${vendor}-turns.md`), turnList(segments));
    console.log(`${vendor}: ${result.tokens.length} tokens, ${segments.length} segments in ${((Date.now() - started) / 1000).toFixed(0)}s`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
