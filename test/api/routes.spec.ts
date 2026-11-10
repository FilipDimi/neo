import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { apply } from '../../src/db/apply.ts';
import { paths } from '../../src/db/dataDir.ts';
import { openDb } from '../../src/db/open.ts';
import * as store from '../../src/db/store.ts';
import { loadToken } from '../../src/api/security.ts';
import { buildServer } from '../../src/api/server.ts';
import { Supervisor } from '../../src/supervisor/supervisor.ts';
import { exit, scripted } from '../fixtures/scriptedLink.ts';
import { employee, gitIn, gitRepo, plus, run, T0, task, team, tempDir, world, type World } from '../helpers.ts';

let stop: (() => Promise<void>) | undefined;
afterEach(async () => {
  await stop?.();
  stop = undefined;
});

type Api = { w: World; call: (method: string, url: string, body?: unknown) => Promise<{ status: number; json: any }> };

async function api(w: World): Promise<Api> {
  stop = () => w.sup.stop();
  const app = await buildServer({ db: w.db, dataDir: w.dir, supervisor: w.sup, port: 4317 });
  const headers = { host: '127.0.0.1:4317', origin: 'http://127.0.0.1:4317', authorization: `Bearer ${loadToken(path.join(w.dir, 'token'))}` };
  const call: Api['call'] = async (method, url, body) => {
    const response = await app.inject({ method: method as 'GET', url, headers: body === undefined ? headers : { ...headers, 'content-type': 'application/json' }, ...(body === undefined ? {} : { payload: JSON.stringify(body) }) });
    return { status: response.statusCode, json: response.body ? JSON.parse(response.body) : null };
  };
  return { w, call };
}
const fresh = (spawn = scripted().spawn, over: Parameters<typeof world>[1] = {}) => api(world(spawn, over));

describe('setup', () => {
  it('creates the company and its chief of staff, once', async () => {
    const dir = tempDir();
    const db = openDb(paths(dir).db);
    const sup = new Supervisor({ db, dataDir: dir, spawn: scripted().spawn });
    const { call } = await api({ dir, db, sup, clock: { now: () => T0, advance: () => {} } });
    expect((await call('GET', '/api/snapshot')).json).toMatchObject({ company: null, tasks: [] });
    const made = await call('POST', '/api/setup', { name: 'Receipts Inc.', rules: 'Nothing invented.', chiefName: 'Neo' });
    expect(made.status).toBe(200);
    const snapshot = (await call('GET', '/api/snapshot')).json;
    expect(snapshot.company).toMatchObject({ name: 'Receipts Inc.', auth: 'subscription', concurrency: 3, models: { lead: 'claude-opus-5-5', member: 'claude-sonnet-5-5', routine: 'claude-haiku-5-5' } });
    expect(snapshot.employees).toMatchObject([{ name: 'Neo', model: 'claude-opus-5-5' }]);
    expect(snapshot.company.chiefOfStaffId).toBe(snapshot.employees[0].id);
    expect(snapshot.teams).toMatchObject([{ leadId: snapshot.employees[0].id }]);
    expect((await call('POST', '/api/setup', { name: 'Again', rules: '' })).status).toBe(409);
  });
});

