/**
 * Word error rate on a labelled Vietnamese test set, and what hotwords do to it:
 *
 *   npx tsx scripts/eval-asr-set.ts <model dir> <set dir> [--kind K] [--every N [--offset K]] [--limit N] [--setups now,hw1.0,...] [--threads N] [--hyp FILE]
 *
 * `<model dir>` is a sherpa-onnx release folder of the `--kind` given:
 *  - `zipformer` (default): a Vietnamese Zipformer, with its `bpe.model`;
 *  - `qwen3`: Qwen3-ASR (conv_frontend, encoder, decoder, `tokenizer/`);
 *  - `cohere`: Cohere Transcribe (encoder, decoder, tokens.txt);
 *  - `moonshine`: Moonshine v2 (encoder_model, decoder_model_merged, tokens.txt).
 * `<set dir>` holds the WAVs (16 kHz mono) and `trans.tsv`: one
 * `file<TAB>reference` line each, the reference as people write it (upper and
 * lower case, punctuation): real meeting recordings, or a public set (FLEURS).
 * `--every N` keeps every Nth line of it (from line `--offset K`), a smaller set
 * for slow models that still has every kind of file (`--limit` keeps the files
 * with terms first); runs with offsets 0 and N/2 together make `--every N/2`.
 *
 * Terms (what a Room glossary would list) are the capitalised words of the
 * references that do not start a sentence ("Hà Nội", "Mozart"). Unless the set
 * has a `glossary.txt` (one term per line, used for every file), each file gets
 * its own terms plus DISTRACTORS terms of other files, like a glossary of which
 * only a few are said; `--all-terms` gives every file every term instead (as
 * many as a Room's list can hold, `MAX_HOTWORDS`). Setups: a Zipformer's are a
 * beam and a hotword boost (`now`, `hw1.5`, …); the other kinds take `plain`,
 * `hw` (Qwen3-ASR only: the terms as its context) and `auto` (Qwen3-ASR picks
 * the language itself). Reported per setup:
 *  - WER: word error rate over every file (references with digits are skipped:
 *    the model writes numbers as words);
 *  - term recall: how many term occurrences the output has, word for word;
 *  - false terms: outputs with a listed term the reference does not have — the
 *    cost of biasing;
 *  - runaway: outputs far longer than the reference (a decoder that loops), and
 *    empty ones;
 *  - RTF: decode time / audio time (1 thread unless --threads), and the load time.
 * Then the process's peak memory (RSS), which is what a container must hold.
 */
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
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
  console.error('usage: eval-asr-set.ts <model dir> <set dir> [--kind zipformer|qwen3|cohere|moonshine] [--every N] [--limit N] [--setups now,hw1.0] [--threads N] [--hyp FILE]');
  process.exit(2);
}
const flag = (name: string) => {
  const at = process.argv.indexOf(`--${name}`);
  return at > 0 ? process.argv[at + 1] : undefined;
};
const limit = Number(flag('limit') ?? Infinity);
const every = Number(flag('every') ?? 1);
const offset = Number(flag('offset') ?? 0);
const threads = Number(flag('threads') ?? 1);
const kind = flag('kind') ?? 'zipformer';
const hypFile = flag('hyp');
if (!['zipformer', 'qwen3', 'cohere', 'moonshine'].includes(kind)) throw new Error(`unknown kind ${kind}`);

interface Setup {
  /** Zipformer: paths kept by the beam search. */
  beam?: number;
  /** Zipformer: hotword boost per token; undefined = no hotwords. */
  hotwordsScore?: number;
  /** Qwen3-ASR: the terms as its context. */
  hotwords?: boolean;
  /** Qwen3-ASR: no language given, it picks one. */
  autoLanguage?: boolean;
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
  plain: {},
  hw: { hotwords: true },
  auto: { autoLanguage: true },
};
const chosen = (flag('setups') ?? (kind === 'zipformer' ? 'now,hw1.0,hw1.5,hw2.0' : kind === 'qwen3' ? 'plain,hw' : 'plain')).split(',');
const biased = (setup: Setup) => setup.hotwordsScore !== undefined || Boolean(setup.hotwords);

// ---- model ----

const file = (pattern: RegExp) => {
  const found = readdirSync(modelDir).filter((f) => pattern.test(f));
  if (!found.length) throw new Error(`no ${pattern} in ${modelDir}`);
  return path.join(modelDir, found.sort((a, b) => Number(a.includes('int8')) - Number(b.includes('int8')))[0]);
};
const tokensFile = path.join(modelDir, 'tokens.txt');
const featConfig = { sampleRate: RATE, featureDim: 80 };
const common = { numThreads: threads, provider: 'cpu', debug: 0 };

let vocabFile = '';
let alphabet: ReadonlySet<string> = new Set();
let encoder = '';
if (kind === 'zipformer') {
  vocabFile = path.join(mkdtempSync(path.join(os.tmpdir(), 'eval-asr-set-')), 'bpe.vocab');
  writeFileSync(vocabFile, bpeVocab(readFileSync(path.join(modelDir, 'bpe.model'))));
  alphabet = tokenAlphabet(readFileSync(tokensFile, 'utf8'));
  encoder = process.env.FP32 ? file(/^encoder.*(?<!int8)\.onnx$/) : file(/^encoder.*\.onnx$/);
}

