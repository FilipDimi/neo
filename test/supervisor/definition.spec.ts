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

  it('says which tools the employee has and which it has not, and how to ask for one', () => {
    const text = buildSystemPrompt({ company: company(), team: led, employee: { ...ada, capabilities: ['read_files', 'write_code'] }, teammates: [lead, ada], memoryIndex: '' });
    expect(text).toMatch(/You can: read files, write code\./);
    expect(text).toMatch(/You cannot: run commands, web search\./);
    expect(text).toContain('mcp__engine__request_tools');
  });

  it('tells a reviewer that the run only reads, whatever tools the employee has in its own work', () => {
    const all = { ...ada, capabilities: ['read_files', 'run_commands', 'write_code', 'web_search'] as const };
    const text = buildSystemPrompt({ company: company(), team: led, employee: { ...all, capabilities: [...all.capabilities] }, teammates: [lead, ada], memoryIndex: '', mode: 'review' });
    expect(text).toMatch(/You can: read files, web search\./);
    expect(text).toMatch(/This run is a review, so it only reads/);
    expect(text).toContain('mcp__engine__run_gate');
    // Neither offered as a tool it has, nor as one it could ask for.
    expect(text).not.toMatch(/You can(not)?: [^\n]*(run commands|write code)/);
    expect(text).not.toContain('cannot reach the network');
  });

  it('tells an employee that runs commands that they cannot reach the network, and to build offline', () => {
    const runs = buildSystemPrompt({ company: company(), team: led, employee: { ...ada, capabilities: ['read_files', 'run_commands'] }, teammates: [lead, ada], memoryIndex: '' });
    expect(runs).toMatch(/Your commands cannot reach the network/);
    expect(runs).toContain('--offline');
    const reads = buildSystemPrompt({ company: company(), team: led, employee: { ...ada, capabilities: ['read_files'] }, teammates: [lead, ada], memoryIndex: '' });
    expect(reads).not.toContain('cannot reach the network');
  });

  it('tells the employee to assume and carry on, and to ask only when carrying on would be wrong', () => {
    const text = prompt();
    expect(text).toMatch(/make the reasonable assumption, say so in your report, and carry on/);
    expect(text).toMatch(/Ask once/);
    expect(text).toMatch(/An answer is only words/);
  });

  it('says to carry on when a skill cannot be loaded', () => {
    expect(prompt()).toMatch(/If one cannot be loaded, carry on without it/);
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

  it('tells a briefing lead to look first, to split anything bigger than one small change, and that open-ended work is always split', () => {
    const turn = buildFirstTurn({ ...base, task: task(), mode: 'brief' });
    expect(turn).toMatch(/First look at what it touches/);
    expect(turn).toMatch(/bigger than one small change/);
    expect(turn).toMatch(/open-ended: a review, an audit/);
    expect(turn).toMatch(/only when it is one small change you can finish and check in this run/);
    expect(turn).toMatch(/that is an instruction: split/);
  });

  it('tells a briefing lead which gates a sub-task can carry: only ones that pass with that part alone', () => {
    const turn = buildFirstTurn({ task: task({ gates: ['all'] }), mode: 'brief', team: led, repo: repo({ gates: [{ name: 'all', command: 'npm test', timeoutMinutes: 5, lock: null }, { name: 'unit', command: 'npm run unit', timeoutMinutes: 5, lock: null }] }), teammates: [lead, ada], remainingUsd: 2 });
    expect(turn).toMatch(/A sub-task's gates run on that sub-task's work alone/);
    expect(turn).toMatch(/The gates of this task \(all\) are run on the whole when you put the parts together/);
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

  it('the integrate turn of a task with no repository says where each part is, what is in it and what its author reported', () => {
    const parts = [
      { title: 'Half one', by: 'Ada', folder: '/data/folders/aaa', summary: 'Wrote the first half.', files: ['half-one.md', 'notes/sources.md'], more: 0 },
      { title: 'Half two', by: 'Grace', folder: '/data/folders/bbb', summary: null, files: [], more: 0 },
    ];
    const turn = buildFirstTurn({ task: task({ title: 'Plan the launch' }), mode: 'integrate', team: team({ leadId: 'lead', repos: [] }), repo: null, teammates: [], remainingUsd: 0, material: { parts } });
    expect(turn).not.toMatch(/merged their branches/);
    expect(turn).toMatch(/"Half one", by Ada, in \/data\/folders\/aaa/);
    expect(turn).toContain('half-one.md, notes/sources.md');
    expect(turn).toContain('Wrote the first half.');
    expect(turn).toMatch(/"Half two", by Grace, in \/data\/folders\/bbb/);
    expect(turn).toMatch(/no files/);
    expect(turn).toContain('mcp__engine__report_done');
  });

  it('a route turn lists the teams with their ids and asks for a reply', () => {
    const turn = buildFirstTurn({ ...base, task: task({ kind: 'chat', brief: 'Make the open seamless and fix the roster.' }), mode: 'route', teams: [{ team: led, lead, members: [ada] }] });
    for (const part of ['Make the open seamless', 'team1', 'Engineering iOS', 'mcp__engine__create_task']) expect(turn, part).toContain(part);
  });
});
