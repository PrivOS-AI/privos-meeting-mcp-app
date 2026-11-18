/**
 * Hotwords (contextual biasing): names and terms a meeting is likely to use —
 * the people of the Room, the meeting title, the Room's own glossary — given to
 * the recogniser for each utterance so it prefers them over a similar-sounding
 * common word (`modified_beam_search` only; sherpa-onnx turns each phrase into
 * model tokens with `bpe.vocab`). The boost is small on purpose: a strong one
 * forces a listed phrase onto speech that only resembles it
 * (`scripts/eval-asr-set.ts` measures both effects).
 *
 * A phrase the model cannot spell (a letter missing from its tokens, a digit —
 * the models write numbers as words) is left out here: sherpa-onnx drops the
 * whole list when one phrase fails to encode.
 */

/** Phrases kept per meeting, and the size of each. */
export const MAX_HOTWORDS = 150;
const MAX_PHRASE_CHARS = 40;
const MAX_PHRASE_WORDS = 5;
/** A phrase must be at least this long: a single letter or "Hà" alone would bias half of all speech. */
const MIN_PHRASE_CHARS = 3;

/**
 * The letters a model can spell any word with: those that are a piece of their own in its
 * `tokens.txt` (SentencePiece marks a word start with ▁). A letter that only occurs inside
 * longer pieces cannot always be encoded.
 */
export function tokenAlphabet(tokensTxt: string): Set<string> {
  const letters = new Set<string>();
  for (const line of tokensTxt.split('\n')) {
    const piece = line.slice(0, line.lastIndexOf(' ')).replace(/▁/g, '');
    if (piece && !piece.startsWith('<') && [...piece].length === 1) letters.add(piece);
  }
  return letters;
}

/** One term as the model writes it (upper case, NFC, no punctuation), or '' when it cannot be a hotword for this model. */
export function hotwordPhrase(term: string, alphabet: ReadonlySet<string>, locale: string): string {
  const phrase = term
    .normalize('NFC')
    .toLocaleUpperCase(locale)
    .replace(/[^\p{L}\p{N}' ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (phrase.length < MIN_PHRASE_CHARS || phrase.length > MAX_PHRASE_CHARS || phrase.split(' ').length > MAX_PHRASE_WORDS) return '';
  for (const ch of phrase) if (ch !== ' ' && !alphabet.has(ch)) return '';
  return phrase;
}

/** The `createStream(hotwords)` argument for these terms: unique phrases joined by '/', first ones first; '' for none. */
export function hotwordList(terms: Iterable<string>, alphabet: ReadonlySet<string>, locale: string): string {
  const phrases = new Set<string>();
  for (const term of terms) {
    if (phrases.size >= MAX_HOTWORDS) break;
    const phrase = hotwordPhrase(term, alphabet, locale);
    if (phrase) phrases.add(phrase);
  }
  return [...phrases].join('/');
}
