/**
 * Writes the `bpe.vocab` that sherpa-onnx needs to turn hotwords typed as
 * words into model tokens (`modelConfig.bpeVocab`), from the SentencePiece
 * `bpe.model` a sherpa-onnx release ships: one `piece<TAB>score` line per
 * piece, as `spm_export_vocab` prints it. No Python in the image: the model
 * file is a small protobuf, read here by hand. (The Vietnamese model's is a
 * unigram model despite its name; sherpa-onnx encodes hotwords with it fine.)
 *
 *   node scripts/bpe-vocab.mjs <bpe.model> <bpe.vocab>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** The fields of a protobuf message: [field number, value] (varint as number, anything else as Buffer). */
function fields(buf) {
  const out = [];
  let i = 0;
  const varint = () => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = buf[i++];
      value += (byte & 0x7f) * 2 ** shift;
      if (byte < 0x80) return value;
      shift += 7;
    }
  };
  while (i < buf.length) {
    const key = varint();
    const field = Math.floor(key / 8);
    const wire = key % 8;
    if (wire === 0) out.push([field, varint()]);
    else if (wire === 1) out.push([field, buf.subarray(i, (i += 8))]);
    else if (wire === 2) {
      const len = varint();
      out.push([field, buf.subarray(i, (i += len))]);
    } else if (wire === 5) out.push([field, buf.subarray(i, (i += 4))]);
    else throw new Error(`unsupported protobuf wire type ${wire}`);
  }
  return out;
}

/** `ModelProto.pieces` (field 1), each `{ piece: 1, score: 2 }`, in model order (= token ids). */
export function bpeVocab(model) {
  const lines = [];
  for (const [field, value] of fields(model)) {
    if (field !== 1) continue;
    let piece = '';
    let score = 0;
    for (const [f, v] of fields(value)) {
      if (f === 1) piece = v.toString('utf8');
      else if (f === 2) score = v.readFloatLE(0);
    }
    lines.push(`${piece}\t${Number.isInteger(score) ? score : score.toFixed(6).replace(/0+$/, '')}`);
  }
  if (!lines.length) throw new Error('no pieces in the model');
  return `${lines.join('\n')}\n`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) {
    console.error('usage: bpe-vocab.mjs <bpe.model> <bpe.vocab>');
    process.exit(2);
  }
  writeFileSync(output, bpeVocab(readFileSync(input)));
}
