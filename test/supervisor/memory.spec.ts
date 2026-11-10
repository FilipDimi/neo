import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readIndex, remember } from '../../src/supervisor/memory.ts';
import { plus, T0, tempDir } from '../helpers.ts';

describe('memory', () => {
  it('creates an empty index on first read', () => {
    const dir = path.join(tempDir(), 'ada');
    expect(readIndex(dir)).toBe('');
    expect(fs.existsSync(path.join(dir, 'index.md'))).toBe(true);
  });

  it('caps the index on a character boundary and names the cap in the marker', () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'index.md'), 'é'.repeat(100));
    const capped = readIndex(dir, 51);
    expect(capped).toBe(`${'é'.repeat(25)}\n… (index capped at 51 bytes)`);
  });

  it('remember adds a dated note and a line to the index', () => {
    const dir = tempDir();
    remember(dir, 'Docked the glass row.\nDetails follow.', T0);
    remember(dir, 'Fixed the roster client.', plus(T0, 3600));
    const notes = fs.readdirSync(path.join(dir, 'notes')).sort();
    expect(notes).toHaveLength(2);
    expect(notes[0]).toMatch(/^2026-11-09T18-00-00/);
    expect(fs.readFileSync(path.join(dir, 'notes', notes[0]!), 'utf8')).toContain('Details follow.');
    expect(readIndex(dir).split('\n')).toEqual(['- 2026-11-09: Docked the glass row.', '- 2026-11-09: Fixed the roster client.']);
  });

  it('drops the oldest lines once the index passes the cap', () => {
    const dir = tempDir();
    for (let i = 0; i < 30; i++) remember(dir, `Note number ${i} with some length to it.`, plus(T0, i), 400);
    const index = readIndex(dir, 400);
    expect(Buffer.byteLength(index)).toBeLessThanOrEqual(400);
    expect(index).toContain('Note number 29');
    expect(index).not.toContain('Note number 0 ');
  });
});
