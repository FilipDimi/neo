import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { commitAll } from '../../src/git/commit.ts';
import { createFolder, publish } from '../../src/git/folder.ts';
import { isMerged, landOn, mergeInto } from '../../src/git/merge.ts';
import { fileAt, gitIn, gitRepo, refOf, tempDir } from '../helpers.ts';

const ada = { name: 'Ada', email: 'emp1@employees.invalid' };
const engine = { name: 'Engine', email: 'engine@employees.invalid' };

async function folder(repo: string, branch: string, startPoint = 'team'): Promise<string> {
  const dir = path.join(tempDir(), 'f');
  await createFolder({ repoPath: repo, dir, branch, startPoint });
  return dir;
}

async function work(repo: string, branch: string, files: Record<string, string>, startPoint = 'team'): Promise<string> {
  const dir = await folder(repo, branch, startPoint);
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
  await commitAll(dir, ada, `Work on ${branch}`);
  await publish(repo, dir, branch);
  return dir;
}

describe('mergeInto', () => {
  it("merges a published branch into the folder's branch", async () => {
    const repo = gitRepo();
    const parent = await folder(repo, 'task/parent');
    await work(repo, 'task/child-a', { 'A.md': 'a\n' });
    expect(await isMerged(parent, 'task/child-a')).toBe(false);
    const merged = await mergeInto(parent, 'task/child-a', engine);
    expect(merged).toMatchObject({ ok: true });
    expect(fs.existsSync(path.join(parent, 'A.md'))).toBe(true);
    expect(await isMerged(parent, 'task/child-a')).toBe(true);
    expect(gitIn(parent, 'log', '-1', '--format=%an')).toBe('Engine');
  });

  it('reports the conflicting files when it cannot, and leaves the merge for someone to resolve', async () => {
    const repo = gitRepo();
    const parent = await folder(repo, 'task/parent');
    await work(repo, 'task/child-a', { 'README.md': 'from a\n' });
    await work(repo, 'task/child-b', { 'README.md': 'from b\n' });
    expect(await mergeInto(parent, 'task/child-a', engine)).toMatchObject({ ok: true });
    expect(await mergeInto(parent, 'task/child-b', engine)).toEqual({ ok: false, conflicts: ['README.md'] });
    expect(fs.readFileSync(path.join(parent, 'README.md'), 'utf8')).toContain('<<<<<<<');
    // Resolved by editing the file; the engine's next commit completes the merge.
    fs.writeFileSync(path.join(parent, 'README.md'), 'from a and b\n');
    await commitAll(parent, ada, 'Resolve');
    expect(await isMerged(parent, 'task/child-b')).toBe(true);
  });
});

describe('landOn', () => {
  it('lands on a target nobody has checked out', async () => {
    const repo = gitRepo();
    const dir = await work(repo, 'task/x', { 'X.md': 'x\n' });
    expect(await landOn(repo, dir, 'task/x', 'team', engine)).toMatchObject({ result: 'landed', mergedTarget: false });
    expect(fileAt(repo, 'team', 'X.md')).toBe('x');
    expect(refOf(repo, 'main')).not.toBe(refOf(repo, 'team'));
    expect(fs.existsSync(path.join(repo, 'X.md'))).toBe(false);
  });

  it('fast-forwards a clean checkout of the target', async () => {
    const repo = gitRepo();
    const dir = await work(repo, 'task/x', { 'X.md': 'x\n' }, 'main');
    expect(await landOn(repo, dir, 'task/x', 'main', engine)).toMatchObject({ result: 'landed' });
    expect(fs.readFileSync(path.join(repo, 'X.md'), 'utf8')).toBe('x\n');
    expect(gitIn(repo, 'status', '--porcelain')).toBe('');
  });

  it('does not land on a dirty checkout', async () => {
    const repo = gitRepo();
    const dir = await work(repo, 'task/x', { 'X.md': 'x\n' }, 'main');
    fs.writeFileSync(path.join(repo, 'README.md'), 'my own uncommitted edit\n');
    const before = refOf(repo, 'main');
    expect(await landOn(repo, dir, 'task/x', 'main', engine)).toMatchObject({ result: 'checkout_dirty' });
    expect(refOf(repo, 'main')).toBe(before);
    expect(fs.readFileSync(path.join(repo, 'README.md'), 'utf8')).toBe('my own uncommitted edit\n');
  });

  it('takes in a target that moved since the task began, then lands', async () => {
    const repo = gitRepo();
    const dir = await work(repo, 'task/x', { 'X.md': 'x\n' });
    await work(repo, 'task/other', { 'OTHER.md': 'other\n' }).then((other) => landOn(repo, other, 'task/other', 'team', engine));
    expect(await landOn(repo, dir, 'task/x', 'team', engine)).toMatchObject({ result: 'landed', mergedTarget: true });
    expect(fileAt(repo, 'team', 'X.md')).toBe('x');
    expect(fileAt(repo, 'team', 'OTHER.md')).toBe('other');
  });

  it('stops with the conflicting files when the moved target conflicts', async () => {
    const repo = gitRepo();
    const dir = await work(repo, 'task/x', { 'README.md': 'from x\n' });
    await work(repo, 'task/other', { 'README.md': 'from other\n' }).then((other) => landOn(repo, other, 'task/other', 'team', engine));
    const before = refOf(repo, 'team');
    expect(await landOn(repo, dir, 'task/x', 'team', engine)).toEqual({ result: 'conflict', conflicts: ['README.md'] });
    expect(refOf(repo, 'team')).toBe(before);
  });
});
