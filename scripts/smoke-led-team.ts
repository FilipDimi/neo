/**
 * The live led-team smoke test (engine plan, Task 10): a lead briefs a task into two sub-tasks,
 * two engineers work them, the lead reviews and integrates, and the engine lands the result on
 * the team branch. Real sessions on the claude.ai login; a throwaway repository and data directory.
 *
 * Usage: npx tsx scripts/smoke-led-team.ts        (about ten short sessions; VS_LIVE_MODEL picks the model,
 *        VS_LIVE_CONCURRENCY how many run at once, 3 unless said)
 * The throwaway folder is left in the system temp directory and its path is printed.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../src/db/apply.ts';
import { paths } from '../src/db/dataDir.ts';
import { openDb } from '../src/db/open.ts';
import * as store from '../src/db/store.ts';
import type { Company, Employee, Team } from '../src/shared/types.ts';
import { Supervisor } from '../src/supervisor/supervisor.ts';

const MODEL = process.env.VS_LIVE_MODEL ?? 'claude-haiku-5-5';
const MINUTES = 15;
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vs-smoke-')));
const repoPath = path.join(root, 'repo');
const dataDir = path.join(root, 'data');
const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=Smoke', '-c', 'user.email=smoke@example.invalid', ...args], { cwd: repoPath, encoding: 'utf8' }).trim();

fs.mkdirSync(repoPath, { recursive: true });
git('init', '-q', '-b', 'main');
fs.writeFileSync(path.join(repoPath, 'README.md'), '# Throwaway\n');
git('add', '-A');
git('commit', '-q', '-m', 'first');
git('branch', 'team');
const mainBefore = git('rev-parse', 'main');

const db = openDb(paths(dataDir).db);
const company: Company = {
  id: 'co',
  name: 'Smoke Test Inc.',
  rules: 'Nothing invented. Keep files short.',
  auth: 'subscription',
  concurrency: Number(process.env.VS_LIVE_CONCURRENCY ?? 3),
  dailyCapUsd: 5,
  models: { lead: MODEL, member: MODEL, routine: MODEL },
  denyRead: [],
  minFreeGb: 1,
  services: [],
  chiefOfStaffId: null,
  paused: null,
};
const team: Team = {
  id: 'eng',
  name: 'Engineering',
  purpose: 'Writes the files this repository needs.',
  leadId: 'lead',
  selfManaged: false,
  dailyCapUsd: 5,
  repos: [{ repoId: 'repo', baseBranch: 'team', mergeTarget: 'team' }],
  mayPush: false,
  mayOpenPr: false,
  mayPublish: false,
  maySend: false,
  mayPay: false,
  mayDelete: false,
  leaseMinutes: 5,
  maxReviewRounds: 3,
  sandboxWrite: [],
};
const person = (id: string, name: string, role: string): Employee => ({
  id,
  teamId: 'eng',
  name,
  role,
  skills: [],
  capabilities: ['read_files', 'run_commands', 'write_code'],
  model: MODEL,
  // VS_LIVE_EFFORT runs everyone at that effort; left out, each model uses its own.
  ...(process.env.VS_LIVE_EFFORT ? { effort: process.env.VS_LIVE_EFFORT as Employee['effort'] } : {}),
  memoryDir: path.join(dataDir, 'memory', id),
  chatSessionId: null,
  fired: false,
});
apply(db, (tx) => {
  tx.emit({ kind: 'company_changed', company });
  tx.emit({
    kind: 'repo_changed',
    repo: {
      id: 'repo',
      path: repoPath,
      gates: [
        { name: 'greeting', command: 'test -s GREETING.md', timeoutMinutes: 1, lock: null },
        { name: 'farewell', command: 'test -s FAREWELL.md', timeoutMinutes: 1, lock: null },
      ],
    },
  });
  tx.emit({ kind: 'team_changed', team });
  const people = [person('lead', 'Priya', 'Leads the team: splits work, reviews it, integrates it.'), person('ada', 'Ada', 'Writes files carefully.'), person('grace', 'Grace', 'Writes files carefully.')];
  for (const employee of people) tx.emit({ kind: 'employee_changed', employee });
});

const supervisor = new Supervisor({ db, dataDir, tickMs: 1000 });
const parent = supervisor.createTask({
  teamId: 'eng',
  title: 'Add a greeting and a farewell',
  brief:
    'This repository needs two new files at its top level: GREETING.md, containing one friendly sentence of greeting, and FAREWELL.md, containing one friendly sentence of farewell. Split this into two sub-tasks, one file each, for your two engineers.',
  doneCondition: 'GREETING.md and FAREWELL.md both exist at the top level and each contains one sentence.',
  gates: ['greeting', 'farewell'],
  capUsd: 3,
});

const seen = new Set<string>();
function report(): void {
  for (const run of store.allRuns(db)) {
    if (run.outcome === 'running' || seen.has(run.id)) continue;
    seen.add(run.id);
    const task = store.getTask(db, run.taskId);
    const who = (store.getEmployee(db, run.employeeId)?.name ?? '?').padEnd(6);
    const gates = run.gateResults.length > 0 ? `  gates: ${run.gateResults.map((g) => `${g.name}=${g.exitCode}`).join(' ')}` : '';
    console.log(`  ${run.mode.padEnd(9)} ${who} ${run.outcome.padEnd(8)} $${run.costUsd.toFixed(4)}  ${task?.title ?? ''}${run.reason ? `  (${run.reason})` : ''}${gates}`);
  }
}

console.log(`Led-team smoke test on ${MODEL}. Throwaway root: ${root}`);
supervisor.start();
const deadline = Date.now() + MINUTES * 60_000;
const settled = () => ['done', 'failed'].includes(store.getTask(db, parent.id)!.state) || store.openDecisions(db).length > 0;
while (!settled() && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 2000));
  report();
}
await supervisor.settle();
await supervisor.stop();
report();

const show = (ref: string, file: string): string | null => {
  try {
    return git('show', `${ref}:${file}`);
  } catch {
    return null;
  }
};
const children = store.listTasks(db, { parentId: parent.id });
const finalParent = store.getTask(db, parent.id)!;
const checks: [string, boolean][] = [
  ['the parent is done', finalParent.state === 'done'],
  ['it was split into two children, both done', children.length === 2 && children.every((c) => c.state === 'done')],
  ['GREETING.md is on the team branch', Boolean(show('team', 'GREETING.md'))],
  ['FAREWELL.md is on the team branch', Boolean(show('team', 'FAREWELL.md'))],
  ['main has not moved', git('rev-parse', 'main') === mainBefore],
  ['every finished task folder is gone', [finalParent, ...children].every((t) => !fs.existsSync(path.join(dataDir, 'folders', t.id)))],
  ['no card is open', store.openDecisions(db).length === 0],
  ['nothing is still running', store.liveRuns(db).length === 0],
];
console.log('');
for (const [name, ok] of checks) console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`);
for (const card of store.openDecisions(db)) console.log(`open card (${card.kind}): ${card.text}`);
const total = store.allRuns(db).reduce((sum, run) => sum + run.costUsd, 0);
console.log(`\n${store.allRuns(db).length} runs, $${total.toFixed(4)} at list prices.`);
console.log(`GREETING.md: ${JSON.stringify(show('team', 'GREETING.md'))}`);
console.log(`FAREWELL.md: ${JSON.stringify(show('team', 'FAREWELL.md'))}`);
process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
