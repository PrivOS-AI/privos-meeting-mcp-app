/**
 * Renders the small markdown subset Hub AI summaries use — `#` headings,
 * `-`/`*`/`1.` lists, `**bold**`, `*italic*`, `` `code` `` and paragraphs —
 * as React elements. No HTML is ever parsed or injected: anything else stays
 * literal text, so a summary can never smuggle markup into the app.
 */
import type { ReactNode } from 'react';

type Block =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'paragraph'; text: string };

const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^\s*[-*•]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;

export function parseBlocks(source: string): Block[] {
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) blocks.push({ kind: 'paragraph', text: paragraph.join(' ') });
    paragraph = [];
  };
  for (const raw of source.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trimEnd();
    const heading = HEADING.exec(line.trim());
    const bullet = BULLET.exec(line);
    const numbered = bullet ? null : NUMBERED.exec(line);
    if (!line.trim()) {
      flush();
    } else if (heading) {
      flush();
      blocks.push({ kind: 'heading', level: heading[1].length, text: heading[2].replace(/\s*#+$/, '') });
    } else if (bullet || numbered) {
      flush();
      const ordered = Boolean(numbered);
      const text = (bullet ?? numbered)![1];
      const last = blocks.at(-1);
      if (last?.kind === 'list' && last.ordered === ordered) last.items.push(text);
      else blocks.push({ kind: 'list', ordered, items: [text] });
    } else {
      paragraph.push(line.trim());
    }
  }
  flush();
  return blocks;
}

const INLINE = /(\*\*[^*]+\*\*|__[^_]+__|`[^`]+`|\*[^*\s][^*]*\*)/g;

export function renderInline(text: string): ReactNode[] {
  return text.split(INLINE).map((part, i) => {
    if (/^(\*\*|__).+\1$/.test(part)) return <strong key={i}>{part.slice(2, -2)}</strong>;
    if (/^`.+`$/.test(part)) return <code key={i}>{part.slice(1, -1)}</code>;
    if (/^\*.+\*$/.test(part)) return <em key={i}>{part.slice(1, -1)}</em>;
    return part;
  });
}

export function MarkdownText({ source, className }: { source: string; className?: string }) {
  return (
    <div className={className ? `ma-markdown ${className}` : 'ma-markdown'}>
      {parseBlocks(source).map((block, i) => {
        if (block.kind === 'heading') return <h4 key={i} className={`ma-markdown__h ma-markdown__h--${Math.min(block.level, 3)}`}>{renderInline(block.text)}</h4>;
        if (block.kind === 'list') {
          const items = block.items.map((item, j) => <li key={j}>{renderInline(item)}</li>);
          return block.ordered ? <ol key={i}>{items}</ol> : <ul key={i}>{items}</ul>;
        }
        return <p key={i}>{renderInline(block.text)}</p>;
      })}
    </div>
  );
}
