/**
 * Transcribes a 16 kHz mono WAV with the built-in (`local`) provider and prints
 * the speaker-labelled segments — a smoke test for the baked models.
 *
 *   npx tsx scripts/smoke-local-stt.ts <file.wav> [--no-diarization]
 * In the image: docker run --rm -v "$PWD/x.wav:/tmp/x.wav:ro" --entrypoint node_modules/.bin/tsx <image> scripts/smoke-local-stt.ts /tmp/x.wav
 */
import { localAsyncProvider } from '../src/server/stt/local-async-provider.js';

const file = process.argv[2];
if (!file) {
  console.error('usage: smoke-local-stt.ts <file.wav> [--no-diarization]');
  process.exit(2);
}
const started = Date.now();
const result = await localAsyncProvider.transcribeFile({ audioPath: file, enableSpeakerDiarization: !process.argv.includes('--no-diarization') });
for (const segment of result.segments) {
  console.log(`[${(segment.startMs / 1000).toFixed(1)}–${(segment.endMs / 1000).toFixed(1)}] ${segment.speaker} (${segment.language}): ${segment.text}`);
}
console.log(`\n${result.tokens.length} words, language ${result.language ?? '?'}, ${((Date.now() - started) / 1000).toFixed(1)} s`);
process.exit(0);
