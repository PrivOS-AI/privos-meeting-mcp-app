/**
 * Meeting folder + file naming. The Files upload is an upsert by (channel, path)
 * (file-management/stable-file-id-and-replace-semantics.md), so two meetings in
 * the same room on the same day with the same title would overwrite each other.
 * Every meeting folder therefore ends in an 8-char meeting id, and each part
 * file repeats it — see `folderName`/`partFileName` (QĐ / FM F8, S2-10).
 */

const VIETNAMESE_MAP: Record<string, string> = {
  à: 'a', á: 'a', ả: 'a', ã: 'a', ạ: 'a', ă: 'a', ằ: 'a', ắ: 'a', ẳ: 'a', ẵ: 'a', ặ: 'a',
  â: 'a', ầ: 'a', ấ: 'a', ẩ: 'a', ẫ: 'a', ậ: 'a',
  è: 'e', é: 'e', ẻ: 'e', ẽ: 'e', ẹ: 'e', ê: 'e', ề: 'e', ế: 'e', ể: 'e', ễ: 'e', ệ: 'e',
  ì: 'i', í: 'i', ỉ: 'i', ĩ: 'i', ị: 'i',
  ò: 'o', ó: 'o', ỏ: 'o', õ: 'o', ọ: 'o', ô: 'o', ồ: 'o', ố: 'o', ổ: 'o', ỗ: 'o', ộ: 'o',
  ơ: 'o', ờ: 'o', ớ: 'o', ở: 'o', ỡ: 'o', ợ: 'o',
  ù: 'u', ú: 'u', ủ: 'u', ũ: 'u', ụ: 'u', ư: 'u', ừ: 'u', ứ: 'u', ử: 'u', ữ: 'u', ự: 'u',
  ỳ: 'y', ý: 'y', ỷ: 'y', ỹ: 'y', ỵ: 'y',
  đ: 'd',
};

/** Strip Vietnamese diacritics and lowercase, one code point at a time. */
function removeDiacritics(input: string): string {
  let out = '';
  for (const ch of input.toLowerCase()) out += VIETNAMESE_MAP[ch] ?? ch;
  // Also fold any remaining combining marks (e.g. non-VN accents).
  return out.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/**
 * URL/file-safe slug from a meeting title. Empty or all-symbol titles fall back
 * to `meeting` so a folder name is never blank.
 */
export function slugify(title: string): string {
  const slug = removeDiacritics(title || '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return slug || 'meeting';
}

/** `YYYY-MM-DD` in UTC for a folder-name date prefix. */
export function isoDate(date: Date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

/** First 8 chars of a meeting id, the collision guard baked into folder + part names. */
export function meetingId8(meetingId: string): string {
  return meetingId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) || '00000000';
}

/** `Meetings/<yyyy-mm-dd>-<slug>-<meetingId8>` folder path (no trailing slash). */
export function folderName(title: string, meetingId: string, date: Date = new Date()): string {
  return `Meetings/${isoDate(date)}-${slugify(title)}-${meetingId8(meetingId)}`;
}

/** `audio.part-NNNN-<meetingId8>.webm` — never uploaded with `replace`. */
export function partFileName(seq: number, meetingId: string): string {
  return `audio.part-${String(seq).padStart(4, '0')}-${meetingId8(meetingId)}.webm`;
}
