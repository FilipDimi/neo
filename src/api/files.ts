/**
 * What a task wrote in its folder, for a task that has no repository to diff against: a research
 * brief, a note, a draft. Small text files come with their text; anything else is listed with its
 * size. A link is never followed, so nothing outside the folder can be shown through it.
 */
import fs from 'node:fs';
import path from 'node:path';

const FILES_SHOWN = 30;
const TEXT_SHOWN_BYTES = 200_000;
const DEPTH = 6;
const NOT_WORK = new Set(['.git', 'node_modules', 'target', '.build', 'DerivedData', '.DS_Store']);

export type WrittenFile = { path: string; bytes: number; text: string | null };

export function writtenFiles(root: string): { files: WrittenFile[]; more: number } {
  const found: string[] = [];
  const walk = (dir: string, depth: number): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // The folder is not there yet: the task has not started.
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (NOT_WORK.has(entry.name) || entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && depth < DEPTH) walk(full, depth + 1);
      else if (entry.isFile()) found.push(path.relative(root, full));
    }
  };
  walk(root, 0);
  found.sort();

  const files = found.slice(0, FILES_SHOWN).map((relative): WrittenFile => {
    const full = path.join(root, relative);
    const bytes = fs.statSync(full).size;
    if (bytes > TEXT_SHOWN_BYTES) return { path: relative, bytes, text: null };
    const content = fs.readFileSync(full);
    return { path: relative, bytes, text: content.includes(0) ? null : content.toString('utf8') };
  });
  return { files, more: Math.max(0, found.length - FILES_SHOWN) };
}
