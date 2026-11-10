/** Row builders and a temp database for tests. Every builder takes overrides. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, type Db } from '../src/db/open.ts';
import type { Company, Employee, Repo, Team } from '../src/shared/types.ts';
import { company, employee, plus, T0, team } from './rows.ts';

export * from './rows.ts';

export function tempDir(prefix = 'vs-test-'): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

export function tempDb(): Db {
  return openDb(path.join(tempDir(), 'company.db'));
}

// ---------- a company in a temp data directory, with a supervisor on a clock the test moves ----------

import { apply } from '../src/db/apply.ts';
import { paths } from '../src/db/dataDir.ts';
import type { Spawn } from '../src/supervisor/link.ts';
import { Supervisor, type SupervisorOptions } from '../src/supervisor/supervisor.ts';

export type World = { dir: string; db: Db; sup: Supervisor; clock: { now(): Date; advance(seconds: number): void } };

/** A self-managed team "team1" with emp1 and emp2 unless told otherwise. */
export function world(spawn: Spawn, over: { company?: Partial<Company>; teams?: Team[]; employees?: Employee[]; repos?: Repo[]; options?: Partial<SupervisorOptions> } = {}): World {
  const dir = tempDir();
  const db = openDb(paths(dir).db);
  apply(db, (tx) => {
    tx.emit({ kind: 'company_changed', company: company(over.company) });
    for (const r of over.repos ?? []) tx.emit({ kind: 'repo_changed', repo: r });
    for (const t of over.teams ?? [team({ selfManaged: true })]) tx.emit({ kind: 'team_changed', team: t });
    for (const e of over.employees ?? [employee(), employee({ id: 'emp2', name: 'Grace' })]) tx.emit({ kind: 'employee_changed', employee: { ...e, memoryDir: path.join(dir, 'memory', e.id) } });
  });
  let now = T0;
  const clock = { now: () => now, advance: (seconds: number) => void (now = plus(now, seconds)) };
  const sup = new Supervisor({ db, dataDir: dir, now: clock.now, spawn, ...over.options });
  return { dir, db, sup, clock };
}

// ---------- a throwaway git repository ----------

import { execFileSync } from 'node:child_process';

export const sh = (cwd: string, command: string, ...args: string[]): string => execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
export const gitIn = (cwd: string, ...args: string[]): string => sh(cwd, 'git', '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args);

/** A repository with one commit on `main` and, by default, a `team` branch at the same commit. `main` stays checked out. */
export function gitRepo(branches: string[] = ['team'], files: Record<string, string> = { 'README.md': 'hello\n' }): string {
  const dir = tempDir('vs-repo-');
  gitIn(dir, 'init', '-q', '-b', 'main');
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
  gitIn(dir, 'add', '-A');
  gitIn(dir, 'commit', '-q', '-m', 'first');
  for (const branch of branches) gitIn(dir, 'branch', branch);
  return dir;
}

export const refOf = (repo: string, ref: string): string => gitIn(repo, 'rev-parse', ref);
export const fileAt = (repo: string, ref: string, file: string): string | null => {
  try {
    return gitIn(repo, 'show', `${ref}:${file}`);
  } catch {
    return null;
  }
};
