import type { CSSProperties, ReactNode } from 'react';
import './prose.css';

/**
 * What a person or an employee wrote, shown the way it was meant. Employees write Markdown, and its
 * marks are noise when they are printed as they are. Paragraphs, lists, headings, quotes, tables,
 * code, bold, italic and web links are understood; anything else stays as it was typed. Nothing in
 * the text is ever treated as HTML.
 */
export function Prose({ text, className }: { text: string; className?: string }) {
  const name = className ? `prose ${className}` : 'prose';
  // What someone wrote is never a reason for the page to go blank: text that cannot be laid out is shown as it was typed.
  let laid: ReactNode[];
  try {
    laid = blocks(text.replace(/\r\n?/g, '\n').split('\n'));
  } catch {
    laid = [<p key="plain">{text}</p>];
  }
  return <div className={name}>{laid}</div>;
}

// Three backticks open a block only when the line has no backtick after them: "```npm test``` passed" is a sentence with code in it.
const FENCE = /^ {0,3}(`{3,}(?![^\n]*`)|~{3,})/;
/** How deep quotes and lists are followed. Past this the text is shown as it was typed: nobody writes that deep, and a page must not fall over on one that does. */
const DEPTH = 8;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const RULE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const ITEM = /^( *)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const QUOTE = /^ {0,3}>\s?(.*)$/;
const TABLE_RULE = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;
const HEADINGS = ['h3', 'h4', 'h5'] as const; // under the page's own headings, whatever the writer chose

const indentOf = (line: string): number => line.length - line.trimStart().length;
const cells = (row: string): string[] =>
  row
    .trim()
    .replace(/^\||\|$/g, '')
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim().replaceAll('\\|', '|'));
const tableAt = (lines: string[], at: number): boolean => {
  const [head, rule] = [lines[at]!, lines[at + 1]];
  return rule !== undefined && head.includes('|') && rule.includes('|') && TABLE_RULE.test(rule) && cells(head).length === cells(rule).length;
};
/** Whether a line begins something other than a paragraph, so a paragraph before it ends there. */
const startsBlock = (lines: string[], at: number): boolean => [FENCE, HEADING, RULE, ITEM, QUOTE].some((shape) => shape.test(lines[at]!)) || tableAt(lines, at);

