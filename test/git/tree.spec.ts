import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { treeOf } from '../../src/git/tree.ts';
import { gitIn, gitRepo, tempDir } from '../helpers.ts';

describe('the tree of a folder', () => {
  it('is the same for the same files, and new for one changed, added or removed', async () => {
    const dir = gitRepo([], { 'a.txt': 'one\n', '.gitignore': 'build/\n' });
    const first = await treeOf(dir);
    expect(first).toMatch(/^[0-9a-f]{40}$/);
    expect(await treeOf(dir)).toBe(first);
    // It is what a commit of everything would hold.
    expect(first).toBe(gitIn(dir, 'rev-parse', 'HEAD^{tree}'));

    fs.writeFileSync(path.join(dir, 'a.txt'), 'two\n');
    const changed = await treeOf(dir);
    expect(changed).not.toBe(first);
    fs.writeFileSync(path.join(dir, 'b.txt'), 'new\n');
    const added = await treeOf(dir);
    expect(added).not.toBe(changed);
    fs.rmSync(path.join(dir, 'b.txt'));
    expect(await treeOf(dir)).toBe(changed);
    // Back to what it was: the same tree as at the start.
    fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
    expect(await treeOf(dir)).toBe(first);
  });

  it('leaves ignored files aside, and does not touch what is staged', async () => {
    const dir = gitRepo([], { 'a.txt': 'one\n', '.gitignore': 'build/\n' });
    const first = await treeOf(dir);
    fs.mkdirSync(path.join(dir, 'build'));
    fs.writeFileSync(path.join(dir, 'build/out.bin'), 'x');
    expect(await treeOf(dir)).toBe(first);
    fs.writeFileSync(path.join(dir, 'c.txt'), 'c\n');
    await treeOf(dir);
    expect(gitIn(dir, 'status', '--porcelain')).toBe('?? c.txt');
  });

  it('says nothing about a folder that is no repository', async () => {
    expect(await treeOf(tempDir('vs-plain-'))).toBeNull();
    expect(await treeOf('/nonexistent/folder')).toBeNull();
  });
});
