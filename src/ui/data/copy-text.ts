/**
 * Copies text to the clipboard from inside the Hub's sandboxed iframe. The
 * async Clipboard API needs the `clipboard-write` permission policy, which
 * the Hub does not delegate to app iframes ("The Clipboard API has been
 * blocked because of a permissions policy"), so when it refuses, the older
 * `execCommand('copy')` on a selected hidden textarea is tried — browsers
 * allow it from a click without that policy. Resolves `false` when neither
 * worked; the caller then shows the text for the person to copy.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Blocked by the permissions policy (or no Clipboard API): fall back below.
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  area.style.pointerEvents = 'none';
  document.body.appendChild(area);
  const active = document.activeElement as HTMLElement | null;
  area.select();
  let copied = false;
  try {
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  }
  area.remove();
  active?.focus?.();
  return copied;
}
