import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { changedFiles, commitAll, NestedRepoError } from '../../src/git/commit.ts';
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

  it("will not run git in a folder whose git settings are not the ones the engine wrote", async () => {
    // A filter, a file watcher, a hooks folder: each is a program git would start. Any change to the settings is refused whole.
    for (const [key, value] of [['filter.x.clean', 'touch MARKER'], ['core.fsmonitor', 'touch MARKER; false'], ['core.hooksPath', '/tmp'], ['remote.origin.uploadpack', 'touch MARKER'], ['user.name', 'harmless but not ours']] as const) {
      const { dir, marker } = await folder();
      gitIn(dir, 'config', key, value.replace('MARKER', `"${marker}"`));
      fs.writeFileSync(path.join(dir, '.gitattributes'), '* filter=x\n');
      fs.writeFileSync(path.join(dir, 'work.md'), 'done\n');
      await expect(commitAll(dir, AUTHOR, 'Work', 'task/thing-abc123'), key).rejects.toThrow(/git settings/);
      expect(fs.existsSync(marker), key).toBe(false);
    }
  });

  it("still commits when the settings are as the engine left them, whatever sits in the hooks folder or the attributes", async () => {
    const { dir, marker } = await folder();
    fs.writeFileSync(path.join(dir, '.gitattributes'), '* filter=x diff=y merge=z\n');
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

  it('will not commit around a folder that has a git repository of its own, and names it', async () => {
    // Git would record such a folder as a pointer, or not at all: the files in it would never reach a review or a merge.
    const { dir } = await folder();
    fs.mkdirSync(path.join(dir, 'tools/gen'), { recursive: true });
    gitIn(path.join(dir, 'tools/gen'), 'init', '-q');
    fs.writeFileSync(path.join(dir, 'tools/gen/main.rs'), 'fn main() {}\n');
    const refused = await commitAll(dir, AUTHOR, 'Work', 'task/thing-abc123').catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(NestedRepoError);
    expect((refused as NestedRepoError).dirs).toEqual(['tools/gen']);
    // Once it is an ordinary folder its files are committed like any others.
    fs.rmSync(path.join(dir, 'tools/gen/.git'), { recursive: true, force: true });
    expect(await commitAll(dir, AUTHOR, 'Work', 'task/thing-abc123')).toMatch(/^[0-9a-f]{40}$/);
    expect(gitIn(dir, 'ls-tree', '-r', '--name-only', 'HEAD').split('\n')).toContain('tools/gen/main.rs');
  });

  it('does not mind a repository inside a folder that git ignores', async () => {
    const { dir } = await folder();
    fs.writeFileSync(path.join(dir, '.gitignore'), 'vendor/\n');
    fs.mkdirSync(path.join(dir, 'vendor/lib'), { recursive: true });
    gitIn(path.join(dir, 'vendor/lib'), 'init', '-q');
    fs.writeFileSync(path.join(dir, 'work.md'), 'done\n');
    expect(await commitAll(dir, AUTHOR, 'Work', 'task/thing-abc123')).toMatch(/^[0-9a-f]{40}$/);
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
