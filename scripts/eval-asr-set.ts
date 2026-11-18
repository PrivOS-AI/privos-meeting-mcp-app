/**
 * Word error rate on a labelled Vietnamese test set, and what hotwords do to it:
 *
 *   npx tsx scripts/eval-asr-set.ts <model dir> <set dir> [--limit N] [--setups now,hw1.0,...] [--threads N]
 *
 * `<model dir>` is a sherpa-onnx Vietnamese Zipformer release folder (with its
 * `bpe.model`). `<set dir>` holds the WAVs (16 kHz mono) and `trans.tsv`: one
 * `file<TAB>reference` line each, the reference as people write it (upper and
 * lower case, punctuation): real meeting recordings, or a public set (FLEURS).
 *
 * Terms (what a Room glossary would list) are the capitalised words of the
 * references that do not start a sentence ("Hà Nội", "Mozart"). Unless the set
 * has a `glossary.txt` (one term per line, used for every file), each file gets
 * its own terms plus DISTRACTORS terms of other files, like a glossary of which
 * only a few are said; `--all-terms` gives every file every term instead (as
 * many as a Room's list can hold, `MAX_HOTWORDS`). Reported per setup:
 *  - WER: word error rate over every file (references with digits are skipped:
 *    the model writes numbers as words);
 *  - term recall: how many term occurrences the output has, word for word;
 *  - false terms: outputs with a listed term the reference does not have — the
 *    cost of biasing;
 *  - RTF: decode time / audio time (1 thread unless --threads).
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import sherpa from 'sherpa-onnx-node';

import { normalizeLevel } from '../src/server/asr/asr-engine.js';
import { hotwordList, tokenAlphabet } from '../src/server/asr/hotwords.js';
// @ts-expect-error — plain .mjs, no types.
import { bpeVocab } from './bpe-vocab.mjs';

const RATE = 16000;
const DISTRACTORS = 30;

const [modelDir, setDir] = process.argv.slice(2);
if (!modelDir || !setDir) {
  console.error('usage: eval-asr-set.ts <model dir> <set dir> [--limit N] [--setups now,hw1.0] [--threads N]');
  process.exit(2);
}
const flag = (name: string) => {
  const at = process.argv.indexOf(`--${name}`);
  return at > 0 ? process.argv[at + 1] : undefined;
};
const limit = Number(flag('limit') ?? Infinity);
const threads = Number(flag('threads') ?? 1);

interface Setup {
  beam: number;
  /** Hotword boost per token; undefined = no hotwords. */
  hotwordsScore?: number;
}
const SETUPS: Record<string, Setup> = {
  now: { beam: 4 },
  beam8: { beam: 8 },
  'hw0.5': { beam: 4, hotwordsScore: 0.5 },
  'hw1.0': { beam: 4, hotwordsScore: 1.0 },
  'hw1.5': { beam: 4, hotwordsScore: 1.5 },
  'hw2.0': { beam: 4, hotwordsScore: 2.0 },
  'hw2.5': { beam: 4, hotwordsScore: 2.5 },
  'hw3.0': { beam: 4, hotwordsScore: 3.0 },
};
const chosen = (flag('setups') ?? 'now,hw1.0,hw1.5,hw2.0').split(',');

// ---- model ----

const file = (pattern: RegExp) => {
  const found = readdirSync(modelDir).filter((f) => pattern.test(f));
  if (!found.length) throw new Error(`no ${pattern} in ${modelDir}`);
  return path.join(modelDir, found.sort((a, b) => Number(a.includes('int8')) - Number(b.includes('int8')))[0]);
};
const tmp = mkdtempSync(path.join(os.tmpdir(), 'eval-asr-set-'));
const vocabFile = path.join(tmp, 'bpe.vocab');
writeFileSync(vocabFile, bpeVocab(readFileSync(path.join(modelDir, 'bpe.model'))));
const tokensFile = path.join(modelDir, 'tokens.txt');
const alphabet = tokenAlphabet(readFileSync(tokensFile, 'utf8'));
const encoder = process.env.FP32 ? file(/^encoder.*(?<!int8)\.onnx$/) : file(/^encoder.*\.onnx$/);

function recognizer(setup: Setup) {
  return new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: RATE, featureDim: 80 },
    modelConfig: {
      transducer: { encoder, decoder: file(/^decoder.*\.onnx$/), joiner: file(/^joiner.*\.onnx$/) },
      tokens: tokensFile,
      numThreads: threads,
      provider: 'cpu',
      debug: 0,
      modelingUnit: 'bpe',
      bpeVocab: vocabFile,
    },
    decodingMethod: 'modified_beam_search',
    maxActivePaths: setup.beam,
    ...(setup.hotwordsScore === undefined ? {} : { hotwordsScore: setup.hotwordsScore }),
  } as never);
}

// ---- set ----

