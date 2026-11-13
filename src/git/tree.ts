/**
 * What is in a folder, exactly: the tree git would commit if everything in it were committed now (what the
 * repository ignores aside), as one hash. Two moments with the same hash hold the same files with the same contents.
 * Nothing of the folder is touched: the files are staged into a copy of its index, and what git writes while it
 * hashes them goes to a throwaway place, not into the folder's own git directory.
 */
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertOwnGitDir, git } from './git.ts';

/**
 * Null when the engine cannot say: the folder is not a repository of the engine's making (or its settings were changed
 * since), git failed, or a repository of its own sits inside it, whose files would not show. The caller then knows
 * nothing, and must not take two nulls for the same.
 */
export async function treeOf(dir: string): Promise<string | null> {
  // The engine runs git only where nothing in the folder can make it start a program: the same guard as for a commit.
  try {
    assertOwnGitDir(dir);
  } catch {
    return null;
  }
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-tree-'));
  try {
    const own = path.join(dir, '.git');
    const index = path.join(scratch, `index-${randomUUID()}`);
    // Starting from the folder's own index keeps this as cheap as a status: only what changed is read again.
    if (fs.existsSync(path.join(own, 'index'))) fs.copyFileSync(path.join(own, 'index'), index);
    fs.mkdirSync(path.join(scratch, 'objects'));
    const env = { GIT_INDEX_FILE: index, GIT_OBJECT_DIRECTORY: path.join(scratch, 'objects'), GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(own, 'objects') };
    const added = await git(dir, ['add', '-A'], undefined, env);
    if (added.code !== 0 || /adding embedded git repository/.test(added.out)) return null;
    const tree = await git(dir, ['write-tree'], undefined, env);
    return tree.code === 0 && /^[0-9a-f]{40,64}$/.test(tree.out) ? tree.out : null;
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

const HEAVY = new Set(['.git', 'node_modules', 'target', '.build', 'DerivedData']);
const PRINT_CAP = 20_000;

/**
 * A print of any folder, for where there is no tree to go by: the names, sizes and times of what is in it. Coarser than
 * a tree (a file put back as it was looks new), and good for one question only: did anything change here.
 */
export function printOf(dir: string): string {
  const hash = createHash('sha1');
  let seen = 0;
  const walk = (relative: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(dir, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return;
    }
    for (const entry of entries) {
      if (seen++ >= PRINT_CAP) return;
      const at = path.join(relative, entry.name);
      const stat = fs.lstatSync(path.join(dir, at), { throwIfNoEntry: false });
      hash.update(`${at}\0${stat?.size ?? 0}\0${stat?.mtimeMs ?? 0}\n`);
      // What is built or fetched is not looked into: its own entry says when it last changed.
      if (entry.isDirectory() && !HEAVY.has(entry.name)) walk(at);
    }
  };
  walk('');
  return `print:${hash.digest('hex')}`;
}
