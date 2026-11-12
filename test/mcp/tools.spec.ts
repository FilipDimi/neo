import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { loadToken } from '../../src/api/security.ts';
import { buildServer } from '../../src/api/server.ts';
import { apply } from '../../src/db/apply.ts';
import * as store from '../../src/db/store.ts';
import { caller, runTool, TOOLS, type Ctx } from '../../src/mcp/tools.ts';
import { recordDecision } from '../../src/supervisor/record.ts';
import { inProcess, type InProcess } from '../fixtures/inProcess.ts';
import { looked, staged, type Scene } from '../fixtures/staged.ts';
import { employee, team, tempDir, world, type World } from '../helpers.ts';

const people = [
  employee({ id: 'neo', name: 'Neo', teamId: 'office', role: 'Chief of staff.', capabilities: ['read_files'] }),
  employee({ id: 'lead', name: 'Priya', teamId: 'ios', role: 'Leads iOS.' }),
  employee({ id: 'ada', name: 'Ada', teamId: 'ios' }),
  employee({ id: 'mw', name: 'Mara', teamId: 'marketing', role: 'Writes copy.' }),
  employee({ id: 'morpheus', name: 'Morpheus', teamId: 'office', role: 'Runs this app.' }),
];
const teams = [team({ id: 'office', name: 'Office', leadId: 'neo' }), team({ id: 'ios', name: 'Engineering iOS', leadId: 'lead' }), team({ id: 'marketing', name: 'Marketing', selfManaged: true })];

type Company = { w: World; fixture: InProcess; app: FastifyInstance; port: number; ctx: Ctx; use(name: string, args?: object): Promise<{ text: string; isError: boolean }> };
let open: Company | undefined;
afterEach(async () => {
  await open?.app.close();
  await open?.w.sup.stop();
  open = undefined;
});

