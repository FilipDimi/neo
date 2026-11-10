/**
 * The whole product with no model: a throwaway company (the cast of the design's artboards), a
 * throwaway repository, real worker processes, and a scripted runtime in place of the SDK.
 *
 *   npm run demo            then open http://127.0.0.1:4317/
 *   VS_DEMO_DELAY_MS=400    makes the employees quicker
 *   VS_DEMO_EMPTY=1         starts with no company, to see first setup
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildServer, DEFAULT_PORT } from '../src/api/server.ts';
import { apply } from '../src/db/apply.ts';
import { paths } from '../src/db/dataDir.ts';
import { openDb } from '../src/db/open.ts';
import type { Capability, Employee, Team } from '../src/shared/types.ts';
import { setupCompany, TEAM_DEFAULTS } from '../src/supervisor/setup.ts';
import { Supervisor } from '../src/supervisor/supervisor.ts';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vs-demo-')));
const dataDir = path.join(root, 'data');
const repoPath = path.join(root, 'repo');
const port = Number(process.env.VS_PORT ?? DEFAULT_PORT);
const db = openDb(paths(dataDir).db);
const runtimeModule = path.resolve(import.meta.dirname, '../test/fixtures/demoRuntime.ts');

if (!process.env.VS_DEMO_EMPTY) {
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=Demo', '-c', 'user.email=demo@example.invalid', ...args], { cwd: repoPath });
  fs.mkdirSync(repoPath, { recursive: true });
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repoPath, 'README.md'), '# A throwaway repository for the demo\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'first');
  git('branch', 'track/ios');
  git('branch', 'track/rust');

  const now = new Date();
  setupCompany({ db, now, paths: paths(dataDir) }, { name: 'Receipts Inc.', rules: 'Nothing invented. Contract first. Nothing merges red.', chiefName: 'Neo' });
  const coder: Capability[] = ['read_files', 'run_commands', 'write_code'];
  const team = (id: string, name: string, purpose: string, over: Partial<Team>): Team => ({ ...TEAM_DEFAULTS, id, name, purpose, leaseMinutes: 1, ...over });
  const person = (id: string, name: string, teamId: string, role: string, capabilities = coder): Employee => ({ id, teamId, name, role, skills: [], capabilities, model: 'claude-haiku-5-5', memoryDir: path.join(dataDir, 'memory', id), chatSessionId: null, fired: false });
  apply(
    db,
    (tx) => {
      tx.emit({ kind: 'repo_changed', repo: { id: 'receipts', path: repoPath, gates: [{ name: 'tests', command: 'sleep 1 && test -f README.md', timeoutMinutes: 1, lock: null }] } });
      tx.emit({ kind: 'team_changed', team: team('ios', 'Engineering · iOS', 'Builds the iPhone app.', { leadId: 'ios-lead', dailyCapUsd: 20, repos: [{ repoId: 'receipts', baseBranch: 'track/ios', mergeTarget: 'track/ios' }] }) });
      tx.emit({ kind: 'team_changed', team: team('rust', 'Engineering · Rust', 'Builds the backend.', { leadId: 'rust-lead', dailyCapUsd: 15, repos: [{ repoId: 'receipts', baseBranch: 'track/rust', mergeTarget: null }] }) });
      tx.emit({ kind: 'team_changed', team: team('marketing', 'Marketing', 'Writes what people read about the product.', { selfManaged: true, dailyCapUsd: 5 }) });
      const cast: Employee[] = [
        person('ios-lead', 'iOS lead', 'ios', 'Leads the iOS team: splits work, reviews it, integrates it.'),
        person('mo', 'MO', 'ios', 'Owns motion: how screens open, close and hand off.'),
        person('a6', 'A6', 'ios', 'Owns the card row and its glass.'),
        person('a3', 'A3', 'ios', 'Owns the Life screen.'),
        person('c1', 'C1', 'ios', 'Owns the government screens.'),
        person('c2', 'C2', 'ios', 'Owns the Person page.'),
        person('nh', 'NH', 'ios', 'Owns the navigation-hang recorder.'),
        person('rust-lead', 'Rust lead', 'rust', 'Leads the Rust team: splits work, reviews it, integrates it.'),
        person('ap', 'AP', 'rust', 'Owns the API.'),
        person('pl', 'PL', 'rust', 'Owns the pipeline.'),
        person('mw', 'MW', 'marketing', 'Writes store descriptions and announcements.', ['read_files', 'write_code', 'web_search']),
      ];
      for (const employee of cast) tx.emit({ kind: 'employee_changed', employee });
    },
    now,
  );
}

// The machine's real health is not the demo's business: it always reports a healthy one.
const probes = { diskFreeGb: async () => 80, login: async () => ({ loggedIn: true, authMethod: 'claude.ai', expiresAt: null }), repoProblem: async () => null, service: async () => true };
const supervisor = new Supervisor({ db, dataDir, runtimeModule, probes, tickMs: 500 });
const app = await buildServer({ db, dataDir, supervisor, port });
await app.listen({ host: '127.0.0.1', port });
supervisor.start();
console.log(`Demo company running at http://127.0.0.1:${port}/  (no model is used; throwaway data in ${root})`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    await app.close();
    await supervisor.stop();
    process.exit(0);
  });
}
