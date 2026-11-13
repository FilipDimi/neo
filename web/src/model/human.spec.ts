import { describe, expect, it } from 'vitest';
import type { EventRow } from '../../../src/shared/events.ts';
import { company, decision, employee, plus, run, T0, task, team } from '../../../test/rows.ts';
import { fromSnapshot, type Snapshot } from '../store/reduce.ts';
import { STORY_KINDS } from '../../../src/shared/view.ts';
import { placement } from '../office/placement.ts';
import { happenings, memoryNotes, modelName, personView, priorityWord, stateWord, taskPath } from './human.ts';
import { personStatus } from './select.ts';

const people = [employee({ id: 'neo', name: 'Neo', teamId: 'office' }), employee({ id: 'lead', name: 'Priya' }), employee(), employee({ id: 'emp2', name: 'Grace' })];
const teams = [team({ id: 'office', name: 'Office', leadId: 'neo' }), team({ leadId: 'lead' })];
const snapshot = (over: Partial<Snapshot> = {}): Snapshot => ({ version: 1, company: company({ chiefOfStaffId: 'neo' }), repos: [], teams, employees: people, tasks: [], runs: [], requests: [], decisions: [], messages: [], health: null, lastEventId: 0, spend: { company: 0, byTeam: {}, byEmployee: {} }, ...over }) as Snapshot;
const storeOf = (over: Partial<Snapshot> = {}) => fromSnapshot(snapshot(over));
const hoursAgo = (hours: number) => plus(T0, -hours * 3600).toISOString();

describe('a model, as people say it', () => {
  it('names a model by its family and version, and leaves alone what it does not know', () => {
    expect(modelName('claude-sonnet-5-5')).toBe('Sonnet 5.5');
    expect(modelName('claude-fable-5-2')).toBe('Fable 5.2');
    expect(modelName('claude-haiku-4-5-20251001')).toBe('Haiku 4.5');
    expect(modelName('gpt-something')).toBe('gpt-something');
    expect(modelName('')).toBe('');
  });
});

describe('what a person remembers, as notes', () => {
  it('reads dated lines into notes, newest first, and keeps any other line as it is', () => {
    const notes = memoryNotes('- 2026-11-08: Learned the roster shape.\n- 2026-11-10: Runbook: add a table of contents: Added it.\nloose line\n\n');
    expect(notes).toEqual([
      { date: '10 Nov', text: 'Runbook: add a table of contents: Added it.' },
      { date: '8 Nov', text: 'Learned the roster shape.' },
      { date: '', text: 'loose line' },
    ]);
    expect(memoryNotes('')).toEqual([]);
  });
});

