import { describe, expect, it } from 'vitest';
import { company, decision, employee, plus, run, T0, task, team } from '../../../test/rows.ts';
import { storyAt, taskTitled } from '../fixtures/story.ts';
import { fromSnapshot, type Snapshot } from '../store/reduce.ts';
import { board, deck, header, orgChart, spendToday } from './select.ts';

const snapshot = (over: Partial<Snapshot> = {}): Snapshot => ({ version: 1, company: company(), repos: [], teams: [team()], employees: [employee()], tasks: [], runs: [], requests: [], decisions: [], messages: [], health: null, planUsage: null, spend: { company: 0, byTeam: {}, byEmployee: {} }, lastEventId: 1, now: T0.toISOString(), ...over });
const column = (store: ReturnType<typeof fromSnapshot>, key: string, now = T0) => board(store, now).find((c) => c.key === key)!;
const sum = (numbers: number[]) => numbers.reduce((a, b) => a + b, 0);

describe('header', () => {
  it("counts seats busy from live runs against the company's concurrency", () => {
    const { store, now } = storyAt('parts_running');
    expect(header(store, now)).toMatchObject({ company: 'Receipts Inc.', clock: expect.stringMatching(/^Mon 09:\d\d$/), seatsBusy: 3, seats: 3, capToday: 40, paused: null });
  });

  it("the header's spend equals the sum of the teams' spend", () => {
    const { store, now } = storyAt('cards_answered');
    const spend = spendToday(store);
    expect(spend.company).toBeGreaterThan(0);
    expect(sum(spend.byTeam.map((t) => t.usd))).toBeCloseTo(spend.company, 10);
    expect(header(store, now).spentToday).toBe(spend.company);
    expect(spend.byTeam.map((t) => t.name)).toEqual(expect.arrayContaining(['Engineering · iOS', 'Engineering · Rust', 'Marketing']));
  });

  it('counts open decisions and says when the company is paused', () => {
    const { store, now } = storyAt('paused');
    const top = header(store, now);
    expect(top.openDecisions).toBe(store.decisions.size - [...store.decisions.values()].filter((d) => d.answeredAt !== null).length);
    expect(top.paused).toMatch(/usage limit/);
    expect(header(storyAt('resumed').store, now).paused).toBeNull();
  });

  it('survives a company that does not exist yet', () => {
    expect(header(fromSnapshot(snapshot({ company: null })), T0)).toMatchObject({ company: '', seats: 0, seatsBusy: 0 });
  });
});

describe('deck', () => {
  it('orders the deck newest first, names the team, and marks the first option primary', () => {
    const { store, now } = storyAt('cards_open');
    const cards = deck(store, now);
    expect(cards.map((c) => c.kind).sort()).toEqual(['lease', 'merge', 'question', 'tool']);
    const asked = cards.map((c) => store.decisions.get(c.id)!.askedAt);
    expect([...asked].sort().reverse()).toEqual(asked);
    const lease = cards.find((c) => c.kind === 'lease')!;
    expect(lease).toMatchObject({ team: 'Engineering · iOS', taskId: taskTitled(store, 'Nav-hang recorder')!.id });
    expect(lease.options.map((o) => [o.label, o.primary])).toEqual([['Retry, 20 min', true], ['Stop it', false]]);
    expect(lease.age).toMatch(/min$/);
  });

  it('offers Open diff only for a card whose task has a branch, Read it first for a question or a refusal, and Not now always', () => {
    const { store, now } = storyAt('cards_open');
    const cards = deck(store, now);
    expect(cards.find((c) => c.kind === 'merge')!.local).toEqual(['open_diff', 'not_now']);
    expect(cards.find((c) => c.kind === 'tool')!.local).toEqual(['read_first', 'not_now']);
    expect(cards.find((c) => c.kind === 'question')!.local).toEqual(['open_diff', 'read_first', 'not_now']);
    const usage = deck(storyAt('paused').store, now).find((c) => c.kind === 'usage_limit')!;
    expect(usage).toMatchObject({ team: null, taskId: null, local: ['not_now'] });
  });

  it('leaves answered cards out', () => {
    const { store, now } = storyAt('cards_answered');
    expect(deck(store, now).map((c) => c.kind).sort()).toEqual(['lease', 'merge']);
  });
});

