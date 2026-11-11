import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { changedFiles, commitAll, diffStat, patch } from '../../src/git/commit.ts';
import { branchName, createFolder, publish, removeFolder } from '../../src/git/folder.ts';
import { fileAt, gitIn, gitRepo, refOf, task, tempDir } from '../helpers.ts';

const ada = { name: 'Ada', email: 'emp1@employees.invalid' };
const folderFor = async (repo: string, branch = 'task/x-aaaaaa', startPoint = 'team') => {
  const dir = path.join(tempDir(), 'folder');
  await createFolder({ repoPath: repo, dir, branch, startPoint });
  return dir;
};

describe('task folders', () => {
  it('gives two tasks with one title distinct folders and branches', () => {
    const a = branchName(task({ id: 'aaaaaa111111', title: 'Fix the Roster client!' }));
    const b = branchName(task({ id: 'bbbbbb222222', title: 'Fix the Roster client!' }));
    expect(a).toBe('task/fix-the-roster-client-aaaaaa');
    expect(b).toBe('task/fix-the-roster-client-bbbbbb');
    expect(branchName(task({ id: 'cccccc333333', title: '  ¿¡!  ' }))).toBe('task/task-cccccc');
    expect(branchName(task({ id: 'dddddd', title: 'x'.repeat(200) })).length).toBeLessThan(60);
  });

  it("clones the repository onto a new branch at the team's base, files and all", async () => {
    const repo = gitRepo();
    const dir = await folderFor(repo);
    expect(fs.readFileSync(path.join(dir, 'README.md'), 'utf8')).toBe('hello\n');
    expect(gitIn(dir, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('task/x-aaaaaa');
    expect(refOf(dir, 'HEAD')).toBe(refOf(repo, 'team'));
    expect(fs.existsSync(path.join(dir, '.git', 'HEAD'))).toBe(true); // a clone: its .git is inside the folder
  });

  it('refuses a folder that already exists, and a start point that does not', async () => {
    const repo = gitRepo();
    const dir = await folderFor(repo);
    await expect(createFolder({ repoPath: repo, dir, branch: 'task/y', startPoint: 'team' })).rejects.toThrow(/exists/);
    await expect(createFolder({ repoPath: repo, dir: path.join(tempDir(), 'f'), branch: 'task/z', startPoint: 'no-such-branch' })).rejects.toThrow(/no-such-branch/);
  });

  it("a commit in the folder does not move any ref of the user's repository until publish", async () => {
    const repo = gitRepo();
    const before = gitIn(repo, 'for-each-ref');
    const dir = await folderFor(repo);
    fs.writeFileSync(path.join(dir, 'NOTE.md'), 'a note\n');
    const commit = await commitAll(dir, ada, 'Add the note');
    expect(commit).toMatch(/^[0-9a-f]{40}$/);
    expect(gitIn(repo, 'for-each-ref')).toBe(before);
  });

  it("publish creates the task branch in the user's repository and leaves its checkout alone", async () => {
    const repo = gitRepo();
    const dir = await folderFor(repo);
    fs.writeFileSync(path.join(dir, 'NOTE.md'), 'a note\n');
    const commit = await commitAll(dir, ada, 'Add the note');
    await publish(repo, dir, 'task/x-aaaaaa');
    expect(refOf(repo, 'task/x-aaaaaa')).toBe(commit);
    expect(fileAt(repo, 'task/x-aaaaaa', 'NOTE.md')).toBe('a note');
    expect(gitIn(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
    expect(fs.existsSync(path.join(repo, 'NOTE.md'))).toBe(false);
    expect(refOf(repo, 'main')).toBe(refOf(repo, 'team'));
    // Publishing again after more work moves the branch forward.
    fs.writeFileSync(path.join(dir, 'NOTE.md'), 'a longer note\n');
    const second = await commitAll(dir, ada, 'Lengthen');
    await publish(repo, dir, 'task/x-aaaaaa');
    expect(refOf(repo, 'task/x-aaaaaa')).toBe(second);
  });

  it("starts a child from its parent's published branch", async () => {
    const repo = gitRepo();
    const parent = await folderFor(repo, 'task/parent-aaaaaa');
    fs.writeFileSync(path.join(parent, 'PARENT.md'), 'from the parent\n');
    await commitAll(parent, ada, 'Parent work');
    await publish(repo, parent, 'task/parent-aaaaaa');
    const child = await folderFor(repo, 'task/child-bbbbbb', 'task/parent-aaaaaa');
    expect(fs.existsSync(path.join(child, 'PARENT.md'))).toBe(true);
  });

  it('removing the folder keeps the published branch', async () => {
    const repo = gitRepo();
    const dir = await folderFor(repo);
    fs.writeFileSync(path.join(dir, 'NOTE.md'), 'a note\n');
    await commitAll(dir, ada, 'Add the note');
    await publish(repo, dir, 'task/x-aaaaaa');
    await removeFolder(dir);
    expect(fs.existsSync(dir)).toBe(false);
    expect(fileAt(repo, 'task/x-aaaaaa', 'NOTE.md')).toBe('a note');
  });
});

describe('engine commits', () => {
  it('commits everything with the employee as author and returns null when nothing changed', async () => {
    const dir = await folderFor(gitRepo());
    expect(await commitAll(dir, ada, 'Nothing')).toBeNull();
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src/a.ts'), 'export const a = 1;\n');
    fs.rmSync(path.join(dir, 'README.md'));
    await commitAll(dir, ada, 'Add a, drop the readme\n\nA longer body.');
    expect(gitIn(dir, 'log', '-1', '--format=%an <%ae>|%s')).toBe('Ada <emp1@employees.invalid>|Add a, drop the readme');
    expect(gitIn(dir, 'status', '--porcelain')).toBe('');
    expect(await commitAll(dir, ada, 'Again')).toBeNull();
  });

  it('measures a branch against its base: files, lines, the patch, the names', async () => {
    const dir = await folderFor(gitRepo());
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src/a.ts'), 'one\ntwo\nthree\n');
    fs.writeFileSync(path.join(dir, 'README.md'), 'hello again\n');
    await commitAll(dir, ada, 'Change two files');
    expect(await changedFiles(dir, 'origin/team')).toEqual(['README.md', 'src/a.ts']);
    const stat = await diffStat(dir, 'origin/team');
    expect(stat).toMatchObject({ files: 2, lines: 5 });
    expect(stat.text).toContain('src/a.ts');
    expect(await patch(dir, 'origin/team', 10_000)).toContain('+three');
    const cut = await patch(dir, 'origin/team', 40);
    expect(cut.length).toBeLessThanOrEqual(41);
    expect(cut.endsWith('…')).toBe(true);
  });

  it("publishes a branch the user has checked out to try the work, by moving that checkout forward", async () => {
    const repo = gitRepo();
    const dir = await folderFor(repo);
    fs.writeFileSync(path.join(dir, 'NOTE.md'), 'a note\n');
    await commitAll(dir, ada, 'Add the note');
    await publish(repo, dir, 'task/x-aaaaaa');
    gitIn(repo, 'checkout', '-q', 'task/x-aaaaaa');
    // Nothing new: publishing again is nothing to do, not a refusal.
    await publish(repo, dir, 'task/x-aaaaaa');
    fs.writeFileSync(path.join(dir, 'NOTE.md'), 'a longer note\n');
    const second = await commitAll(dir, ada, 'Lengthen');
    await publish(repo, dir, 'task/x-aaaaaa');
    expect(refOf(repo, 'task/x-aaaaaa')).toBe(second);
    expect(fs.readFileSync(path.join(repo, 'NOTE.md'), 'utf8')).toBe('a longer note\n');
    // Uncommitted work in that checkout is never moved under: the refusal says where and what to do.
    fs.writeFileSync(path.join(repo, 'NOTE.md'), 'my own edit\n');
    fs.writeFileSync(path.join(dir, 'NOTE.md'), 'the longest note\n');
    await commitAll(dir, ada, 'Lengthen again');
    await expect(publish(repo, dir, 'task/x-aaaaaa')).rejects.toThrow(/checked out in .* with changes that are not committed/);
    expect(refOf(repo, 'task/x-aaaaaa')).toBe(second);
  });
});
