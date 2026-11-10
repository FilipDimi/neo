import { describe, expect, it } from 'vitest';
import { buildFirstTurn, buildSystemPrompt } from '../../src/supervisor/definition.ts';
import { company, employee, repo, task, team } from '../helpers.ts';

const lead = employee({ id: 'lead', name: 'Priya', role: 'Leads the iOS team.' });
const ada = employee({ skills: ['user:postgresql', 'dataviz'] });
const led = team({ leadId: 'lead', name: 'Engineering iOS', purpose: 'Ships the iPhone app.', repos: [{ repoId: 'repo1', baseBranch: 'track/ios', mergeTarget: null }] });
const prompt = (over = {}) => buildSystemPrompt({ company: company({ rules: 'Nothing invented.\nContract first.' }), team: led, employee: ada, teammates: [lead, ada], memoryIndex: '- 2026-11-08: Learned the roster shape.', ...over });

describe('buildSystemPrompt', () => {
  it('says who the employee is, on which team, with the role sentence', () => {
    const p = prompt();
    expect(p).toContain('You are Ada');
    expect(p).toContain('Engineering iOS');
    expect(p).toContain('Writes code.');
    expect(p).toContain('Ships the iPhone app.');
  });

  it("carries the company's rules verbatim", () => {
    expect(prompt()).toContain('Nothing invented.\nContract first.');
  });

  it('spells out every limit of the team and that the engine owns git', () => {
    const p = prompt();
    expect(p).toContain('never run git commit');
    for (const line of ['You may not merge', 'You may not push', 'You may not publish', 'You may not send messages', 'You may not spend money', 'You may not delete']) expect(p, line).toContain(line);
  });

  it('names the merge target when the team has one', () => {
    const merging = team({ ...led, repos: [{ repoId: 'repo1', baseBranch: 'track/ios', mergeTarget: 'track/ios' }] });
    const p = prompt({ team: merging });
    expect(p).toContain('track/ios');
    expect(p).not.toContain('You may not merge');
  });

  it('lists the skills to load first, and says nothing about skills when there are none', () => {
    expect(prompt()).toContain('user:postgresql');
    expect(prompt()).toContain('Skill tool');
    expect(prompt({ employee: employee() })).not.toContain('Skill tool');
  });

  it('includes the memory index verbatim', () => {
    expect(prompt()).toContain('- 2026-11-08: Learned the roster shape.');
  });

  it('tells a lead that it leads', () => {
    expect(prompt({ employee: lead })).toContain('lead');
  });

  it('keeps the task out of the identity: the brief belongs to the first turn', () => {
    expect(prompt()).not.toContain('Do the thing well.');
  });
});

describe('buildFirstTurn', () => {
  const base = { team: led, repo: repo({ gates: [{ name: 'tests', command: 'npm test', timeoutMinutes: 10, lock: null }] }), teammates: [lead, ada], remainingUsd: 1.5 };

  it('puts the brief, done-condition, gates and ownership in the first turn', () => {
    const turn = buildFirstTurn({ ...base, task: task({ gates: ['tests'], ownership: ['src/api'] }), mode: 'work' });
    for (const part of ['Do the thing', 'Do the thing well.', 'The thing is done.', 'tests', 'src/api', 'mcp__engine__report_done']) expect(turn, part).toContain(part);
  });

  it('a brief turn names the teammates by id, the budget left and both ways out', () => {
    const turn = buildFirstTurn({ ...base, task: task(), mode: 'brief' });
    expect(turn).toContain('emp1');
    expect(turn).toContain('Ada');
    expect(turn).toContain('$1.50');
    expect(turn).toContain('mcp__engine__propose_subtasks');
    expect(turn).toContain('mcp__engine__report_done');
  });

  it('the review turn carries the summary, the diff stat and the gate results', () => {
    const turn = buildFirstTurn({
      ...base,
      task: task(),
      mode: 'review',
      material: { summary: 'Added the person page.', diffStat: '3 files changed, 412 insertions(+)', patch: 'diff --git a/x b/x', gateResults: [{ name: 'tests', command: 'npm test', exitCode: 0, output: '737 passed', durationMs: 900 }] },
    });
    for (const part of ['Added the person page.', '412 insertions', 'diff --git', 'tests', 'passed (exit 0)', '737 passed', 'mcp__engine__submit_review']) expect(turn, part).toContain(part);
  });

  it('the integrate turn says what merged and what conflicts', () => {
    const turn = buildFirstTurn({ ...base, task: task(), mode: 'integrate', material: { mergeState: 'Merged: task/a. Conflicts in task/b: src/x.ts' } });
    expect(turn).toContain('Conflicts in task/b: src/x.ts');
    expect(turn).toContain('mcp__engine__report_done');
  });

  it('a route turn lists the teams with their ids and asks for a reply', () => {
    const turn = buildFirstTurn({ ...base, task: task({ kind: 'chat', brief: 'Make the open seamless and fix the roster.' }), mode: 'route', teams: [{ team: led, lead, members: [ada] }] });
    for (const part of ['Make the open seamless', 'team1', 'Engineering iOS', 'mcp__engine__create_task']) expect(turn, part).toContain(part);
  });
});