describe('tasks and the snapshot', () => {
  it('creates a task and shows it queued in the snapshot, with the last event id to stream from', async () => {
    const { call, w } = await fresh();
    const made = await call('POST', '/api/tasks', { teamId: 'team1', assigneeId: 'emp1', title: 'Write the note', brief: 'Write it.', priority: 1, capUsd: 3 });
    expect(made.status).toBe(200);
    expect(made.json.task).toMatchObject({ title: 'Write the note', state: 'queued', priority: 1, capUsd: 3, createdBy: 'user' });
    const snapshot = (await call('GET', '/api/snapshot')).json;
    expect(snapshot.tasks).toHaveLength(1);
    expect(snapshot.requests).toMatchObject([{ taskId: made.json.task.id, mode: 'work' }]);
    expect(snapshot.lastEventId).toBe(store.getTask(w.db, made.json.task.id) ? snapshot.lastEventId : -1);
    expect(snapshot.lastEventId).toBeGreaterThan(0);
    expect(snapshot.version).toBe(1);
    expect(snapshot.spend).toEqual({ company: 0, byTeam: {}, byEmployee: {} });
  });

  it('refuses an unassigned task on a self-managed team, and a body that does not fit, with a reason', async () => {
    const { call } = await fresh();
    const unassigned = await call('POST', '/api/tasks', { teamId: 'team1', title: 'T', brief: 'B' });
    expect(unassigned).toMatchObject({ status: 400, json: { error: expect.stringContaining('assignee') } });
    expect((await call('POST', '/api/tasks', { teamId: 'team1', title: '' })).status).toBe(400);
    expect((await call('GET', '/api/tasks/nope')).status).toBe(404);
  });

  it("returns a task with its children, runs and events, and keeps it in the snapshot after its day is over", async () => {
    const fake = scripted((worker) => worker.say(exit('done')));
    const { call, w } = await fresh(fake.spawn);
    const { json } = await call('POST', '/api/tasks', { teamId: 'team1', assigneeId: 'emp1', title: 'Write the note', brief: 'Write it.' });
    await w.sup.tick();
    await w.sup.settle();
    const detail = (await call('GET', `/api/tasks/${json.task.id}`)).json;
    expect(detail.task.state).toBe('done');
    expect(detail.runs).toMatchObject([{ outcome: 'done', mode: 'work' }]);
    expect(detail.events.map((e: any) => e.event.kind)).toEqual(expect.arrayContaining(['task_changed', 'run_started', 'run_ended']));
    expect(detail.children).toEqual([]);
    expect((await call('GET', '/api/snapshot')).json.tasks).toHaveLength(1);
    // Two days on it is one of the last things that finished, so the board can still open it.
    w.clock.advance(2 * 86400);
    const later = (await call('GET', '/api/snapshot')).json;
    expect(later.tasks).toMatchObject([{ id: json.task.id, state: 'done' }]);
    expect(later.runs).toMatchObject([{ taskId: json.task.id }]);
  });

  it('cancel fails the task and stops its run', async () => {
    const fake = scripted();
    const { call, w } = await fresh(fake.spawn);
    const { json } = await call('POST', '/api/tasks', { teamId: 'team1', assigneeId: 'emp1', title: 'T', brief: 'B' });
    await w.sup.tick();
    expect((await call('PATCH', `/api/tasks/${json.task.id}`, { cancel: true })).status).toBe(200);
    await w.sup.settle();
    expect(store.getTask(w.db, json.task.id)?.state).toBe('failed');
    expect(fake.workers[0]!.killed).toBe(true);
    expect(store.liveRuns(w.db)).toHaveLength(0);
    expect(store.openDecisions(w.db)).toHaveLength(0);
  });

  it('changes the priority of a task, and reassigns one that has not started', async () => {
    const { call, w } = await fresh();
    const { json } = await call('POST', '/api/tasks', { teamId: 'team1', assigneeId: 'emp1', title: 'T', brief: 'B' });
    await call('PATCH', `/api/tasks/${json.task.id}`, { priority: 1, assigneeId: 'emp2' });
    expect(store.getTask(w.db, json.task.id)).toMatchObject({ priority: 1, assigneeId: 'emp2' });
    expect(store.openRequests(w.db)).toMatchObject([{ employeeId: 'emp2' }]);
  });

  it('sends the page what is open, what finished today, and the last five things that finished before today with their runs', async () => {
    const { call, w } = await fresh();
    const at = (daysAgo: number, minute: number) => new Date(T0.getTime() - daysAgo * 24 * 3600_000 + minute * 60_000).toISOString();
    apply(w.db, (tx) => {
      for (let i = 0; i < 7; i++) tx.emit({ kind: 'task_changed', task: task({ id: `old${i}`, state: 'done', updatedAt: at(2, i) }), cause: 'state' });
      tx.emit({ kind: 'task_changed', task: task({ id: 'today', state: 'done', updatedAt: T0.toISOString() }), cause: 'state' });
      tx.emit({ kind: 'task_changed', task: task({ id: 'open', state: 'running', updatedAt: at(3, 0) }), cause: 'state' });
      tx.emit({ kind: 'task_changed', task: task({ id: 'old-chat', kind: 'chat', state: 'done', updatedAt: at(1, 0) }), cause: 'state' });
      tx.emit({ kind: 'run_ended', run: run({ id: 'r-old', taskId: 'old6', outcome: 'done' }), teamId: 'team1' });
      tx.emit({ kind: 'run_ended', run: run({ id: 'r-gone', taskId: 'old0', outcome: 'done' }), teamId: 'team1' });
    });
    const snapshot = (await call('GET', '/api/snapshot')).json;
    expect(snapshot.tasks.map((t: { id: string }) => t.id).sort()).toEqual(['old2', 'old3', 'old4', 'old5', 'old6', 'open', 'today']);
    expect(snapshot.runs.map((r: { id: string }) => r.id)).toEqual(['r-old']);
  });

  it('lists what a task without a repository wrote, with the text of small files, and follows no link out of the folder', async () => {
    const { call, w } = await fresh();
    const { json } = await call('POST', '/api/tasks', { teamId: 'team1', assigneeId: 'emp1', title: 'T', brief: 'B' });
    const folder = path.join(w.dir, 'folders', json.task.id);
    fs.mkdirSync(path.join(folder, 'notes'), { recursive: true });
    fs.mkdirSync(path.join(folder, 'node_modules/pkg'), { recursive: true });
    fs.writeFileSync(path.join(folder, 'market-brief.md'), '# Brief\n');
    fs.writeFileSync(path.join(folder, 'notes/sources.txt'), 'one\n');
    fs.writeFileSync(path.join(folder, 'node_modules/pkg/index.js'), 'x');
    fs.writeFileSync(path.join(folder, 'chart.png'), Buffer.from([0x89, 0x50, 0x00, 0x01]));
    fs.writeFileSync(path.join(folder, 'huge.log'), 'x'.repeat(300_000));
    fs.symlinkSync('/etc/hosts', path.join(folder, 'hosts-link'));
    const listed = (await call('GET', `/api/tasks/${json.task.id}/files`)).json;
    expect(listed.folder).toBe(folder);
    expect(listed.more).toBe(0);
    expect(listed.files).toEqual([
      { path: 'chart.png', bytes: 4, text: null },
      { path: 'huge.log', bytes: 300_000, text: null },
      { path: 'market-brief.md', bytes: 8, text: '# Brief\n' },
      { path: 'notes/sources.txt', bytes: 4, text: 'one\n' },
    ]);
  });

  it('lists no files for a task that has a repository, whose diff is its view, or for one that has written nothing', async () => {
    const repoPath = gitRepo();
    const { call } = await fresh(scripted().spawn, { repos: [{ id: 'repo1', path: repoPath, gates: [] }], teams: [team({ selfManaged: true, repos: [{ repoId: 'repo1', baseBranch: 'team', mergeTarget: null }] })] });
    const { json } = await call('POST', '/api/tasks', { teamId: 'team1', assigneeId: 'emp1', title: 'T', brief: 'B' });
    expect((await call('GET', `/api/tasks/${json.task.id}/files`)).json).toEqual({ folder: null, files: [], more: 0 });
    const plain = await fresh();
    const made = await plain.call('POST', '/api/tasks', { teamId: 'team1', assigneeId: 'emp1', title: 'T', brief: 'B' });
    expect((await plain.call('GET', `/api/tasks/${made.json.task.id}/files`)).json).toMatchObject({ files: [], more: 0 });
  });

  it("returns a task's diff stat and patch", async () => {
    const repoPath = gitRepo();
    const { call, w } = await fresh(scripted().spawn, { repos: [{ id: 'repo1', path: repoPath, gates: [] }], teams: [team({ selfManaged: true, repos: [{ repoId: 'repo1', baseBranch: 'team', mergeTarget: null }] })] });
    const { json } = await call('POST', '/api/tasks', { teamId: 'team1', assigneeId: 'emp1', title: 'T', brief: 'B' });
    gitIn(repoPath, 'checkout', '-q', '-b', 'task/t-000000', 'team');
    fs.writeFileSync(path.join(repoPath, 'NOTE.md'), 'a note\n');
    gitIn(repoPath, 'add', '-A');
    gitIn(repoPath, 'commit', '-q', '-m', 'note');
    gitIn(repoPath, 'checkout', '-q', 'main');
    apply(w.db, (tx) => tx.emit({ kind: 'task_changed', task: { ...store.getTask(w.db, json.task.id)!, branch: 'task/t-000000' }, cause: 'edited' }));
    const diff = (await call('GET', `/api/tasks/${json.task.id}/diff`)).json;
    expect(diff.stat).toContain('NOTE.md');
    expect(diff.patch).toContain('+a note');
    expect(diff.lines).toBe(1);
  });

  it('sends a message to the assignee of a task, and stops a run', async () => {
    const fake = scripted();
    const { call, w } = await fresh(fake.spawn);
    const { json } = await call('POST', '/api/tasks', { teamId: 'team1', assigneeId: 'emp1', title: 'T', brief: 'B' });
    await w.sup.tick();
    const sent = await call('POST', `/api/tasks/${json.task.id}/message`, { text: 'Stop at the test step.' });
    expect(sent.json.message).toMatchObject({ toId: 'emp1', state: 'waiting', taskId: json.task.id });
    expect(fake.workers[0]!.received.some((m) => m.t === 'message')).toBe(true);
    expect((await call('POST', `/api/runs/${store.liveRuns(w.db)[0]!.id}/stop`)).status).toBe(200);
    expect(store.liveRuns(w.db)).toHaveLength(0);
  });
});

