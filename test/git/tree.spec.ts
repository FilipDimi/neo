import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { recordGitSettings } from '../../src/git/git.ts';
import { printOf, treeOf } from '../../src/git/tree.ts';
import { gitIn, gitRepo, tempDir } from '../helpers.ts';

const objects = (dir: string): number => (fs.readdirSync(path.join(dir, '.git/objects'), { recursive: true }) as string[]).length;

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

  it('starts no program a folder\'s settings name, and says nothing of a folder whose settings were changed', async () => {
    const dir = gitRepo([], { 'a.txt': 'one\n' });
    recordGitSettings(dir);
    const marker = path.join(tempDir('vs-marker-'), 'ran');
    // After the engine made the folder, someone working in it names a program for git to run on every file.
    gitIn(dir, 'config', 'filter.mark.clean', `sh -c 'touch ${marker}; cat'`);
    fs.writeFileSync(path.join(dir, '.gitattributes'), '* filter=mark\n');
    fs.writeFileSync(path.join(dir, 'b.txt'), 'new\n');
    expect(await treeOf(dir)).toBeNull();
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('leaves nothing behind in the folder\'s own git directory', async () => {
    const dir = gitRepo([], { 'a.txt': 'one\n' });
    const before = objects(dir);
    fs.writeFileSync(path.join(dir, 'big.txt'), 'x'.repeat(50_000));
    const first = await treeOf(dir);
    fs.writeFileSync(path.join(dir, 'big.txt'), 'y'.repeat(50_000));
    expect(await treeOf(dir)).not.toBe(first);
    expect(objects(dir)).toBe(before);
  });

  it('says nothing where a repository of its own sits inside: what is in there would not show', async () => {
    const dir = gitRepo([], { 'a.txt': 'one\n' });
    fs.mkdirSync(path.join(dir, 'inner'));
    gitIn(path.join(dir, 'inner'), 'init', '-q');
    fs.writeFileSync(path.join(dir, 'inner/file.txt'), 'x\n');
    expect(await treeOf(dir)).toBeNull();
  });

  it('has a print for any folder: names, sizes and times, for where there is no tree', () => {
    const dir = tempDir('vs-plain-');
    const empty = printOf(dir);
    expect(printOf(dir)).toBe(empty);
    fs.writeFileSync(path.join(dir, 'notes.md'), 'one\n');
    const one = printOf(dir);
    expect(one).not.toBe(empty);
    fs.mkdirSync(path.join(dir, 'deep/er'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'deep/er/more.md'), 'two\n');
    expect(printOf(dir)).not.toBe(one);
    expect(printOf('/nonexistent/folder')).toBe(printOf('/nonexistent/other'));
  });

  it('says nothing about a folder that is no repository', async () => {
    expect(await treeOf(tempDir('vs-plain-'))).toBeNull();
    expect(await treeOf('/nonexistent/folder')).toBeNull();
  });
});
