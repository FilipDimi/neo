import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export type Identity = { name: string; email: string };
export type GitResult = { code: number; out: string };

// The engine runs git in folders an employee has worked in. Nothing in a repository may start a
// program when it does: no hooks, no file watcher, no signing. File names come back as they are.
const SAFE = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', '-c', 'core.quotePath=false'];

/**
 * A task folder's git directory is the plain directory the engine made, with its own settings.
 * One that has been replaced by a link, or pointed at another folder's settings, is not trusted.
 */
export function assertOwnGitDir(dir: string): void {
  const gitDir = path.join(dir, '.git');
  const stat = fs.lstatSync(gitDir, { throwIfNoEntry: false });
  if (!stat?.isDirectory() || fs.existsSync(path.join(gitDir, 'commondir'))) throw new Error(`the git directory of ${dir} is not the one the engine made, so the engine will not run git there`);
}

/** Runs git and never throws for a non-zero exit: the caller decides what a failure means. Never prompts. */
export function git(cwd: string, args: string[], identity?: Identity): Promise<GitResult> {
  const who = [...SAFE, ...(identity ? ['-c', `user.name=${identity.name}`, '-c', `user.email=${identity.email}`] : [])];
  return new Promise((resolve) => {
    execFile('git', [...who, ...args], { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true' }, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
      resolve({ code, out: `${stdout}${stderr}`.trim() });
    });
  });
}

/** Runs git and throws when it fails. */
export async function must(cwd: string, args: string[], identity?: Identity): Promise<string> {
  const result = await git(cwd, args, identity);
  if (result.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.out}`);
  return result.out;
}
