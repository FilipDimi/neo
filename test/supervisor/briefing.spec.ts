import { describe, expect, it } from 'vitest';
import { validateProposal } from '../../src/supervisor/briefing.ts';
import type { SubtaskProposal } from '../../src/worker/protocol.ts';
import { employee, repo, task, team } from '../helpers.ts';

const sub = (over: Partial<SubtaskProposal> = {}): SubtaskProposal => ({ title: 'Part', assigneeId: 'emp1', brief: 'Do part.', ownership: ['src/a'], doneCondition: 'Part done.', gates: [], priority: 2, capUsd: 0.5, retryAllowed: true, ...over });
const led = team({ leadId: 'lead' });
const people = [employee({ id: 'lead' }), employee(), employee({ id: 'emp2' }), employee({ id: 'gone', fired: true }), employee({ id: 'stranger', teamId: 'other' })];
const repoWithGate = repo({ gates: [{ name: 'tests', command: 'npm test', timeoutMinutes: 5, lock: null }] });
const check = (subtasks: SubtaskProposal[], parent = task({ capUsd: 2 }), spent = 0) => validateProposal({ parent, team: led, employees: people, repo: repoWithGate, remainingUsd: parent.capUsd - spent, subtasks });
const codes = (subtasks: SubtaskProposal[], parent?: Parameters<typeof check>[1], spent?: number) => {
  const result = check(subtasks, parent, spent);
  return result.ok ? [] : result.reasons.map((r) => r.code);
};

describe('validateProposal', () => {
  it('accepts a valid proposal', () => {
    expect(check([sub(), sub({ assigneeId: 'emp2', ownership: ['src/b'], gates: ['tests'] })])).toEqual({ ok: true });
  });

  it('refuses overlapping ownership between siblings, and names them', () => {
    const result = check([sub({ title: 'API', ownership: ['src/api'] }), sub({ title: 'Routes', assigneeId: 'emp2', ownership: ['src/api/routes.ts'] })]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasons).toMatchObject([{ code: 'overlap', text: expect.stringMatching(/API.*Routes/) }]);
  });

  it('treats a sub-task that owns everything as overlapping every sibling', () => {
    expect(codes([sub({ ownership: [] }), sub({ assigneeId: 'emp2', ownership: ['docs'] })])).toEqual(['overlap']);
  });

  it('refuses a sub-task that owns more than the task it is a part of', () => {
    const narrow = task({ capUsd: 2, ownership: ['src/api', 'docs/api.md'] });
    expect(codes([sub({ ownership: ['src/api/routes.ts'] }), sub({ title: 'Docs', assigneeId: 'emp2', ownership: ['docs/api.md'] })], narrow)).toEqual([]);
    expect(codes([sub({ ownership: ['src/ui'] })], narrow)).toEqual(['outside_parent']);
    expect(codes([sub({ ownership: ['README.md'] })], narrow)).toEqual(['outside_parent']);
    // An empty list owns everything, which is more than a task that owns something.
    expect(codes([sub({ ownership: [] })], narrow)).toEqual(['outside_parent']);
    // A task that owns everything can be split any way.
    expect(codes([sub({ ownership: ['anything/at/all'] })], task({ capUsd: 2, ownership: [] }))).toEqual([]);
    const told = check([sub({ ownership: ['src/ui'] })], narrow);
    expect(told.ok ? '' : told.reasons[0]!.text).toMatch(/src\/ui.*src\/api, docs\/api\.md/);
  });

  it('refuses an assignee who is unknown, on another team, or fired', () => {
    expect(codes([sub({ assigneeId: 'nobody' })])).toEqual(['unknown_assignee']);
    expect(codes([sub({ assigneeId: 'stranger' })])).toEqual(['assignee_not_in_team']);
    expect(codes([sub({ assigneeId: 'gone' })])).toEqual(['assignee_fired']);
  });

  it('refuses an unknown gate and caps beyond what the parent has left', () => {
    expect(codes([sub({ gates: ['lint'] })])).toEqual(['unknown_gate']);
    expect(codes([sub({ capUsd: 1.5 }), sub({ assigneeId: 'emp2', ownership: ['src/b'], capUsd: 1 })])).toEqual(['caps_exceed_parent']);
    expect(codes([sub({ capUsd: 1 })], task({ capUsd: 2 }), 1.5)).toEqual(['caps_exceed_parent']);
  });

  it('refuses more than eight sub-tasks', () => {
    const many = Array.from({ length: 9 }, (_, i) => sub({ title: `Part ${i}`, ownership: [`src/p${i}`], capUsd: 0.1 }));
    expect(codes(many)).toEqual(['too_many']);
  });

  it('refuses a proposal on a task that is itself a child', () => {
    expect(codes([sub()], task({ parentId: 'grandparent' }))).toEqual(['parent_is_a_child']);
  });

  it('reports every reason at once', () => {
    expect(codes([sub({ assigneeId: 'nobody', gates: ['lint'] })]).sort()).toEqual(['unknown_assignee', 'unknown_gate']);
  });
});