function blocks(lines: string[], depth = 0): ReactNode[] {
  const out: ReactNode[] = [];
  let at = 0;
  while (at < lines.length) {
    const line = lines[at]!;
    const key = out.length;
    if (!line.trim()) {
      at++;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const closing = new RegExp(`^ {0,3}${fence[1]![0]}{${fence[1]!.length},}\\s*$`);
      let end = at + 1;
      while (end < lines.length && !closing.test(lines[end]!)) end++; // a fence that is never closed runs to the end
      out.push(
        <pre key={key}>
          <code>{lines.slice(at + 1, end).join('\n')}</code>
        </pre>,
      );
      at = end + 1;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      const Tag = HEADINGS[Math.min(heading[1]!.length, HEADINGS.length) - 1]!;
      out.push(<Tag key={key}>{inline(heading[2]!)}</Tag>);
      at++;
      continue;
    }

    if (RULE.test(line)) {
      out.push(<hr key={key} />);
      at++;
      continue;
    }

    if (QUOTE.test(line) && depth < DEPTH) {
      const quoted: string[] = [];
      for (; at < lines.length && QUOTE.test(lines[at]!); at++) quoted.push(QUOTE.exec(lines[at]!)![1]!);
      out.push(<blockquote key={key}>{blocks(quoted, depth + 1)}</blockquote>);
      continue;
    }

    if (tableAt(lines, at)) {
      const head = cells(line);
      const aligned = cells(lines[at + 1]!).map((rule): CSSProperties | undefined => (rule.endsWith(':') ? { textAlign: rule.startsWith(':') ? 'center' : 'right' } : undefined));
      const rows: string[][] = [];
      for (at += 2; at < lines.length && lines[at]!.includes('|'); at++) rows.push(cells(lines[at]!));
      out.push(
        <div key={key} className="prose-table">
          <table>
            <thead>
              <tr>
                {head.map((cell, column) => (
                  <th key={column} style={aligned[column]}>
                    {inline(cell)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={index}>
                  {head.map((_, column) => (
                    <td key={column} style={aligned[column]}>
                      {inline(row[column] ?? '')}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    const first = ITEM.exec(line);
    if (first) {
      const indent = first[1]!.length;
      const numbered = /\d/.test(first[2]!);
      // A line of this list: the same kind of mark, no deeper than one space past the first.
      const sibling = (index: number): RegExpExecArray | null => {
        const item = ITEM.exec(lines[index]!);
        return item && !RULE.test(lines[index]!) && item[1]!.length >= indent && item[1]!.length < indent + 2 && /\d/.test(item[2]!) === numbered ? item : null;
      };
      const under = (index: number): boolean => indentOf(lines[index]!) >= indent + 2; // belongs to the item above it
      const items: string[][] = [];
      let width = indent + 2; // how far in the current item's own words begin
      while (at < lines.length) {
        const item = sibling(at);
        if (item) {
          items.push([item[3]!]);
          width = item[1]!.length + item[2]!.length + 1;
          at++;
        } else if (!lines[at]!.trim()) {
          // A gap stays inside the list only when the list goes on after it.
          let next = at;
          while (next < lines.length && !lines[next]!.trim()) next++;
          if (next === lines.length || !(sibling(next) || under(next))) break;
          if (under(next)) items.at(-1)!.push('');
          at = next;
        } else if (under(at)) {
          items.at(-1)!.push(lines[at]!.slice(Math.min(indentOf(lines[at]!), width)));
          at++;
        } else break;
      }
      const List = numbered ? 'ol' : 'ul';
      const start = numbered ? Number.parseInt(first[2]!, 10) : 1;
      out.push(
        <List key={key} {...(start !== 1 ? { start } : {})}>
          {items.map((body, index) => {
            // The item's own words run until a gap or something that is not a paragraph; the rest sits under them.
            let own = 1;
            while (own < body.length && body[own]!.trim() && !startsBlock(body, own)) own++;
            return (
              <li key={index}>
                {inline(
                  body
                    .slice(0, own)
                    .map((part) => part.trim())
                    .join('\n'),
                )}
                {blocks(body.slice(own), depth + 1)}
              </li>
            );
          })}
        </List>,
      );
      continue;
    }

    const said: string[] = [];
    do said.push(lines[at++]!.trim());
    while (at < lines.length && lines[at]!.trim() && !startsBlock(lines, at));
    out.push(<p key={key}>{inline(said.join('\n'))}</p>);
  }
  return out;
}

/**
 * One alternative per kind of mark, tried at each place in this order. A mark that never closes
 * matches nothing and so stays as it was typed.
 */
const INLINE = new RegExp(
  [
    /\\([\\`*_{}[\]()#+\-.!~|>])/, // 1: a mark someone escaped
    /(`+)([\s\S]*?[^`])\2(?!`)/, // 2, 3: code
    /\[((?:[^[\]\\]|\\.)+)\]\(([^()\s]+(?:\([^()\s]*\)[^()\s]*)*)\)/, // 4, 5: a link with its words
    /(https?:\/\/[^\s<>`]*[^\s<>`.,;:!?'")\]*_~])/, // 6: a bare address, without the punctuation after it
    /\*\*(?=\S)([\s\S]*?\S)\*\*/, // 7: bold
    /(?<![A-Za-z0-9_])__(?=\S)([\s\S]*?\S)__(?![A-Za-z0-9_])/, // 8: bold
    /~~(?=\S)([\s\S]*?\S)~~/, // 9: struck out
    /\*(?=[^\s*])([^*]*?[^\s*])\*(?!\*)/, // 10: italic
    /(?<![A-Za-z0-9_])_(?=[^\s_])([^_]*?[^\s_])_(?![A-Za-z0-9_])/, // 11: italic, never inside a_name_like_this
  ]
    .map((shape) => shape.source)
    .join('|'),
  'g',
);
const WEB = /^(?:https?:\/\/|mailto:)/i; // the only places a link may lead

function inline(text: string, links = true): ReactNode[] {
  const out: ReactNode[] = [];
  let at = 0;
  for (const found of text.matchAll(INLINE)) {
    if (found.index > at) out.push(text.slice(at, found.index));
    at = found.index + found[0].length;
    const key = out.length;
    const [, escaped, ticks, code, words, href, bare, bold, bold2, struck, italic, italic2] = found;
    const link = (to: string, shown: ReactNode) =>
      links && WEB.test(to) ? (
        <a key={key} href={to} target="_blank" rel="noreferrer">
          {shown}
        </a>
      ) : (
        found[0]
      );
    if (escaped !== undefined) out.push(escaped);
    else if (ticks !== undefined) out.push(<code key={key}>{code!.replace(/^ (.*\S.*) $/s, '$1')}</code>);
    else if (href !== undefined) out.push(link(href, inline(words!, false)));
    else if (bare !== undefined) out.push(link(bare, bare));
    else if ((bold ?? bold2) !== undefined) out.push(<strong key={key}>{inline((bold ?? bold2)!, links)}</strong>);
    else if (struck !== undefined) out.push(<del key={key}>{inline(struck, links)}</del>);
    else out.push(<em key={key}>{inline((italic ?? italic2)!, links)}</em>);
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}
