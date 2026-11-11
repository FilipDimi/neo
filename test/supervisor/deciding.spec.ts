import { afterEach, describe, expect, it, vi } from 'vitest';
import { apply } from '../../src/db/apply.ts';
import * as store from '../../src/db/store.ts';
import type { Gate } from '../../src/shared/types.ts';
import { inProcess, type InProcess } from '../fixtures/inProcess.ts';
import { staged, type Scene } from '../fixtures/staged.ts';
import { employee, gitRepo, repo, team, world, type World } from '../helpers.ts';

// Real git and real gates, several times over.
vi.setConfig({ testTimeout: 20_000 });

let open: World | undefined;
afterEach(async () => {
  await open?.sup.stop();
  open = undefined;
});

const everything = ['read_files', 'run_commands', 'write_code'] as const;
const people = [
  employee({ id: 'neo', name: 'Neo', teamId: 'office', role: 'Chief of staff.', capabilities: ['read_files'] }),
  employee({ id: 'lead', name: 'Priya', role: 'Leads the team.', capabilities: [...everything] }),
  employee({ capabilities: ['read_files', 'write_code'] }),
];
const GATES: Gate[] = [{ name: 'greeting', command: 'test -f GREETING.md', timeoutMinutes: 1, lock: null }];

type Setup = { w: World; fixture: InProcess };

/** Neo is chief of staff of a company where Priya leads Ada, in a repository. Cards go to Neo first unless told otherwise. */
function company(play: (scene: Scene) => Promise<void> | void, over: { decider?: 'user' | 'chief'; mergeTarget?: string | null; maxReviewRounds?: number } = {}): Setup {
  const fixture = inProcess(staged(play));
  const w = (open = world(fixture.spawn, {
    company: { chiefOfStaffId: 'neo', decider: over.decider ?? 'chief' },
    repos: [repo({ path: gitRepo(), gates: GATES })],
    teams: [team({ id: 'office', name: 'Office', leadId: 'neo' }), team({ leadId: 'lead', maxReviewRounds: over.maxReviewRounds ?? 3, repos: [{ repoId: 'repo1', baseBranch: 'team', mergeTarget: over.mergeTarget === undefined ? 'team' : over.mergeTarget }] })],
    employees: people,
  }));
  return { w, fixture };
}

async function drain({ w, fixture }: Setup, max = 40): Promise<void> {
  let quiet = 0;
  for (let i = 0; i < max && quiet < 2; i++) {
    await w.sup.tick();
    await fixture.idle();
    await w.sup.settle();
    quiet = store.liveRuns(w.db).length === 0 && store.openRequests(w.db).length === 0 ? quiet + 1 : 0;
  }
}

const greet = (w: World, over = {}) => w.sup.createTask({ teamId: 'team1', assigneeId: 'emp1', title: 'Add a greeting', brief: 'One friendly line in GREETING.md.', doneCondition: 'GREETING.md exists.', gates: ['greeting'], capUsd: 2, ...over });

/** Ada writes the file; Priya's review is played by `review`. */
const work = (review: (s: Scene) => Promise<unknown>, decide: (s: Scene) => Promise<unknown> | void) => async (s: Scene) => {
  if (s.mode === 'work') {
    s.write('GREETING.md', s.resumed ? 'hello, reader\n' : 'yo\n');
    await s.engine('report_done', { summary: s.resumed ? 'Friendlier now.' : 'Added.' });
  }
  if (s.mode === 'review') await review(s);
  if (s.mode === 'decide') await decide(s);
};
const escalate = (s: Scene) => s.engine('submit_review', { verdict: 'escalate', notes: 'This changes the public tone; someone above me should decide.' });

