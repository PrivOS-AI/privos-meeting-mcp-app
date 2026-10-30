import { afterEach, describe, expect, it, vi } from 'vitest';

import { copyText } from './copy-text.js';

/** The bits of `document` copyText touches, recording what `execCommand('copy')` would have copied. */
function fakeDocument(execResult: boolean) {
  const copied: string[] = [];
  let selected = '';
  const doc = {
    activeElement: null,
    body: { appendChild: () => undefined },
    createElement: () => ({
      value: '',
      style: {},
      setAttribute: () => undefined,
      select() {
        selected = this.value;
      },
      remove: () => undefined,
    }),
    execCommand: (command: string) => {
      if (command === 'copy' && execResult) copied.push(selected);
      return execResult;
    },
  };
  vi.stubGlobal('document', doc);
  return copied;
}

describe('copyText', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('uses the Clipboard API when the page may', async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const copied = fakeDocument(true);
    await expect(copyText('https://hub/x')).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith('https://hub/x');
    expect(copied).toEqual([]);
  });

  it("falls back to execCommand('copy') when the Hub's permissions policy blocks the Clipboard API", async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: async () => { throw new Error('The Clipboard API has been blocked because of a permissions policy'); } } });
    const copied = fakeDocument(true);
    await expect(copyText('https://hub/x')).resolves.toBe(true);
    expect(copied).toEqual(['https://hub/x']);
  });

  it('says so when neither works, so the caller shows the text to copy by hand', async () => {
    vi.stubGlobal('navigator', {});
    fakeDocument(false);
    await expect(copyText('https://hub/x')).resolves.toBe(false);
  });
});