/** A company with its engine listening, and its tools pointed at it the way the real ones are: over HTTP, with the token. */
async function company(play: (scene: Scene) => Promise<void> | void): Promise<Company> {
  const fixture = inProcess(staged(play));
  const w = world(fixture.spawn, { company: { chiefOfStaffId: 'neo', adminId: 'morpheus' }, teams, employees: people });
  const app = await buildServer({ db: w.db, dataDir: w.dir, supervisor: w.sup, port: 0, webDir: tempDir() });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const port = (app.server.address() as AddressInfo).port;
  const ctx: Ctx = { call: caller(port, loadToken(path.join(w.dir, 'token'))), pollMs: 10, waitMs: 3000 };
  // While a tool waits for an answer the company has to be at work, as the real one is.
  const use = async (name: string, args: object = {}) => {
    let done = false;
    const result = runTool(name, args, ctx).finally(() => (done = true));
    while (!done) {
      await w.sup.tick();
      // A session may be stuck on purpose (a test of waiting): do not wait for it for ever.
      await Promise.race([fixture.idle(), new Promise((resolve) => setTimeout(resolve, 20))]);
      await w.sup.settle();
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return result;
  };
  return (open = { w, fixture, app, port, ctx, use });
}

describe("the company's tools for a Claude session", () => {
  it('says what the company is doing right now', async () => {
    const c = await company(() => new Promise(() => {}));
    c.w.sup.createTask({ teamId: 'marketing', assigneeId: 'mw', title: 'App Store description', brief: 'Write it.' });
    const now = await c.use('now');
    expect(now.isError).toBe(false);
    expect(now.text).toContain('Marketing');
    expect(now.text).toContain('App Store description');
  });

  it('talks to the chief of staff and comes back with the reply', async () => {
    const c = await company((s) => void (s.mode === 'route' && s.say('Nothing is running, and nothing is waiting for you.')));
    const reply = await c.use('chat', { text: 'What is going on?' });
    expect(reply).toEqual({ isError: false, text: 'Neo: Nothing is running, and nothing is waiting for you.' });
    expect(store.recentMessages(c.w.db, 5).map((message) => [message.fromId, message.toId])).toEqual([['user', 'neo'], ['neo', 'user']]);
  });

  it('writes to an employee by name, and says who there is when the name is not known', async () => {
    const c = await company((s) => void (s.mode === 'route' && s.say('We are between tasks.')));
    expect(await c.use('message', { to: 'priya', text: 'yo, what are we working on?' })).toEqual({ isError: false, text: 'Priya: We are between tasks.' });
    const unknown = await c.use('message', { to: 'Zed', text: 'hello' });
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toMatch(/Nobody here is called "Zed".*Neo, Priya, Ada, Mara, Morpheus/);
  });

  it('talks to Morpheus, the admin, and comes back with what he changed', async () => {
    const c = await company((s) => void (s.mode === 'route' && s.say('Removed the team Marketing, and fired Mara.')));
    expect(await c.use('morpheus', { text: 'remove marketing' })).toEqual({ isError: false, text: 'Morpheus: Removed the team Marketing, and fired Mara.' });
  });

  it('changes the setup directly, with the same tools Morpheus has, and refuses in words', async () => {
    const c = await company(() => {});
    expect((await c.use('company_setup')).text).toMatch(/Teams:\n- Office/);
    expect(await c.use('create_team', { name: 'Design', purpose: 'Designs the app.', selfManaged: true, dailyCapUsd: 5 })).toMatchObject({ isError: false, text: expect.stringMatching(/Created the team Design/) });
    expect(store.allTeams(c.w.db).map((entry) => entry.name)).toContain('Design');
    expect(await c.use('update_employee', { employee: 'Mara', model: 'Fable 5.2', effort: 'xhigh' })).toMatchObject({ isError: false, text: expect.stringMatching(/Mara: model Fable 5\.2, extra high effort/) });
    expect(await c.use('remove_team', { team: 'Sales' })).toMatchObject({ isError: true, text: expect.stringMatching(/no team "Sales"/) });
    expect((await c.use('remove_team', { team: 'Design' })).text).toMatch(/Removed the team Design/);
  });

  it('says so when no reply came in time, and shows it later', async () => {
    let release: (() => void) | undefined;
    const c = await company(async (s) => {
      if (s.mode !== 'route') return;
      await new Promise<void>((resolve) => (release = resolve));
      s.say('Sorry, that took a while: nothing is running.');
    });
    c.ctx.waitMs = 60;
    const first = await c.use('chat', { text: 'What is going on?' });
    expect(first.isError).toBe(false);
    expect(first.text).toMatch(/Neo has not answered yet/);
    release!();
    c.ctx.waitMs = 3000;
    await c.use('now');
    expect((await c.use('replies')).text).toContain('Neo: Sorry, that took a while: nothing is running.');
  });

  it('lists the cards waiting for the user with their buttons, and presses one', async () => {
    const c = await company(async (s) => {
      if (s.mode !== 'work') return;
      if (!s.resumed) return void (await s.engine('request_decision', { question: 'Formal or friendly?', options: ['Formal', 'Friendly'] }));
      await s.engine('report_done', { summary: 'Wrote it friendly.' });
    });
    c.w.sup.createTask({ teamId: 'marketing', assigneeId: 'mw', title: 'App Store description', brief: 'Write it.' });
    await c.use('now');
    const cards = await c.use('cards');
    const [card] = store.openDecisions(c.w.db);
    expect(cards.text).toContain(card!.id);
    expect(cards.text).toContain('Mara asks about "App Store description": Formal or friendly?');
    expect(cards.text).toMatch(/choice1: Formal.*choice2: Friendly.*answer: Answer.*stop: Stop it/s);
    // A button that is not on the card is refused, with the ones that are.
    const wrong = await c.use('answer_card', { card: card!.id, option: 'merge' });
    expect(wrong.isError).toBe(true);
    expect(wrong.text).toMatch(/choice1, choice2, answer, stop/);
    expect((await c.use('answer_card', { card: card!.id, option: 'choice2' })).text).toMatch(/Pressed "Friendly"/);
    await c.use('now');
    expect((await c.use('cards')).text).toBe('No card is waiting for you.');
    expect(store.getTask(c.w.db, card!.taskId!)!.state).toBe('done');
  });

  it('puts a task on a team by name, lists the tasks, and shows one with its runs', async () => {
    const c = await company(async (s) => void (s.mode === 'work' && (await s.engine('report_done', { summary: 'Three taglines written.' }))));
    const made = await c.use('new_task', { team: 'marketing', assignee: 'Mara', title: 'Taglines', brief: 'Draft three taglines.', doneCondition: 'Three taglines.' });
    expect(made.isError).toBe(false);
    const [task] = store.listTasks(c.w.db).filter((entry) => entry.kind === 'work');
    expect(made.text).toContain(task!.id);
    await c.use('now');
    expect((await c.use('tasks')).text).toMatch(new RegExp(`${task!.id}.*Taglines.*Marketing.*done`));
    const one = await c.use('task', { id: task!.id });
    expect(one.text).toContain('Draft three taglines.');
    expect(one.text).toMatch(/work by Mara: done.*Three taglines written\./s);
    // No gate and nothing listed: nothing is said to have been checked.
    expect(one.text).not.toContain('Checked:');
    expect((await c.use('new_task', { team: 'Sales', title: 'x', brief: 'y' })).text).toMatch(/There is no team "Sales".*Office, Engineering iOS, Marketing/);
  });

  it('says who finished a task its lead took, and keeps a card someone is deciding out of "waiting on you"', async () => {
    const c = await company(async (s) => {
      if (s.mode === 'brief') {
        s.write('TAB.md', 'Renamed.\n');
        return void (await s.engine('report_done', { summary: 'Did it myself.' }));
      }
      if (s.mode === 'review') await s.engine('submit_review', { verdict: 'approve', notes: '', findings: [], ...looked(s) });
    });
    const made = c.w.sup.createTask({ teamId: 'ios', title: 'Rename the tab', brief: 'Rename it.' });
    for (let i = 0; i < 4; i++) await c.use('now');
    const now = (await c.use('now')).text;
    expect(now, now).toMatch(/"Rename the tab" \(done\): finished today by Priya/);
    // A card of that task that Neo is deciding for the user is not the user's to answer yet.
    const card = { id: 'card1', taskId: made.id, runId: null, employeeId: null, kind: 'question' as const, text: 'Formal or friendly?', options: [{ id: 'stop', label: 'Stop it', effect: 'stop_task' as const }], costSoFarUsd: 0, answer: null, askedAt: c.w.clock.now().toISOString(), answeredAt: null, deciderId: 'neo' };
    apply(c.w.db, (tx) => tx.emit({ kind: 'decision_raised', decision: card }));
    const one = (await runTool('task', { id: made.id }, c.ctx)).text;
    expect(one).not.toContain('Waiting on you');
    expect(one).toMatch(/Neo is deciding for you:\n- card card1: Formal or friendly\?/);
  });

  it('says so when a card had already been answered, and presses nothing', async () => {
    const c = await company(async (s) => void (s.mode === 'work' && !s.resumed && (await s.engine('request_decision', { question: 'Formal or friendly?', options: ['Formal', 'Friendly'] }))));
    c.w.sup.createTask({ teamId: 'marketing', assigneeId: 'mw', title: 'App Store description', brief: 'Write it.' });
    await c.use('now');
    const [card] = store.openDecisions(c.w.db);
    // Answered on the screen in the moment between this tool reading the cards and pressing the button.
    const real = c.ctx.call;
    c.ctx.call = (async (method: 'GET' | 'POST', route: string, body?: unknown) => {
      if (method === 'POST' && route.endsWith('/answer')) c.w.sup.answer(card!.id, { optionId: 'stop' });
      return real(method, route, body);
    }) as typeof real;
    const said = await c.use('answer_card', { card: card!.id, option: 'choice1' });
    expect(said.text).toMatch(/already been answered/);
    expect(said.text).not.toMatch(/Pressed/);
  });

  it('answers "what was decided" from the record: all of it, by who decided, by words, or nothing', async () => {
    const c = await company(() => {});
    const add = (statement: string, why: string, by: 'user' | 'chief' | 'lead', employeeId: string | null) => apply(c.w.db, (tx) => void recordDecision(tx, c.w.db, c.w.clock.now(), { statement, why, by: { kind: by, employeeId } }));
    expect((await c.use('decisions')).text).toBe('Nothing on record matches.');
    add('Launch in one region.', 'Nobody said which, and one is cheaper to run.', 'chief', 'neo');
    add('Errors are problem+json.', 'One shape for every client.', 'lead', 'lead');
    add('The store page is friendly.', '', 'user', null);
    const all = (await c.use('decisions')).text;
    expect(all).toMatch(/^D-3 · \d{4}-\d\d-\d\d · you\nThe store page is friendly\.\n\nD-2 · .* · Priya\nErrors are problem\+json\.\nWhy: One shape for every client\./);
    const mine = (await c.use('decisions', { by: 'chief' })).text;
    expect(mine).toMatch(/^D-1 · .* · Neo, for you\nLaunch in one region\.\nWhy: Nobody said which/);
    expect(mine).not.toContain('D-2');
    expect((await c.use('decisions', { search: 'problem json', since: 'today' })).text).toMatch(/^D-2 /);
    expect((await c.use('decisions', { search: 'nothing like it' })).text).toBe('Nothing on record matches.');
  });

  it('says plainly when the company is not running', async () => {
    const result = await runTool('now', {}, { call: caller(1, 'no-token') });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/not running/);
    expect(result.text).toContain('npm run live');
  });

  it('is a server a Claude session can start: it lists its tools and answers through them', async () => {
    const c = await company(() => {});
    c.w.sup.createTask({ teamId: 'marketing', assigneeId: 'mw', title: 'App Store description', brief: 'Write it.' });
    const root = path.resolve(import.meta.dirname, '../..');
    const transport = new StdioClientTransport({ command: path.join(root, 'node_modules/.bin/tsx'), args: [path.join(root, 'src/mcp/server.ts')], env: { ...(process.env as Record<string, string>), VS_PORT: String(c.port), VS_DATA_DIR: c.w.dir } });
    const client = new Client({ name: 'test', version: '0' });
    try {
      await client.connect(transport);
      expect(client.getInstructions()).toMatch(/Ask the user before/);
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name).sort()).toEqual(TOOLS.map((tool) => tool.name).sort());
      const answer = (await client.callTool({ name: 'now', arguments: {} })) as { content: { type: string; text: string }[]; isError?: boolean };
      expect(answer.isError ?? false).toBe(false);
      expect(answer.content[0]!.text).toContain('App Store description');
    } finally {
      await client.close();
    }
  }, 30_000);
});
