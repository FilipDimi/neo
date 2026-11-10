import { execFile } from 'node:child_process';

export type Identity = { name: string; email: string };
export type GitResult = { code: number; out: string };

/** Runs git and never throws for a non-zero exit: the caller decides what a failure means. Never prompts. */
export function git(cwd: string, args: string[], identity?: Identity): Promise<GitResult> {
  const who = identity ? ['-c', `user.name=${identity.name}`, '-c', `user.email=${identity.email}`] : [];
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