describe('decisions', () => {
  it('answers a decision by option id, reports ignored the second time, and keeps a log', async () => {
    const fake = scripted((worker) => worker.say({ t: 'tool', askId: 'q', name: 'request_decision', input: { question: 'Blue or green?', options: ['Blue', 'Green'] } }));
    const { call, w } = await fresh(fake.spawn);
    await call('POST', '/api/tasks', { teamId: 'team1', assigneeId: 'emp1', title: 'T', brief: 'B' });
    await w.sup.tick();
    await Promise.resolve();
    const [card] = (await call('GET', '/api/snapshot')).json.decisions;
    expect(card).toMatchObject({ kind: 'question', options: expect.arrayContaining([expect.objectContaining({ id: 'choice1', label: 'Blue' })]) });
    expect((await call('POST', `/api/decisions/${card.id}/answer`, { optionId: 'choice1' })).json).toEqual({ result: 'applied' });
    expect((await call('POST', `/api/decisions/${card.id}/answer`, { optionId: 'stop' })).json).toEqual({ result: 'ignored' });
    expect((await call('POST', `/api/decisions/${card.id}/answer`, { optionId: 'nope' })).json).toEqual({ result: 'ignored' });
    expect((await call('POST', '/api/decisions/missing/answer', { optionId: 'x' })).status).toBe(404);
    expect((await call('GET', '/api/snapshot')).json.decisions).toHaveLength(0);
    expect((await call('GET', '/api/decisions?answered=1')).json.decisions).toMatchObject([{ id: card.id, answer: { optionId: 'choice1' } }]);
  });
});