describe('cards go to the chief of staff first', () => {
  it('gives an escalated review to Neo, who presses one of its buttons; the user is never asked', async () => {
    const seen: { prompt: string; tools: string[] }[] = [];
    let reviews = 0;
    const setup = company(
      work(
        (s) => (++reviews === 1 ? escalate(s) : s.engine('submit_review', { verdict: 'approve', notes: '' })),
        async (s) => {
          seen.push({ prompt: s.input.prompt, tools: s.input.engineTools?.names ?? [] });
          expect(store.forUser(setup.w.db)).toEqual([]); // while Neo decides, nothing waits for the user
          const reply = await s.engine('decide', { option: 'send_back', notes: 'Too curt for a greeting. Make it one friendly line.' });
          expect(reply.ok, reply.text).toBe(true);
          s.say('I sent "Add a greeting" back to Ada: "yo" is too curt for the first thing a reader sees.');
        },
      ),
    );
    const task = greet(setup.w);
    await drain(setup);

    // Neo was shown the card, its buttons by id, the task and where its files are.
    expect(seen).toHaveLength(1);
    expect(seen[0]!.tools).toEqual(['decide', 'set_status']);
    for (const part of ['Priya could not decide on "Add a greeting"', 'public tone', '- send_back: Send back', '- accept: Accept as it is', '- stop: Stop it', '- ask_user', 'One friendly line in GREETING.md.', 'GREETING.md', store.getTask(setup.w.db, task.id)!.folder!, 'mcp__engine__decide'])
      expect(seen[0]!.prompt, part).toContain(part);

    // The card is answered, and says who answered it.
    const [card] = store.allDecisions(setup.w.db).filter((d) => d.kind === 'review');
    expect(card).toMatchObject({ taskId: task.id, answer: { optionId: 'send_back', text: 'Too curt for a greeting. Make it one friendly line.', by: 'neo' } });
    expect(card!.answeredAt).not.toBeNull();
    // Ada was sent back with Neo's words, fixed it, and the work landed.
    expect(store.getTask(setup.w.db, task.id)).toMatchObject({ state: 'done', mergedInto: 'team' });
    expect(store.forUser(setup.w.db)).toEqual([]);
    // Deciding was a small task of Neo's own, and what Neo said at the end is its word to the user.
    const deciding = store.listTasks(setup.w.db).find((t) => t.decisionId === card!.id);
    expect(deciding).toMatchObject({ kind: 'chat', teamId: 'office', assigneeId: 'neo', state: 'done' });
    expect(store.recentMessages(setup.w.db, 50).filter((m) => m.toId === 'user').map((m) => [m.fromId, m.text])).toEqual([['neo', 'I sent "Add a greeting" back to Ada: "yo" is too curt for the first thing a reader sees.']]);
  });

  it('lets Neo merge what waits for a merge', async () => {
    const setup = company(
      work(
        (s) => s.engine('submit_review', { verdict: 'approve', notes: '' }),
        async (s) => {
          expect(s.input.prompt).toContain('- merge: Merge');
          expect(s.input.prompt).toMatch(/Approved by Priya, gates green \(greeting\)/);
          await s.engine('decide', { option: 'merge', notes: 'Reviewed and green.' });
          s.say('Merged "Add a greeting".');
        },
      ),
      { mergeTarget: null },
    );
    const task = greet(setup.w);
    await drain(setup);
    expect(store.getTask(setup.w.db, task.id)).toMatchObject({ state: 'done', mergedInto: 'team' });
    expect(store.forUser(setup.w.db)).toEqual([]);
  });

  it('hands the card to the user, with what Neo said, when only the user can decide', async () => {
    const replies: { ok: boolean; text: string }[] = [];
    const setup = company(
      work(escalate, async (s) => {
        replies.push(await s.engine('decide', { option: 'ask_user', notes: 'The tone of the product is yours to set.' }));
        s.say('This one needs you: the tone of the product is yours to set.');
      }),
    );
    const task = greet(setup.w);
    await drain(setup);
    expect(replies).toMatchObject([{ ok: true }]);
    const [card] = store.forUser(setup.w.db);
    expect(card).toMatchObject({ kind: 'review', taskId: task.id, deciderId: null, answer: null });
    expect(card!.text).toContain('Priya could not decide on "Add a greeting"');
    expect(card!.text).toContain('Neo did not decide it for you: The tone of the product is yours to set.');
    // The user's answer works as it always did.
    setup.w.sup.answer(card!.id, { optionId: 'accept' });
    await drain(setup);
    expect(store.getTask(setup.w.db, task.id)).toMatchObject({ state: 'done', mergedInto: 'team' });
  });

  it('gives the card to the user when Neo ends without deciding, or cannot run', async () => {
    for (const how of ['says nothing useful', 'fails'] as const) {
      const setup = company(
        work(escalate, (s) => {
          if (how === 'fails') s.fail('error_during_execution');
          s.say('Hm.');
        }),
      );
      const task = greet(setup.w);
      await drain(setup);
      const waiting = store.forUser(setup.w.db);
      expect(waiting.map((d) => [d.kind, d.taskId]), how).toEqual([['review', task.id]]); // the one card, and none about Neo's own run
      expect(waiting[0]!.text, how).toContain('Neo did not decide it for you');
      await setup.w.sup.stop();
    }
  });

  it('refuses a button the card does not have, and an answer with no words', async () => {
    const replies: { ok: boolean; text: string }[] = [];
    const setup = company(
      work(escalate, async (s) => {
        replies.push(await s.engine('decide', { option: 'merge', notes: 'Ship it.' }));
        replies.push(await s.engine('decide', { option: 'send_back', notes: '  ' }));
        replies.push(await s.engine('decide', { option: 'accept', notes: 'The tone is fine for an internal file.' }));
        replies.push(await s.engine('decide', { option: 'stop', notes: 'Changed my mind.' }));
        s.say('Accepted.');
      }),
    );
    const task = greet(setup.w);
    await drain(setup);
    expect(replies.map((r) => r.ok)).toEqual([false, false, true, false]);
    expect(replies[0]!.text).toMatch(/send_back, accept, stop, ask_user/);
    expect(replies[1]!.text).toMatch(/notes/);
    expect(replies[3]!.text).toMatch(/already/);
    expect(store.getTask(setup.w.db, task.id)).toMatchObject({ state: 'done', mergedInto: 'team' });
  });

  it('stops deciding the same thing over and over: the third card of a kind on one task is the user\'s', async () => {
    let decided = 0;
    const setup = company(
      work(escalate, async (s) => {
        decided += 1;
        await s.engine('decide', { option: 'send_back', notes: 'Friendlier.' });
        s.say('Sent back.');
      }),
      { maxReviewRounds: 9 },
    );
    const task = greet(setup.w);
    await drain(setup, 80);
    expect(decided).toBe(2);
    expect(store.forUser(setup.w.db).map((d) => [d.kind, d.taskId])).toEqual([['review', task.id]]);
    expect(store.forUser(setup.w.db)[0]!.text).toContain('Neo has decided this twice already');
  });

  it('keeps money, tools and questions about Neo\'s own work with the user', async () => {
    const setup = company(async (s) => {
      if (s.mode === 'work') await s.engine('request_tools', { capabilities: ['run_commands'], reason: 'I need to run the linter.' });
      if (s.mode === 'decide') throw new Error('Neo must not be asked about tools');
    });
    greet(setup.w);
    await drain(setup);
    expect(store.forUser(setup.w.db).map((d) => d.kind)).toEqual(['capability']);
    expect(store.listTasks(setup.w.db).filter((t) => t.decisionId)).toEqual([]);
  });

  it('asks the user, as before, in a company that has not turned this on', async () => {
    const setup = company(
      work(escalate, () => {
        throw new Error('nobody asked Neo');
      }),
      { decider: 'user' },
    );
    const task = greet(setup.w);
    await drain(setup);
    expect(store.forUser(setup.w.db)).toMatchObject([{ kind: 'review', taskId: task.id }]);
    expect(store.forUser(setup.w.db)[0]!.deciderId ?? null).toBeNull();
  });

  it('gives the card to the user when the chief of staff is fired while deciding', async () => {
    const setup = company(work(escalate, () => new Promise(() => {}))); // Neo never answers
    const task = greet(setup.w);
    for (let i = 0; i < 6; i++) {
      await setup.w.sup.tick();
      await new Promise((resolve) => setTimeout(resolve, 20));
      await setup.w.sup.settle();
    }
    expect(store.forUser(setup.w.db)).toEqual([]);
    expect(store.openDecisions(setup.w.db)).toMatchObject([{ kind: 'review', deciderId: 'neo' }]);
    apply(setup.w.db, (tx) => {
      tx.emit({ kind: 'employee_changed', employee: { ...store.getEmployee(setup.w.db, 'neo')!, fired: true } });
      tx.emit({ kind: 'company_changed', company: { ...store.getCompany(setup.w.db)!, chiefOfStaffId: null } });
    });
    await setup.w.sup.tick();
    expect(store.forUser(setup.w.db)).toMatchObject([{ kind: 'review', taskId: task.id, deciderId: null }]);
  });
});