describe('board', () => {
  it('has six columns in order, and puts every work task in exactly one', () => {
    const { store, now } = storyAt('cards_open');
    const columns = board(store, now);
    expect(columns.map((c) => c.key)).toEqual(['queued', 'briefing', 'running', 'review', 'blocked', 'done']);
    expect(columns.map((c) => c.title)).toEqual(['Queued', 'Briefing', 'Running', 'Review', 'Blocked', 'Done today']);
    const shown = columns.flatMap((c) => c.cards.map((card) => card.taskId));
    const work = [...store.tasks.values()].filter((t) => t.kind === 'work');
    expect(new Set(shown).size).toBe(shown.length);
    expect(shown.length + sum(columns.map((c) => c.more))).toBe(work.length);
    expect(sum(columns.map((c) => c.count))).toBe(work.length);
  });

  it('leaves the chat with the chief of staff off the board', () => {
    const { store, now } = storyAt('chat_routing');
    expect(sum(board(store, now).map((c) => c.count))).toBe(0);
  });

  it('a queued card reads "<team> · from <creator> · P1 · cap $2"', () => {
    const store = fromSnapshot(snapshot({ employees: [employee({ id: 'neo', name: 'Neo' })], tasks: [task({ priority: 1, capUsd: 2, createdBy: 'neo' }), task({ id: 't2', createdBy: 'user', createdAt: plus(T0, 5).toISOString(), capUsd: 2.5 })] }));
    expect(column(store, 'queued').cards.map((c) => c.line2)).toEqual(['Engineering · from Neo · P1 · cap $2', 'Engineering · from you · P2 · cap $2.50']);
    expect(column(store, 'queued').cards[0]).toMatchObject({ attention: 'none', line3: null, failed: false });
  });

  it('a running card reads its assignee, its elapsed time and its spend, and what it is doing', () => {
    const now = plus(T0, 41 * 60);
    const live = run({ startedAt: T0.toISOString(), lastEventAt: plus(now, -40).toISOString(), leaseUntil: plus(now, 600).toISOString(), costUsd: 2.1 });
    const store = fromSnapshot(snapshot({ tasks: [task({ state: 'running', assigneeId: 'emp1' })], runs: [live] }));
    expect(column(store, 'running', now).cards[0]).toMatchObject({ line2: 'Engineering · Ada · 41 min · $2.10', line3: 'event 40 s ago', attention: 'working' });
  });

  it('a review card reads "<author> → <reviewer>" and its diff size', () => {
    const { store, now } = storyAt('c2_in_review');
    const card = column(store, 'review', now).cards.find((c) => c.title.startsWith('C2 Person page'))!;
    expect(card.line2).toBe('Engineering · iOS · C2 → iOS lead');
    expect(card.line3).toMatch(/^diff \d+ lines · gates passed$/);
    expect(card.attention).toBe('review');
  });

  it('a blocked card says why, and a silent one is marked silent', () => {
    const { store, now } = storyAt('lease_card');
    const card = column(store, 'blocked', now).cards.find((c) => c.title === 'Nav-hang recorder')!;
    expect(card).toMatchObject({ attention: 'silent', line3: '2 runs · lease expired twice · decision open 0 s' });
    expect(card.line2).toMatch(/^Engineering · iOS · NH · \$/);
  });

  it('shows a task failed today at the top of Done today, marked failed, and a merged one with its target', () => {
    const { store, now } = storyAt('cards_answered');
    const done = column(store, 'done', now);
    expect(done.cards[0]).toMatchObject({ title: 'Re-run the 29 refused plain drafts', failed: true, line3: 'stopped' });
    const merged = done.cards.find((c) => c.title === 'Make the open seamless')!;
    expect(merged.line2).toMatch(/merged track\/ios/);
    expect(merged.failed).toBe(false);
  });

  it('limits Done today to eight cards and counts the rest, and leaves out what finished before today', () => {
    const today = new Date(2026, 10, 9, 15, 0);
    const finished = Array.from({ length: 11 }, (_, i) => task({ id: `d${i}`, state: 'done', updatedAt: new Date(2026, 10, 9, 10, i).toISOString() }));
    const yesterday = task({ id: 'old', state: 'done', updatedAt: new Date(2026, 10, 8, 22, 0).toISOString() });
    const done = column(fromSnapshot(snapshot({ tasks: [...finished, yesterday] })), 'done', today);
    expect(done).toMatchObject({ count: 11, more: 3 });
    expect(done.cards.map((c) => c.taskId)).toEqual(['d10', 'd9', 'd8', 'd7', 'd6', 'd5', 'd4', 'd3']);
  });
});

describe('orgChart', () => {
  it('lists the chief of staff, then each team with its lead and members, as the Hire artboard does', () => {
    const { store, now } = storyAt('start');
    const chart = orgChart(store, now);
    expect(chart.chief).toMatchObject({ name: 'Neo', status: 'idle' });
    expect(chart.teams.map((t) => t.name)).toEqual(['Engineering · iOS', 'Engineering · Rust', 'Marketing']);
    expect(chart.teams[0]).toMatchObject({ summary: 'led · $20/day · may merge: track/ios', lead: { name: 'iOS lead' } });
    expect(chart.teams[0]!.members.map((m) => m.name)).toEqual(['MO', 'A6', 'A3', 'C1', 'C2', 'NH']);
    expect(chart.teams[1]!.summary).toBe('led · $15/day · may merge: no');
    expect(chart.teams[2]).toMatchObject({ summary: 'self-managed · $5/day · may publish: no', lead: null });
  });

  it('shows who is working, who is reviewing, and who is stuck', () => {
    const running = orgChart(storyAt('parts_running').store, storyAt('parts_running').now);
    expect(running.teams[0]!.members.find((m) => m.name === 'MO')!.status).toBe('working');
    const reviewing = orgChart(storyAt('review_running').store, storyAt('review_running').now);
    expect(reviewing.teams[0]!.lead!.status).toBe('reviewing');
    const stuck = orgChart(storyAt('lease_card').store, storyAt('lease_card').now);
    expect(stuck.teams[0]!.members.find((m) => m.name === 'NH')!.status).toBe('stuck');
    expect(orgChart(storyAt('chat_routing').store, storyAt('chat_routing').now).chief!.status).toBe('working');
  });

  it('leaves fired people out', () => {
    const store = fromSnapshot(snapshot({ employees: [employee(), employee({ id: 'gone', fired: true })] }));
    expect(orgChart(store, T0).teams[0]!.members.map((m) => m.id)).toEqual(['emp1']);
  });
});

describe('a decision without a task', () => {
  it('is on the deck with no team', () => {
    const store = fromSnapshot(snapshot({ decisions: [decision({ taskId: null, kind: 'health', text: 'Disk is low.', options: [{ id: 'recheck', label: 'Check again', effect: 'recheck' }] })] }));
    expect(deck(store, T0)).toMatchObject([{ kind: 'health', team: null, text: 'Disk is low.' }]);
  });
});