describe('company, teams and people', () => {
  it('hire-options lists presets, skills, models and what each team may be given', async () => {
    const { call } = await fresh(scripted().spawn, { teams: [team({ selfManaged: true }), team({ id: 'pushers', name: 'Release', mayPush: true })], options: { skillDirs: { userSkills: '/nowhere', pluginCache: '/nowhere', companySkills: '/nowhere' } } });
    const options = (await call('GET', '/api/hire-options')).json;
    expect(options.efforts.map((effort: { id: string }) => effort.id)).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(options.models.map((model: { id: string }) => model.id)).toEqual(expect.arrayContaining(['claude-fable-5-2', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']));
    expect(options.presets.map((p: any) => p.id)).toEqual(['chief_of_staff', 'engineering_lead', 'engineer', 'reviewer', 'marketing_writer', 'analyst']);
    expect(options.presets[2]).toMatchObject({ label: 'Engineer', model: 'claude-sonnet-5-5', lead: false });
    expect(options.skills.some((s: any) => s.id === 'dataviz')).toBe(true);
    expect(options.models).toEqual(expect.arrayContaining([{ id: 'claude-opus-5-5', label: 'Opus 5.5', tier: 'lead' }, { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', tier: 'member' }, { id: 'claude-haiku-5-5', label: 'Haiku 5.5', tier: 'routine' }]));
    expect(options.capabilities.map((c: any) => c.label)).toEqual(['read files', 'run commands', 'write code', 'web search', 'git push', 'send messages']);
    // "send messages" is off for every team; "git push" only where the team may push.
    expect(options.availableByTeam).toEqual({ team1: ['read_files', 'run_commands', 'write_code', 'web_search'], pushers: ['read_files', 'run_commands', 'write_code', 'web_search', 'git_push'] });
  });

  it('hires from the form and from a preset, edits, shows a person, and fires', async () => {
    const { call, w } = await fresh(scripted().spawn, { teams: [team()], employees: [] });
    const lead = await call('POST', '/api/employees', { preset: 'engineering_lead', name: 'Priya', teamId: 'team1' });
    expect(lead.json.employee).toMatchObject({ name: 'Priya', model: 'claude-opus-5-5' });
    expect(store.getTeam(w.db, 'team1')?.leadId).toBe(lead.json.employee.id);
    const ada = await call('POST', '/api/employees', { name: 'Ada', teamId: 'team1', role: 'Writes code for the app.', model: 'claude-sonnet-5-5', lead: false, skills: [], capabilities: ['read_files', 'write_code'] });
    expect(ada.status).toBe(200);
    expect((await call('POST', '/api/employees', { preset: 'engineering_lead', name: 'Second', teamId: 'team1' })).json.error).toMatch(/already has a lead/);
    expect((await call('PATCH', `/api/employees/${ada.json.employee.id}`, { role: 'Owns the roster client.' })).json.employee.role).toBe('Owns the roster client.');
    const person = (await call('GET', `/api/employees/${ada.json.employee.id}`)).json;
    expect(person).toMatchObject({ employee: { name: 'Ada' }, memoryIndex: '', runs: [], spentToday: 0 });
    expect((await call('POST', `/api/employees/${lead.json.employee.id}/fire`)).status).toBe(200);
    expect(store.getTeam(w.db, 'team1')?.leadId).toBeNull();
  });

  it('creates and edits a team, registers a repository, and edits the company', async () => {
    const repoPath = gitRepo();
    const { call, w } = await fresh();
    const repo = await call('POST', '/api/repos', { path: repoPath, gates: [{ name: 'tests', command: 'npm test', timeoutMinutes: 10, lock: null }] });
    expect(repo.status).toBe(200);
    expect((await call('POST', '/api/repos', { path: path.join(repoPath, 'nope'), gates: [] })).json.error).toMatch(/missing/);
    const made = await call('POST', '/api/teams', { name: 'Engineering iOS', purpose: 'Ships the app.', repos: [{ repoId: repo.json.repo.id, baseBranch: 'team', mergeTarget: null }] });
    expect(made.json.team).toMatchObject({ name: 'Engineering iOS', selfManaged: false, leadId: null, leaseMinutes: 15, maxReviewRounds: 3, mayPush: false, dailyCapUsd: 20 });
    expect((await call('POST', '/api/teams', { name: 'Bad', purpose: '', repos: [{ repoId: repo.json.repo.id, baseBranch: 'no-such-branch', mergeTarget: null }] })).json.error).toMatch(/no-such-branch/);
    expect((await call('PATCH', `/api/teams/${made.json.team.id}`, { dailyCapUsd: 15, repos: [{ repoId: repo.json.repo.id, baseBranch: 'team', mergeTarget: 'team' }] })).json.team).toMatchObject({ dailyCapUsd: 15, repos: [{ mergeTarget: 'team' }] });
    expect((await call('PATCH', '/api/company', { dailyCapUsd: 60, concurrency: 2 })).json.company).toMatchObject({ dailyCapUsd: 60, concurrency: 2 });
    expect((await call('PATCH', '/api/company', { concurrency: 0 })).status).toBe(400);
    expect(store.getCompany(w.db)?.concurrency).toBe(2);
  });

  it('chat goes to the chief of staff, and a message to an idle employee is a chat with that employee', async () => {
    const { call, w } = await fresh(scripted().spawn, { company: { chiefOfStaffId: 'emp1' } });
    const sent = await call('POST', '/api/chat', { text: 'Make the open seamless.' });
    expect(sent.json.message).toMatchObject({ fromId: 'user', toId: 'emp1' });
    expect(store.listTasks(w.db)).toMatchObject([{ kind: 'chat' }]);
    const direct = await call('POST', '/api/employees/emp2/message', { text: 'Draft three taglines.' });
    expect(direct.json.message).toMatchObject({ toId: 'emp2', state: 'delivered' });
    expect(store.listTasks(w.db).map((task) => [task.kind, task.assigneeId])).toEqual([['chat', 'emp1'], ['chat', 'emp2']]);
    expect((await call('GET', '/api/snapshot')).json.messages).toHaveLength(2);
  });

  it("reports spend by team and by person, and a person's own spend today", async () => {
    const { call, w } = await fresh();
    apply(
      w.db,
      (tx) => {
        tx.emit({ kind: 'run_started', run: run(), requestId: null, teamId: 'team1' });
        tx.emit({ kind: 'run_event', runId: 'run1', taskId: 'task1', employeeId: 'emp1', teamId: 'team1', event: { kind: 'usage', inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 1.25, sessionCostUsd: 1.25 } });
      },
      plus(T0, 1),
    );
    w.clock.advance(60);
    expect((await call('GET', '/api/snapshot')).json.spend).toEqual({ company: 1.25, byTeam: { team1: 1.25 }, byEmployee: { emp1: 1.25 } });
    expect((await call('GET', '/api/employees/emp1')).json.spentToday).toBe(1.25);
  });

  it('reports machine health on request', async () => {
    const probes = { diskFreeGb: async () => 80, login: async () => ({ loggedIn: true, authMethod: 'claude.ai', expiresAt: null }), repoProblem: async () => null, service: async () => true };
    const { call } = await fresh(scripted().spawn, { options: { probes } });
    expect((await call('GET', '/api/health')).json).toMatchObject({ report: { diskFreeGb: 80, login: 'ok', failures: [] } });
  });
});
