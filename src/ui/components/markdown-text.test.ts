import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';

import { MarkdownText, parseBlocks } from './markdown-text.js';

const html = (source: string) => renderToStaticMarkup(createElement(MarkdownText, { source }));

describe('MarkdownText', () => {
  it('splits a Hub AI summary into headings, lists and paragraphs', () => {
    expect(parseBlocks('## Tóm tắt\nNhóm thống nhất.\nPhát hành thứ Sáu.\n\n## Quyết định\n- Một\n- Hai\n1. Ba')).toEqual([
      { kind: 'heading', level: 2, text: 'Tóm tắt' },
      { kind: 'paragraph', text: 'Nhóm thống nhất. Phát hành thứ Sáu.' },
      { kind: 'heading', level: 2, text: 'Quyết định' },
      { kind: 'list', ordered: false, items: ['Một', 'Hai'] },
      { kind: 'list', ordered: true, items: ['Ba'] },
    ]);
  });

  it('renders bold, italic and code inline', () => {
    expect(html('**Chốt** thứ *Sáu* với `v1.1`')).toBe('<div class="ma-markdown"><p><strong>Chốt</strong> thứ <em>Sáu</em> với <code>v1.1</code></p></div>');
  });

  it('never turns summary text into markup', () => {
    const out = html('<img src=x onerror=alert(1)> **<b>x</b>**');
    expect(out).not.toContain('<img');
    expect(out).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(out).toContain('<strong>&lt;b&gt;x&lt;/b&gt;</strong>');
  });
});