function words(text: string): string[] {
  return text
    .normalize('NFC')
    .toLocaleLowerCase('vi')
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/** Capitalised runs of words that do not open a sentence: "… ở Hà Nội và Mozart." → ["Hà Nội", "Mozart"]. */
function termsOf(reference: string): string[] {
  const terms: string[] = [];
  let run: string[] = [];
  let sentenceStart = true;
  const close = () => {
    if (run.length) terms.push(run.join(' '));
    run = [];
  };
  for (const raw of reference.normalize('NFC').split(/\s+/)) {
    const word = raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
    const capital = /^\p{Lu}/u.test(word);
    if (capital && !sentenceStart) run.push(word);
    else close();
    if (!word || /[,;:()"“”]$/.test(raw)) close();
    sentenceStart = /[.!?]$/.test(raw);
  }
  close();
  return terms.filter((t) => t.length >= 3);
}

const lines = readFileSync(path.join(setDir, 'trans.tsv'), 'utf8')
  .split('\n')
  .map((l) => l.split('\t'))
  .filter((cols) => cols.length >= 2 && cols[0].endsWith('.wav') && existsSync(path.join(setDir, cols[0])))
  .filter((cols) => !/\d/.test(cols[1]));
const glossary = existsSync(path.join(setDir, 'glossary.txt'))
  ? readFileSync(path.join(setDir, 'glossary.txt'), 'utf8').split('\n').map((t) => t.trim()).filter(Boolean)
  : undefined;
// Files with terms first (they say most about hotwords), then the rest, up to --limit.
const items = lines
  .map(([wav, reference]) => ({ wav, reference, terms: termsOf(reference) }))
  .sort((a, b) => Number(b.terms.length > 0) - Number(a.terms.length > 0))
  .slice(0, limit);
const allTerms = [...new Set(items.flatMap((i) => i.terms))];

let seed = 11;
const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const listFor = items.map((item) => {
  if (glossary) return glossary;
  // Each file's own terms first, so the cap never drops them.
  if (process.argv.includes('--all-terms')) return [...new Set([...item.terms, ...allTerms])];
  const others = allTerms.filter((t) => !item.terms.includes(t)).sort(() => random() - 0.5);
  return [...new Set(item.terms), ...others.slice(0, DISTRACTORS)].sort(() => random() - 0.5);
});
const audio = items.map((i) => normalizeLevel(sherpa.readWave(path.join(setDir, i.wav)).samples));
const audioSec = audio.reduce((sum, s) => sum + s.length, 0) / RATE;

// ---- scoring ----

function editDistance(r: string[], h: string[]): number {
  let prev = Array.from({ length: h.length + 1 }, (_, j) => j);
  for (let i = 1; i <= r.length; i++) {
    const row = [i];
    for (let j = 1; j <= h.length; j++) row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1));
    prev = row;
  }
  return prev[h.length];
}

const has = (text: string, term: string) => ` ${words(text).join(' ')} `.includes(` ${words(term).join(' ')} `);

console.log(`${items.length} files, ${(audioSec / 60).toFixed(1)} min audio, ${allTerms.length} terms, ${items.filter((i) => i.terms.length).length} files with terms, ${glossary ? `glossary.txt (${glossary.length})` : process.argv.includes('--all-terms') ? 'every term' : `own terms + ${DISTRACTORS} distractors`}, encoder ${path.basename(encoder)}, ${threads} thread(s)\n`);
console.log(['setup'.padEnd(10), 'WER'.padStart(8), 'term recall'.padStart(14), 'false terms'.padStart(13), 'RTF'.padStart(7)].join(''));

for (const name of chosen) {
  const setup = SETUPS[name];
  if (!setup) throw new Error(`unknown setup ${name}`);
  const rec = recognizer(setup);
  let errors = 0;
  let refWords = 0;
  let termHits = 0;
  let termCount = 0;
  let falseTerms = 0;
  let decodeMs = 0;
  const changed: string[] = [];
  items.forEach((item, i) => {
    const hotwords = setup.hotwordsScore === undefined ? undefined : hotwordList(listFor[i], alphabet, 'vi');
    const stream = hotwords ? rec.createStream(hotwords) : rec.createStream();
    stream.acceptWaveform({ samples: audio[i], sampleRate: RATE });
    const started = performance.now();
    rec.decode(stream);
    decodeMs += performance.now() - started;
    const hyp = rec.getResult(stream).text as string;
    const r = words(item.reference);
    errors += editDistance(r, words(hyp));
    refWords += r.length;
    for (const term of item.terms) {
      termCount++;
      if (has(hyp, term)) termHits++;
    }
    for (const term of listFor[i]) if (has(hyp, term) && !has(item.reference, term)) falseTerms++;
    if (process.env.SHOW && item.terms.length) changed.push(`  ${item.wav}: ${item.terms.join(', ')}\n    → ${hyp}`);
  });
  console.log(
    [
      name.padEnd(10),
      `${((errors / refWords) * 100).toFixed(2)}%`.padStart(8),
      `${termHits}/${termCount} ${((termHits / Math.max(1, termCount)) * 100).toFixed(1)}%`.padStart(14),
      String(falseTerms).padStart(13),
      (decodeMs / 1000 / audioSec).toFixed(3).padStart(7),
    ].join(''),
  );
  if (changed.length) console.log(changed.slice(0, 15).join('\n'));
}
process.exit(0);
