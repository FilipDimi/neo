/**
 * What is in a folder, exactly: the tree git would commit if everything in it were committed now (what the
 * repository ignores aside), as one hash. Two moments with the same hash hold the same files with the same contents.
 * The folder's own index is not touched: the files are staged into a copy of it.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { git } from './git.ts';

function withIndex(cwd: string, index: string, args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'advice.addEmbeddedRepo=false', ...args], { cwd, env: { ...process.env, GIT_INDEX_FILE: index, GIT_TERMINAL_PROMPT: '0' }, maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => {
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, out: String(stdout).trim() });
    });
  });
}

/** Null when the folder is not a repository, or git could not say: the caller then knows nothing, and must not guess. */
export async function treeOf(dir: string): Promise<string | null> {
  // Only a folder that is itself a repository: one that merely sits inside another has no tree of its own.
  if (!fs.existsSync(path.join(dir, '.git'))) return null;
  const found = await git(dir, ['rev-parse', '--absolute-git-dir']);
  if (found.code !== 0) return null;
  const index = path.join(os.tmpdir(), `vs-index-${randomUUID()}`);
  try {
    // Starting from the folder's own index keeps this as cheap as a status: only what changed is read again.
    const own = path.join(found.out, 'index');
    if (fs.existsSync(own)) fs.copyFileSync(own, index);
    if ((await withIndex(dir, index, ['add', '-A'])).code !== 0) return null;
    const tree = await withIndex(dir, index, ['write-tree']);
    return tree.code === 0 && /^[0-9a-f]{40,64}$/.test(tree.out) ? tree.out : null;
  } finally {
    fs.rmSync(index, { force: true });
    fs.rmSync(`${index}.lock`, { force: true });
  }
}
