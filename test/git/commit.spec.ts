import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { changedFiles, commitAll } from '../../src/git/commit.ts';
import { createFolder } from '../../src/git/folder.ts';
import { gitIn, gitRepo, tempDir } from '../helpers.ts';

const AUTHOR = { name: 'Ada', email: 'ada@company.invalid' };

/** A task folder as the engine makes one: a clone on the task's branch. */
async function folder(files?: Record<string, string>): Promise<{ dir: string; marker: string }> {
  const repo = files ? gitRepo(['team'], files) : gitRepo();
  const dir = path.join(tempDir(), 'task');
  await createFolder({ repoPath: repo, dir, branch: 'task/thing-abc123', startPoint: 'team' });
  return { dir, marker: path.join(tempDir(), 'ran') };
}

describe('the engine commits in a folder an employee has worked in', () => {
  it("does not run the folder's hooks", async () => {
    const { dir, marker } = await folder();
    for (const hook of ['pre-commit', 'commit-msg', 'post-commit', 'prepare-commit-msg']) {
      fs.writeFileSync(path.join(dir, '.git/hooks', hook), `#!/bin/sh\necho ${hook} >> "${marker}"\n`, { mode: 0o755 });
    }
    fs.writeFileSync(path.join(dir, 'work.md'), 'done\n');
    expect(await commitAll(dir, AUTHOR, 'Work', 'task/thing-abc123')).toMatch(/^[0-9a-f]{40}$/);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("does not run a command named in the folder's git settings", async () => {
    const { dir, marker } = await folder();
    gitIn(dir, 'config', 'core.fsmonitor', `touch "${marker}"; false`);
    gitIn(dir, 'config', 'core.hooksPath', path.dirname(marker));
    fs.writeFileSync(path.join(path.dirname(marker), 'pre-commit'), `#!/bin/sh\ntouch "${marker}"\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(dir, 'work.md'), 'done\n');
    expect(await commitAll(dir, AUTHOR, 'Work', 'task/thing-abc123')).toMatch(/^[0-9a-f]{40}$/);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('refuses a folder whose git directory has been pointed somewhere else', async () => {
    const { dir } = await folder();
    fs.writeFileSync(path.join(dir, 'work.md'), 'done\n');
    fs.writeFileSync(path.join(dir, '.git/commondir'), '../../elsewhere\n');
    await expect(commitAll(dir, AUTHOR, 'Work', 'task/thing-abc123')).rejects.toThrow(/git directory/);

    const other = await folder();
    fs.renameSync(path.join(other.dir, '.git'), path.join(other.dir, 'real-git'));
    fs.symlinkSync(path.join(other.dir, 'real-git'), path.join(other.dir, '.git'));
    await expect(commitAll(other.dir, AUTHOR, 'Work', 'task/thing-abc123')).rejects.toThrow(/git directory/);
  });

  it('commits on the task branch even when the folder was switched to another one', async () => {
    const { dir } = await folder();
    gitIn(dir, 'checkout', '-q', '-b', 'fix/elsewhere');
    fs.writeFileSync(path.join(dir, 'first.md'), 'committed on the wrong branch\n');
    gitIn(dir, 'add', '-A');
    gitIn(dir, '-c', 'user.name=x', '-c', 'user.email=x@x', 'commit', '-q', '-m', 'on the wrong branch');
    fs.writeFileSync(path.join(dir, 'second.md'), 'not committed yet\n');

    const commit = await commitAll(dir, AUTHOR, 'Work', 'task/thing-abc123');
    expect(gitIn(dir, 'symbolic-ref', '--short', 'HEAD')).toBe('task/thing-abc123');
    expect(gitIn(dir, 'rev-parse', 'task/thing-abc123')).toBe(commit);
    expect(gitIn(dir, 'ls-tree', '-r', '--name-only', 'task/thing-abc123').split('\n')).toEqual(expect.arrayContaining(['first.md', 'second.md']));
  });

  it('puts a detached folder back on the task branch, with nothing to commit', async () => {
    const { dir } = await folder();
    gitIn(dir, 'checkout', '-q', '--detach');
    expect(await commitAll(dir, AUTHOR, 'Work', 'task/thing-abc123')).toBeNull();
    expect(gitIn(dir, 'symbolic-ref', '--short', 'HEAD')).toBe('task/thing-abc123');
  });
});

describe('changedFiles', () => {
  it('names both ends of a move, and a name that is not plain ASCII as it is', async () => {
    const { dir } = await folder({ 'README.md': 'hello\n', 'billing/charge.ts': 'export const charge = 1;\n'.repeat(20) });
    fs.mkdirSync(path.join(dir, 'mine'));
    fs.renameSync(path.join(dir, 'billing/charge.ts'), path.join(dir, 'mine/charge.ts'));
    fs.writeFileSync(path.join(dir, 'mine/naïve café.md'), 'x\n');
    await commitAll(dir, AUTHOR, 'Moved', 'task/thing-abc123');
    expect(await changedFiles(dir, 'origin/team')).toEqual(['billing/charge.ts', 'mine/charge.ts', 'mine/naïve café.md']);
  });
});
