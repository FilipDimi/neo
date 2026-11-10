/**
 * An employee's memory: a folder with a one-page index read at the start of every run, and a
 * dated note per finished run. The supervisor writes it and caps it; the employee only reads it.
 */
import fs from 'node:fs';
import path from 'node:path';

export const MEMORY_CAP_BYTES = 8192;

export function readIndex(dir: string, capBytes = MEMORY_CAP_BYTES): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'index.md');
  if (!fs.existsSync(file)) fs.writeFileSync(file, '');
  const bytes = fs.readFileSync(file);
  if (bytes.length <= capBytes) return bytes.toString('utf8').trimEnd();
  let cut = capBytes;
  while (cut > 0 && (bytes[cut]! & 0xc0) === 0x80) cut -= 1; // never cut inside a character
  return `${bytes.subarray(0, cut).toString('utf8')}\n… (index capped at ${capBytes} bytes)`;
}

/** Keeps what a finished run reported: the whole summary as a note, its first line in the index. */
export function remember(dir: string, summary: string, now: Date, capBytes = MEMORY_CAP_BYTES): void {
  const notes = path.join(dir, 'notes');
  fs.mkdirSync(notes, { recursive: true });
  const stamp = now.toISOString();
  fs.writeFileSync(path.join(notes, `${stamp.replace(/:/g, '-')}.md`), `${summary.trim()}\n`);
  const headline = summary.trim().split('\n')[0]!.slice(0, 160);
  const file = path.join(dir, 'index.md');
  const lines = (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '').split('\n').filter(Boolean);
  lines.push(`- ${stamp.slice(0, 10)}: ${headline}`);
  while (lines.length > 1 && Buffer.byteLength(lines.join('\n')) > capBytes) lines.shift(); // the oldest goes first
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
}