describe('a person, at a glance', () => {
  it('says who they are and what they are doing, in a sentence each', () => {
    const working = run({ id: 'r1', employeeId: 'emp1', taskId: 'task1', startedAt: plus(T0, -12 * 60).toISOString() });
    const store = storeOf({ tasks: [task({ title: 'Serve the stages', state: 'running', assigneeId: 'emp1' })], runs: [working] });
    expect(personView(store, 'emp1', [working], T0)).toMatchObject({ who: 'Engineering team. Working now.', doing: { text: 'Working on "Serve the stages", for 12 min', taskId: 'task1' } });
    expect(personView(store, 'lead', [], T0)).toMatchObject({ who: 'Leads Engineering. Free right now.', doing: null });
    expect(personView(store, 'neo', [], T0)).toMatchObject({ who: 'Chief of staff. Free right now.' });
    expect(personView(store, 'nobody', [], T0)).toBeNull();
  });

  it('says a reviewer is reviewing, and someone a card is about is waiting on you', () => {
    const reviewing = run({ id: 'r2', mode: 'review', employeeId: 'lead', taskId: 'task1', startedAt: plus(T0, -60).toISOString() });
    const inReview = storeOf({ tasks: [task({ title: 'Serve the stages', state: 'review' })], runs: [reviewing] });
    expect(personView(inReview, 'lead', [reviewing], T0)).toMatchObject({ who: 'Leads Engineering. Reviewing now.', doing: { text: 'Reviewing "Serve the stages", for 1 min' } });
    const blocked = storeOf({ tasks: [task({ title: 'Serve the stages', state: 'blocked', assigneeId: 'emp1' })], decisions: [decision({ kind: 'question' })] });
    expect(personView(blocked, 'emp1', [], T0)).toMatchObject({ who: 'Engineering team. Waiting on you.', doing: { text: 'Waiting on you about "Serve the stages"', taskId: 'task1' } });
  });

  it('sums up the week in one sentence, and lists recent work by task, newest first', () => {
    const tasks = [
      task({ id: 'a', title: 'Serve the stages', state: 'review' }),
      task({ id: 'b', title: 'Contract 0.10.1', state: 'done', mergedInto: 'team' }),
      task({ id: 'c', title: 'Old work', state: 'done' }),
      task({ id: 'chat', kind: 'chat', title: 'A chat' }),
    ];
    const runs = [
      run({ id: '1', taskId: 'c', employeeId: 'emp1', outcome: 'done', startedAt: hoursAgo(24 * 9), endedAt: hoursAgo(24 * 9) }),
      run({ id: '2', taskId: 'b', employeeId: 'emp1', mode: 'review', outcome: 'done', reason: 'approved', startedAt: hoursAgo(26), endedAt: hoursAgo(26) }),
      run({ id: '3', taskId: 'a', employeeId: 'emp1', outcome: 'done', startedAt: hoursAgo(3), endedAt: hoursAgo(2) }),
      run({ id: '4', taskId: 'a', employeeId: 'emp1', outcome: 'done', startedAt: hoursAgo(2), endedAt: hoursAgo(2) }),
      run({ id: '5', taskId: 'chat', employeeId: 'emp1', mode: 'route', outcome: 'done', startedAt: hoursAgo(1), endedAt: hoursAgo(1) }),
    ];
    const seen = personView(storeOf({ tasks, runs }), 'emp1', runs, T0)!;
    expect(seen.week).toBe('This week Ada worked on 1 task and reviewed 1.');
    expect(seen.recent).toEqual([
      { taskId: 'a', title: 'Serve the stages', did: 'worked on it', state: 'In review', when: '2 h ago', open: true },
      { taskId: 'b', title: 'Contract 0.10.1', did: 'reviewed it', state: 'Landed', when: '1 d ago', open: true },
      { taskId: 'c', title: 'Old work', did: 'worked on it', state: 'Done', when: '9 d ago', open: true },
    ]);
    expect(personView(storeOf({ tasks }), 'emp2', [], T0)!.week).toBe('Grace has not worked on anything this week.');
  });

  it('wears what they wear in the office: the team\'s colour, white for a lead, dark for the chief of staff', () => {
    const store = storeOf();
    expect(personView(store, 'lead', [], T0)!.portrait.shirt).toBe('#F4F4F6');
    expect(personView(store, 'neo', [], T0)!.portrait.shirt).toBe('#2A2A2E');
    expect(personView(store, 'emp1', [], T0)!.portrait.shirt).toBe(personView(store, 'emp2', [], T0)!.portrait.shirt);
    expect(personView(store, 'emp1', [], T0)!.portrait.shirt).toMatch(/^#[0-9A-F]{6}$/i);
  });
});

describe('a task, in a word and as a path', () => {
  const at = (over: Partial<Parameters<typeof task>[0]>, more: Partial<Snapshot> = {}) => storeOf({ tasks: [task(over)], ...more });
  const steps = (store: ReturnType<typeof storeOf>) => taskPath(store, 'task1').map((step) => `${step.label}:${step.state}`);

  it('says in a word or two where a task stands', () => {
    expect(stateWord(at({ state: 'queued' }), 'task1')).toBe('Waiting to start');
    expect(stateWord(at({ state: 'briefing' }), 'task1')).toBe('Being planned');
    expect(stateWord(at({ state: 'running' }), 'task1')).toBe('Being worked on');
    expect(stateWord(at({ state: 'review' }), 'task1')).toBe('In review');
    expect(stateWord(at({ state: 'blocked' }, { decisions: [decision({ kind: 'question' })] }), 'task1')).toBe('Waiting on you');
    expect(stateWord(at({ state: 'blocked' }, { decisions: [decision({ kind: 'review', deciderId: 'neo' })] }), 'task1')).toBe('Being decided');
    expect(stateWord(at({ state: 'done', mergedInto: 'team' }), 'task1')).toBe('Landed');
    expect(stateWord(at({ state: 'done' }), 'task1')).toBe('Done');
    expect(stateWord(at({ state: 'failed' }), 'task1')).toBe('Stopped');
  });

  it('shows the path a task takes, and the step it is on', () => {
    expect(steps(at({ state: 'queued' }))).toEqual(['Asked:now', 'Built:next', 'Checked:next', 'Done:next']);
    expect(steps(at({ state: 'running' }))).toEqual(['Asked:done', 'Built:now', 'Checked:next', 'Done:next']);
    expect(steps(at({ state: 'review' }))).toEqual(['Asked:done', 'Built:done', 'Checked:now', 'Done:next']);
    expect(steps(at({ state: 'done', mergedInto: 'team' }))).toEqual(['Asked:done', 'Built:done', 'Checked:done', 'Landed:done']);
    // Waiting on someone: the step it was on is held, not lost.
    expect(steps(at({ state: 'blocked', blockedFrom: 'review' }))).toEqual(['Asked:done', 'Built:done', 'Checked:held', 'Done:next']);
    // Stopped while it was being built.
    expect(steps(at({ state: 'failed' }, { runs: [run({ outcome: 'stopped', endedAt: T0.toISOString() })] }))).toEqual(['Asked:done', 'Built:stopped', 'Checked:next', 'Done:next']);
    expect(taskPath(storeOf(), 'nothing')).toEqual([]);
  });

  it('says a priority in a word', () => {
    expect([1, 2, 3].map((p) => priorityWord(p as 1 | 2 | 3))).toEqual(['High', 'Normal', 'Low']);
  });
});

describe('what happened on a task, in plain sentences', () => {
  const store = storeOf({ tasks: [task({ title: 'Serve the stages', createdBy: 'neo' })] });
  const row = (id: number, event: EventRow['event'], minutes = id): EventRow => ({ id, at: plus(T0, minutes * 60).toISOString(), taskId: 'task1', runId: null, employeeId: null, teamId: null, event });
  const work = run({ id: 'w', employeeId: 'emp1' });
  const review = run({ id: 'r', mode: 'review', employeeId: 'lead' });

  it('tells who did what, what the checks said and who decided, newest first, with no command in it', () => {
    const rows: EventRow[] = [
      row(1, { kind: 'task_changed', task: task({ createdBy: 'neo' }), cause: 'created' }),
      row(2, { kind: 'run_started', run: work, requestId: null, teamId: 'team1' }),
      row(3, { kind: 'run_event', runId: 'w', taskId: 'task1', employeeId: 'emp1', teamId: 'team1', event: { kind: 'tool_call', id: 't', tool: 'Bash', input: { command: 'cargo test' } } }),
      row(4, { kind: 'run_ended', run: { ...work, outcome: 'done', endedAt: T0.toISOString() }, teamId: 'team1' }),
      row(5, { kind: 'gate_finished', runId: 'w', taskId: 'task1', result: { name: 'rust', command: 'cargo test', exitCode: 0, output: '', durationMs: 1 } }),
      row(6, { kind: 'gate_finished', runId: 'w', taskId: 'task1', result: { name: 'contract', command: 'x', exitCode: 2, output: '', durationMs: 1 } }),
      row(7, { kind: 'run_started', run: review, requestId: null, teamId: 'team1' }),
      row(8, { kind: 'run_ended', run: { ...review, outcome: 'done', reason: 'sent_back', endedAt: T0.toISOString(), findings: [{ severity: 'blocking', file: 'a', title: 'x', why: '', fix: '' }, { severity: 'minor', file: 'b', title: 'y', why: '', fix: '' }] }, teamId: 'team1' }),
      row(9, { kind: 'decision_answered', decision: decision({ kind: 'merge', answer: { optionId: 'merge' }, answeredAt: T0.toISOString(), options: [{ id: 'merge', label: 'Merge', effect: 'merge' }] }), result: 'applied' }),
      row(10, { kind: 'task_changed', task: task({ state: 'done', mergedInto: 'team' }), cause: 'state' }),
    ];
    const told = happenings(rows, store, plus(T0, 3600));
    expect(told.map((one) => one.text)).toEqual([
      'It landed on team.',
      'You decided: Merge.',
      'Priya sent it back: 1 thing to fix.',
      'Priya started reviewing it.',
      'The check "contract" failed.',
      'The check "rust" passed.',
      'Ada reported it done.',
      'Ada started working on it.',
      'Neo asked for it.',
    ]);
    expect(told[0]!.at).toMatch(/^\d\d:\d\d$/);
  });

  it("tells a run's ending once, though the engine writes it down again when the work is committed", () => {
    const done = { ...work, outcome: 'done' as const, endedAt: T0.toISOString() };
    const told = happenings([row(1, { kind: 'run_started', run: work, requestId: null, teamId: 'team1' }), row(2, { kind: 'run_ended', run: done, teamId: 'team1' }), row(3, { kind: 'run_ended', run: { ...done, commit: 'abc', diffLines: 9 }, teamId: 'team1' })], store, T0);
    expect(told.map((one) => one.text)).toEqual(['Ada reported it done.', 'Ada started working on it.']);
    expect(told[0]!.id).toBe(2);
  });

  it('says that work after a send-back is a fix', () => {
    const again = run({ id: 'w2', employeeId: 'emp1' });
    const told = happenings(
      [
        row(1, { kind: 'run_ended', run: { ...review, outcome: 'done', reason: 'sent_back', endedAt: T0.toISOString() }, teamId: 'team1' }),
        row(2, { kind: 'run_started', run: again, requestId: null, teamId: 'team1' }),
        row(3, { kind: 'run_ended', run: { ...again, outcome: 'done', endedAt: T0.toISOString() }, teamId: 'team1' }),
        row(4, { kind: 'run_started', run: { ...review, id: 'r2' }, requestId: null, teamId: 'team1' }),
        row(5, { kind: 'run_ended', run: { ...review, id: 'r2', outcome: 'done', reason: 'approved', endedAt: T0.toISOString() }, teamId: 'team1' }),
        row(6, { kind: 'run_started', run: { ...again, id: 'w3' }, requestId: null, teamId: 'team1' }),
      ],
      store,
      T0,
    );
    expect(told.map((one) => one.text)).toEqual(['Ada started working on it.', 'Priya approved it.', 'Priya started reviewing it.', 'Ada reported it fixed.', 'Ada started fixing it.', 'Priya sent it back.']);
  });

  it('says how a run ended when it did not end well, and leaves out what says nothing', () => {
    const ended = (reason: string, outcome: 'stopped' | 'expired' | 'failed' = 'stopped') => happenings([row(1, { kind: 'run_ended', run: { ...work, outcome, reason, endedAt: T0.toISOString() }, teamId: 'team1' })], store, T0)[0]?.text;
    expect(ended('question')).toBe('Ada stopped with a question.');
    expect(ended('stopped_by_user')).toBe("You stopped Ada's run.");
    expect(ended('no_progress')).toBe('Ada was stopped: it was getting nowhere.');
    expect(ended('waiting')).toBe('Ada is waiting for another task.');
    expect(ended('silent', 'expired')).toBe("Ada's run went silent.");
    expect(ended('crashed', 'failed')).toBe("Ada's run failed.");
    expect(happenings([row(1, { kind: 'run_activity', runId: 'w', taskId: 'task1', employeeId: 'emp1', text: 'typing' })], store, T0)).toEqual([]);
  });
});

describe('what the review of these screens found', () => {
  const daysAgo = (days: number, minute = 0) => new Date(T0.getTime() - days * 24 * 3600_000 + minute * 60_000).toISOString();

  it("counts a person's week from all their runs, also on tasks the board no longer holds, and says which of them still open", () => {
    // Eight tasks finished two days ago. The board holds the last three; the page is given a line for each.
    const done = Array.from({ length: 8 }, (_, i) => task({ id: `t${i}`, title: `Ticket ${i}`, state: 'done', mergedInto: i === 0 ? 'main' : null, assigneeId: 'emp1' }));
    const runs = done.map((one, i) => run({ id: `r${i}`, taskId: one.id, employeeId: 'emp1', outcome: 'done', startedAt: daysAgo(2, i), endedAt: daysAgo(2, i) }));
    const lines = done.map(({ id, title, kind, state, mergedInto }) => ({ id, title, kind, state, mergedInto }));
    const seen = personView(storeOf({ tasks: done.slice(5) }), 'emp1', runs, T0, lines)!;
    expect(seen.week).toBe('This week Ada worked on 8 tasks.');
    expect(seen.recent.map((work) => [work.title, work.open])).toEqual([['Ticket 7', true], ['Ticket 6', true], ['Ticket 5', true], ['Ticket 4', false], ['Ticket 3', false], ['Ticket 2', false], ['Ticket 1', false], ['Ticket 0', false]]);
    expect(seen.recent.at(-1)).toMatchObject({ did: 'worked on it', state: 'Landed' });
    // A run on a task nothing is known of is left out, as before.
    expect(personView(storeOf(), 'emp1', runs, T0)!.week).toBe('Ada has not worked on anything this week.');
  });

  it('says "Waiting on you" only about a card on your desk: one the chief of staff is deciding is said as that, and opens its task', () => {
    const store = storeOf({ company: company({ chiefOfStaffId: 'neo', decider: 'chief' }), tasks: [task({ title: 'Serve the stages', state: 'blocked', blockedFrom: 'running', assigneeId: 'emp1' })], decisions: [decision({ kind: 'question', deciderId: 'neo' })] });
    expect(stateWord(store, 'task1')).toBe('Being decided');
    const seen = personView(store, 'emp1', [], T0)!;
    expect(seen.who).toBe('Engineering team. Waiting for a decision.');
    // Nor is that person shown as stuck anywhere else: stuck is waiting on you.
    expect(personStatus(store, 'emp1')).toBe('idle');
    expect(seen.doing).toEqual({ text: 'Neo is deciding about "Serve the stages"', taskId: 'task1' });
  });

  it('says what is waiting on you when the card is about their run on a task that is not assigned to them', () => {
    const silent = run({ id: 'r1', employeeId: 'lead', mode: 'brief', outcome: 'expired', reason: 'silent', endedAt: T0.toISOString() });
    const store = storeOf({ tasks: [task({ title: 'Serve the stages', state: 'blocked', blockedFrom: 'briefing', assigneeId: null })], runs: [silent], decisions: [decision({ kind: 'lease', employeeId: 'lead', runId: 'r1' })] });
    expect(placement('lead', store, T0)).toMatchObject({ where: 'stuck', taskId: 'task1' });
    const seen = personView(store, 'lead', [silent], T0)!;
    expect(seen.who).toBe('Leads Engineering. Waiting on you.');
    expect(seen.doing).toEqual({ text: 'Waiting on you about "Serve the stages"', taskId: 'task1' });
  });

  const steps = (store: ReturnType<typeof storeOf>) => taskPath(store, 'task1').map((step) => `${step.label}:${step.state}`);

  it('a task stopped while its lead was answering a question was stopped while being built, not at the check', () => {
    const asked = run({ id: 'w', employeeId: 'emp1', outcome: 'stopped', reason: 'question', startedAt: plus(T0, -600).toISOString(), endedAt: plus(T0, -300).toISOString() });
    const answer = run({ id: 'a', employeeId: 'lead', mode: 'review', outcome: 'done', reason: 'escalated', startedAt: plus(T0, -200).toISOString(), endedAt: plus(T0, -100).toISOString() });
    expect(steps(storeOf({ tasks: [task({ state: 'failed', assigneeId: 'emp1' })], runs: [asked, answer] }))).toEqual(['Asked:done', 'Built:stopped', 'Checked:next', 'Done:next']);
    // Stopped after a real review of reported work, it had reached the check.
    const reported = { ...asked, outcome: 'done' as const, reason: null };
    expect(steps(storeOf({ tasks: [task({ state: 'failed', assigneeId: 'emp1' })], runs: [reported, { ...answer, reason: 'sent_back' }] }))).toEqual(['Asked:done', 'Built:done', 'Checked:stopped', 'Done:next']);
  });

  it('a ticket closed as not needed was asked for and ended there: nothing was built or checked', () => {
    const store = storeOf({ tasks: [task({ state: 'done', parentId: 'whole', dropped: { by: 'lead', why: 'Covered by another ticket.' } })] });
    expect(steps(store)).toEqual(['Asked:done', 'Built:next', 'Checked:next', 'Not needed:done']);
    expect(stateWord(store, 'task1')).toBe('Not needed');
  });

  describe('in what happened', () => {
    const store = storeOf({ tasks: [task({ title: 'Serve the stages' })] });
    const row = (id: number, event: EventRow['event'], at: Date = plus(T0, id * 60)): EventRow => ({ id, at: at.toISOString(), taskId: 'task1', runId: null, employeeId: null, teamId: null, event });
    const work = run({ id: 'w', employeeId: 'emp1' });
    const review = run({ id: 'r', mode: 'review', employeeId: 'lead' });
    const ended = (one: typeof work, over: Partial<typeof work>) => ({ ...one, outcome: 'done' as const, endedAt: T0.toISOString(), ...over });

    it('an approval the engine turned into a send-back, because a check it relied on failed, is told as that, and the work after it is a fix', () => {
      const again = run({ id: 'w2', employeeId: 'emp1' });
      const told = happenings(
        [
          row(1, { kind: 'run_started', run: review, requestId: null, teamId: 'team1' }),
          row(2, { kind: 'run_ended', run: ended(review, { reason: 'approved' }), teamId: 'team1' }),
          row(3, { kind: 'gate_finished', runId: 'r', taskId: 'task1', result: { name: 'tests', command: 'npm test', exitCode: 1, output: '', durationMs: 1 } }),
          row(4, { kind: 'run_ended', run: ended(review, { reason: 'sent_back' }), teamId: 'team1' }),
          row(5, { kind: 'run_started', run: again, requestId: null, teamId: 'team1' }),
          row(6, { kind: 'run_ended', run: ended(again, {}), teamId: 'team1' }),
          row(7, { kind: 'run_ended', run: ended(again, { commit: 'abc' }), teamId: 'team1' }),
        ],
        store,
        plus(T0, 3600),
      ).map((one) => one.text);
      expect(told).toEqual(['Ada reported it fixed.', 'Ada started fixing it.', "Priya's approval did not stand: a check it relied on failed, so it went back.", 'The check "tests" failed.', 'Priya approved it.', 'Priya started reviewing it.']);
    });

    it("a lead's answer to a question is told as that, not as a review, and the work after it is not a fix", () => {
      const again = run({ id: 'w2', employeeId: 'emp1' });
      const told = happenings(
        [
          row(1, { kind: 'run_started', run: work, requestId: null, teamId: 'team1' }),
          row(2, { kind: 'run_ended', run: { ...work, outcome: 'stopped', reason: 'question', endedAt: T0.toISOString() }, teamId: 'team1' }),
          row(3, { kind: 'run_started', run: review, requestId: null, teamId: 'team1' }),
          row(4, { kind: 'run_ended', run: ended(review, { reason: 'answered' }), teamId: 'team1' }),
          row(5, { kind: 'run_started', run: again, requestId: null, teamId: 'team1' }),
          row(6, { kind: 'run_ended', run: ended(again, {}), teamId: 'team1' }),
          row(7, { kind: 'run_started', run: { ...review, id: 'r2' }, requestId: null, teamId: 'team1' }),
        ],
        store,
        plus(T0, 3600),
      ).map((one) => one.text);
      expect(told).toEqual(['Priya started reviewing it.', 'Ada reported it done.', 'Ada started working on it.', 'Priya answered a question about it.', 'Priya took the question.', 'Ada stopped with a question.', 'Ada started working on it.']);
    });

    it('tells what happened long ago by its date, what happened this week by its day, and today by the hour', () => {
      const created = (id: number, days: number) => row(id, { kind: 'task_changed', task: task(), cause: 'created' }, new Date(T0.getTime() - days * 24 * 3600_000));
      const [today, yesterday, lastWeek] = happenings([created(1, 8), created(2, 1), created(3, 0)], store, T0).map((one) => one.at);
      expect(today).toMatch(/^\d\d:\d\d$/);
      expect(yesterday).toMatch(/^[A-Z][a-z]{2} \d\d:\d\d$/);
      expect(lastWeek).toMatch(/^\d{1,2} [A-Z][a-z]{2}$/);
    });

    it('is told only from the kinds of event the engine keeps for the story', () => {
      const kinds = [
        row(1, { kind: 'task_changed', task: task(), cause: 'created' }),
        row(2, { kind: 'run_started', run: work, requestId: null, teamId: 'team1' }),
        row(3, { kind: 'run_ended', run: ended(work, {}), teamId: 'team1' }),
        row(4, { kind: 'gate_finished', runId: 'w', taskId: 'task1', result: { name: 'rust', command: 'x', exitCode: 0, output: '', durationMs: 1 } }),
        row(5, { kind: 'decision_raised', decision: decision({ kind: 'merge' }) }),
        row(6, { kind: 'decision_answered', decision: decision({ kind: 'merge', answer: { optionId: 'merge' }, answeredAt: T0.toISOString(), options: [{ id: 'merge', label: 'Merge', effect: 'merge' }] }), result: 'applied' }),
        row(7, { kind: 'run_activity', runId: 'w', taskId: 'task1', employeeId: 'emp1', text: 'typing' }),
        row(8, { kind: 'task_changed', task: task({ claims: ['a.ts'] }), cause: 'edited' }),
      ];
      const told = happenings(kinds, store, plus(T0, 3600));
      expect(told.map((one) => one.id).sort()).toEqual([1, 2, 3, 4, 5, 6]);
      for (const one of told) expect(STORY_KINDS).toContain(kinds.find((each) => each.id === one.id)!.event.kind);
    });
  });
});