function recognizer(setup: Setup) {
  if (kind === 'qwen3') {
    return new sherpa.OfflineRecognizer({
      featConfig,
      modelConfig: {
        qwen3Asr: {
          convFrontend: file(/^conv_frontend.*\.onnx$/),
          encoder: file(/^encoder.*\.onnx$/),
          decoder: file(/^decoder.*\.onnx$/),
          tokenizer: path.join(modelDir, 'tokenizer'),
          // A 30 s FLEURS utterance is ~150 tokens of Vietnamese; the default 128 cuts it.
          maxNewTokens: 256,
        },
        ...common,
      },
    });
  }
  if (kind === 'cohere') {
    return new sherpa.OfflineRecognizer({
      featConfig,
      // No ITN: the references spell numbers as words. Its vocabulary lacks most
      // Vietnamese capitals with diacritics ("Đ", "Ấ"): they are byte pieces,
      // which sherpa-onnx 1.13.8 drops from the text ("Địa" → "ịa").
      modelConfig: { cohereTranscribe: { encoder: file(/^encoder.*\.onnx$/), decoder: file(/^decoder.*\.onnx$/), usePunct: 1, useItn: 0 }, tokens: tokensFile, ...common },
    });
  }
  if (kind === 'moonshine') {
    return new sherpa.OfflineRecognizer({
      featConfig,
      modelConfig: { moonshine: { encoder: file(/^encoder.*\.(onnx|ort)$/), mergedDecoder: file(/^decoder.*merged.*\.(onnx|ort)$/) }, tokens: tokensFile, ...common },
    });
  }
  return new sherpa.OfflineRecognizer({
    featConfig,
    modelConfig: {
      transducer: { encoder, decoder: file(/^decoder.*\.onnx$/), joiner: file(/^joiner.*\.onnx$/) },
      tokens: tokensFile,
      ...common,
      modelingUnit: 'bpe',
      bpeVocab: vocabFile,
    },
    decodingMethod: 'modified_beam_search',
    maxActivePaths: setup.beam ?? 4,
    ...(setup.hotwordsScore === undefined ? {} : { hotwordsScore: setup.hotwordsScore }),
  });
}

function streamFor(rec: ReturnType<typeof recognizer>, setup: Setup, terms: string[]) {
  if (kind === 'zipformer') {
    return setup.hotwordsScore === undefined ? rec.createStream() : rec.createStream(hotwordList(terms, alphabet, 'vi'));
  }
  const stream = rec.createStream();
  if (kind === 'qwen3') {
    if (!setup.autoLanguage) stream.setOption('language', 'Vietnamese');
    if (setup.hotwords) stream.setOption('hotwords', terms.join(','));
  }
  if (kind === 'cohere') stream.setOption('language', 'vi');
  return stream;
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
  .filter((cols) => !/\d/.test(cols[1]))
  .filter((_, i) => i % every === offset);
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
/** Node plus the whole set in memory: what the peak holds besides the model. */
const baseRss = process.memoryUsage().rss;

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

console.log(`${items.length} files, ${(audioSec / 60).toFixed(1)} min audio, ${allTerms.length} terms, ${items.filter((i) => i.terms.length).length} files with terms, ${glossary ? `glossary.txt (${glossary.length})` : process.argv.includes('--all-terms') ? 'every term' : `own terms + ${DISTRACTORS} distractors`}, ${kind} ${path.basename(encoder || modelDir)}, ${threads} thread(s)\n`);
console.log(['setup'.padEnd(10), 'WER'.padStart(8), 'term recall'.padStart(14), 'false terms'.padStart(13), 'runaway/empty'.padStart(15), 'RTF'.padStart(7), 'load s'.padStart(8)].join(''));

for (const name of chosen) {
  const setup = SETUPS[name];
  if (!setup) throw new Error(`unknown setup ${name}`);
  const loading = performance.now();
  const rec = recognizer(setup);
  const loadSec = (performance.now() - loading) / 1000;
  let errors = 0;
  let refWords = 0;
  let termHits = 0;
  let termCount = 0;
  let falseTerms = 0;
  let runaway = 0;
  let empty = 0;
  let decodeMs = 0;
  const changed: string[] = [];
  items.forEach((item, i) => {
    const stream = streamFor(rec, setup, biased(setup) ? listFor[i] : []);
    stream.acceptWaveform({ samples: audio[i], sampleRate: RATE });
    const started = performance.now();
    rec.decode(stream);
    decodeMs += performance.now() - started;
    const hyp = rec.getResult(stream).text as string;
    const r = words(item.reference);
    const h = words(hyp);
    errors += editDistance(r, h);
    refWords += r.length;
    if (h.length > r.length * 1.5 + 5) runaway++;
    if (!h.length) empty++;
    for (const term of item.terms) {
      termCount++;
      if (has(hyp, term)) termHits++;
    }
    for (const term of listFor[i]) if (has(hyp, term) && !has(item.reference, term)) falseTerms++;
    if (hypFile) appendFileSync(hypFile, `${name}\t${item.wav}\t${hyp.replace(/\s+/g, ' ')}\n`);
    if (process.env.SHOW && item.terms.length) changed.push(`  ${item.wav}: ${item.terms.join(', ')}\n    → ${hyp}`);
  });
  console.log(
    [
      name.padEnd(10),
      `${((errors / refWords) * 100).toFixed(2)}%`.padStart(8),
      `${termHits}/${termCount} ${((termHits / Math.max(1, termCount)) * 100).toFixed(1)}%`.padStart(14),
      String(falseTerms).padStart(13),
      `${runaway}/${empty}`.padStart(15),
      (decodeMs / 1000 / audioSec).toFixed(3).padStart(7),
      loadSec.toFixed(1).padStart(8),
    ].join(''),
  );
  if (changed.length) console.log(changed.slice(0, 15).join('\n'));
}
const peakMb = process.resourceUsage().maxRSS / 1024;
console.log(`\npeak RSS ${peakMb.toFixed(0)} MB, of which ${(baseRss / 2 ** 20).toFixed(0)} MB is Node and the audio set (the model and its decoding: ~${(peakMb - baseRss / 2 ** 20).toFixed(0)} MB)`);
process.exit(0);
