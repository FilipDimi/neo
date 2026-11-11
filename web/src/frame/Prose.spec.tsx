import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Prose } from './Prose.tsx';

const html = (text: string): string => render(<Prose text={text} />).container.querySelector('.prose')!.innerHTML;

describe('Prose', () => {
  it('shows bold, italic, struck and code as what they are, not as their marks', () => {
    expect(html('**Where it stands:** I can *only* use `boards` that ~~might~~ exist.')).toBe('<p><strong>Where it stands:</strong> I can <em>only</em> use <code>boards</code> that <del>might</del> exist.</p>');
  });

  it('keeps paragraphs apart, and the line breaks someone typed inside one', () => {
    expect(html('First line\nsecond line\n\nNext paragraph.')).toBe('<p>First line\nsecond line</p><p>Next paragraph.</p>');
  });

  it('makes lists of list lines, numbered ones from their own first number', () => {
    expect(html('To do:\n- remove **product**\n- add iOS\n\n3. first\n4. second')).toBe('<p>To do:</p><ul><li>remove <strong>product</strong></li><li>add iOS</li></ul><ol start="3"><li>first</li><li>second</li></ol>');
  });

  it('nests what is indented under a list line', () => {
    expect(html('- web team\n  - a lead\n  - 2 engineers\n- data team')).toBe('<ul><li>web team<ul><li>a lead</li><li>2 engineers</li></ul></li><li>data team</li></ul>');
  });

  it('shows headings, quotes and rules', () => {
    expect(html('# Plan\n## Step one\n> said before\n\n---\nafter')).toBe('<h3>Plan</h3><h4>Step one</h4><blockquote><p>said before</p></blockquote><hr><p>after</p>');
  });

  it('leaves a fenced block exactly as written', () => {
    expect(html('Run:\n```bash\nnpm test -- **/*.ts\n\n  echo _done_\n```\nthen stop')).toBe('<p>Run:</p><pre><code>npm test -- **/*.ts\n\n  echo _done_</code></pre><p>then stop</p>');
    expect(html('```\nnever closed')).toBe('<pre><code>never closed</code></pre>');
  });

  it('lays a table out as a table', () => {
    const table = render(<Prose text={'| Team | People |\n|---|---:|\n| iOS | **3** |\n| Design | 2 |'} />).container.querySelector('table')!;
    expect([...table.querySelectorAll('th')].map((cell) => cell.textContent)).toEqual(['Team', 'People']);
    expect([...table.querySelectorAll('tbody tr')].map((row) => [...row.querySelectorAll('td')].map((cell) => cell.innerHTML))).toEqual([
      ['iOS', '<strong>3</strong>'],
      ['Design', '2'],
    ]);
  });

  it('opens web links in a new tab, and makes no link of anything else', () => {
    const { container } = render(<Prose text={'See [the docs](https://example.com/a_b) or https://example.com/x. Not [this](javascript:alert(1)).'} />);
    const links = [...container.querySelectorAll('a')];
    expect(links.map((link) => [link.textContent, link.getAttribute('href'), link.target, link.rel])).toEqual([
      ['the docs', 'https://example.com/a_b', '_blank', 'noreferrer'],
      ['https://example.com/x', 'https://example.com/x', '_blank', 'noreferrer'],
    ]);
    expect(container.textContent).toContain('[this](javascript:alert(1))');
  });

  it('never treats text as markup, and leaves names with underscores and lone stars alone', () => {
    expect(html('<img src=x onerror=alert(1)> in task_drawer_spec.ts, 2 * 3 * 4, \\*not italic\\*')).toBe('<p>&lt;img src=x onerror=alert(1)&gt; in task_drawer_spec.ts, 2 * 3 * 4, *not italic*</p>');
  });

  it('shows marks that never close as they were typed', () => {
    expect(html('a ** b and `c and [d](e')).toBe('<p>a ** b and `c and [d](e</p>');
  });

  it('reads code in three backticks on one line as code in a sentence, not as the start of a block', () => {
    const { container } = render(<Prose text={'```npm test``` passed\nAll good.\n\nSecond paragraph.'} />);
    expect(container.querySelector('pre')).toBeNull();
    expect(container.textContent).toContain('npm test');
    expect(container.textContent).toContain('passed');
    expect([...container.querySelectorAll('p')].map((p) => p.textContent)).toContain('Second paragraph.');
  });

  it('shows text it cannot lay out as plain text rather than taking the page down', () => {
    const deep = `${'>'.repeat(6000)} said`;
    const { container } = render(<Prose text={deep} />);
    expect(container.textContent).toContain('said');
  });
});
