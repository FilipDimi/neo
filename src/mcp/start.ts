/**
 * Starting the company from a Claude session, for when nobody is at this Mac: the engine is
 * launched as a process of its own, so it outlives the session that asked for it.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

type Who = 'nobody' | 'engine' | 'other';

export async function startCompany(options: { port: number; who: (port: number) => Promise<Who>; launch: () => void; log: string; waitMs?: number; pollMs?: number }): Promise<string> {
  const url = `http://127.0.0.1:${options.port}/`;
  const there = await options.who(options.port);
  if (there === 'engine') return `The company is already running at ${url}`;
  if (there === 'other') return `Port ${options.port} on this Mac is taken by another program, so the company cannot start there. Nothing was started.`;
  options.launch();
  const until = Date.now() + (options.waitMs ?? 60_000);
  while (Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 1000));
    if ((await options.who(options.port)) === 'engine') return `Started. The company is running at ${url}`;
  }
  return `The engine was started but has not answered on port ${options.port} yet. It may still be building its screen; call now in a minute. If it stays silent, what it said is in ${options.log}`;
}

/** Launches the engine from this folder, detached from whoever asked, with what it prints kept in a file. */
export function launchEngine(root: string, log: string, env: Record<string, string | undefined> = process.env): void {
  fs.mkdirSync(path.dirname(log), { recursive: true });
  const out = fs.openSync(log, 'a');
  const child = spawn(path.join(root, 'node_modules/.bin/tsx'), ['src/main.ts'], { cwd: root, detached: true, stdio: ['ignore', out, out], env: { ...env, VS_NO_OPEN: '1' } });
  child.unref();
  fs.closeSync(out);
}
