/**
 * Machine health: disk, the Claude login, each repository's git state, the services the company
 * depends on. A failed check blocks what it affects and raises a card; nothing fails silently.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import path from 'node:path';
import type { Company, HealthReport, Repo, Service } from '../shared/types.ts';

export type Login = { loggedIn: boolean; authMethod: string; expiresAt: string | null };
export type Probes = {
  diskFreeGb(dir: string): Promise<number>;
  login(): Promise<Login>;
  /** What is wrong with a repository, or null. */
  repoProblem(repoPath: string): Promise<string | null>;
  service(service: Service): Promise<boolean>;
};

const run = (command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): Promise<{ code: number; out: string }> =>
  new Promise((resolve) => {
    execFile(command, args, { cwd: options.cwd, env: options.env, timeout: options.timeoutMs ?? 10_000 }, (error, stdout) => resolve({ code: error ? 1 : 0, out: String(stdout) }));
  });

/** A dirty checkout is normal and no problem. A repository that is missing or in the middle of something is. */
export async function repoProblem(repoPath: string): Promise<string | null> {
  if (!fs.existsSync(repoPath)) return 'the folder is missing';
  const found = await run('git', ['rev-parse', '--absolute-git-dir'], { cwd: repoPath });
  if (found.code !== 0) return 'it is not a git repository';
  const gitDir = found.out.trim();
  if (fs.existsSync(path.join(gitDir, 'MERGE_HEAD'))) return 'a merge is in progress';
  if (fs.existsSync(path.join(gitDir, 'rebase-merge')) || fs.existsSync(path.join(gitDir, 'rebase-apply'))) return 'a rebase is in progress';
  const lock = path.join(gitDir, 'index.lock');
  if (fs.existsSync(lock) && Date.now() - fs.statSync(lock).mtimeMs > 10 * 60_000) return 'a stale index.lock is in the way';
  return null;
}

/** The Claude Code binary the SDK ships: the one the sessions run on. */
export function bundledClaude(): string {
  const require = createRequire(import.meta.url);
  return path.join(path.dirname(require.resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/package.json`)), 'claude');
}

export function realProbes(sessionEnv: () => Record<string, string>): Probes {
  return {
    async diskFreeGb(dir) {
      const stats = await fs.promises.statfs(dir);
      return (stats.bavail * stats.bsize) / 1e9;
    },
    // No model turn: `claude auth status` reads the login the sessions will use. On macOS it lives in the Keychain.
    async login() {
      const status = await run(bundledClaude(), ['auth', 'status'], { env: sessionEnv() });
      try {
        const parsed = JSON.parse(status.out) as { loggedIn?: boolean; authMethod?: string; loginExpiresAt?: string };
        return { loggedIn: parsed.loggedIn === true, authMethod: parsed.authMethod ?? 'none', expiresAt: parsed.loginExpiresAt ?? null };
      } catch {
        return { loggedIn: false, authMethod: 'none', expiresAt: null };
      }
    },
    repoProblem,
    async service(service) {
      if (service.kind === 'cmd') return (await run('bash', ['-c', service.target], { timeoutMs: 5000 })).code === 0;
      if (service.kind === 'http') {
        try {
          return (await fetch(service.target, { signal: AbortSignal.timeout(5000) })).status < 500;
        } catch {
          return false;
        }
      }
      const [host, port] = service.target.split(':');
      return new Promise((resolve) => {
        const socket = net.connect({ host: host || '127.0.0.1', port: Number(port), timeout: 5000 });
        const done = (ok: boolean) => {
          socket.destroy();
          resolve(ok);
        };
        socket.once('connect', () => done(true)).once('error', () => done(false)).once('timeout', () => done(false));
      });
    },
  };
}

export async function checkHealth(input: { repos: Repo[]; minFreeGb: number; auth: Company['auth']; services: Service[]; dataDir: string; now: Date; probe: Probes }): Promise<HealthReport> {
  const { probe } = input;
  const failures: HealthReport['failures'] = [];
  const diskFreeGb = Math.round((await probe.diskFreeGb(input.dataDir)) * 10) / 10;
  if (diskFreeGb < input.minFreeGb) failures.push({ key: 'disk', scope: 'company', text: `Only ${diskFreeGb} GB is free on the disk that holds the company's data; the floor is ${input.minFreeGb} GB. New runs wait until there is room.` });

  const signedIn = await probe.login();
  let login: HealthReport['login'] = 'ok';
  if (!signedIn.loggedIn) {
    login = 'missing';
    failures.push({ key: 'login', scope: 'company', text: 'Claude Code is not logged in on this machine. Run "claude", log in, then check again.' });
  } else if (input.auth === 'subscription' && signedIn.authMethod !== 'claude.ai') {
    login = 'wrong_method';
    failures.push({ key: 'login', scope: 'company', text: `Sessions would run on "${signedIn.authMethod}", but this company runs on the claude.ai subscription. Check the environment the engine was started from.` });
  } else if (signedIn.expiresAt && new Date(signedIn.expiresAt).getTime() - input.now.getTime() < 24 * 3600_000) {
    login = 'expiring';
    failures.push({ key: 'login_expiring', scope: 'warning', text: `The Claude login expires at ${new Date(signedIn.expiresAt).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' })}. Log in again before then, or runs will start failing.` });
  }

  const repos: HealthReport['repos'] = [];
  for (const repo of input.repos) {
    const problem = await probe.repoProblem(repo.path);
    repos.push({ repoId: repo.id, ok: problem === null, problem });
    if (problem) failures.push({ key: `repo:${repo.id}`, scope: { repoId: repo.id }, text: `The repository at ${repo.path} cannot be worked in: ${problem}. Its tasks wait until that is cleared.` });
  }

  const services: HealthReport['services'] = [];
  for (const service of input.services) {
    const ok = await probe.service(service);
    services.push({ name: service.name, ok });
    if (!ok) failures.push({ key: `service:${service.name}`, scope: 'company', text: `The service "${service.name}" (${service.target}) is not answering. New runs wait until it is back.` });
  }
  return { at: input.now.toISOString(), diskFreeGb, login, repos, services, failures };
}
