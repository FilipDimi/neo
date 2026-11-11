import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { apply } from '../../src/db/apply.ts';
import { paths } from '../../src/db/dataDir.ts';
import { openDb } from '../../src/db/open.ts';
import * as store from '../../src/db/store.ts';
import type { SkillRef } from '../../src/runtime/skills.ts';
import { ADMIN_TOOLS } from '../../src/shared/adminTools.ts';
import { adminTool, companySetup } from '../../src/supervisor/admin.ts';
import { company, employee, gitRepo, repo, T0, team, tempDir } from '../helpers.ts';

const skill = (id: string): SkillRef => ({ id, label: id, description: id, source: 'user', path: `/skills/${id}` });
const SKILLS = [skill('dataviz'), skill('user:rust-skills'), ...['swift', 'swiftui', 'testing'].map((name) => skill(`apple-skills:${name}`))];

/** A company with a Rust team (lead and one engineer) on a repository, and Neo on the Office team. */
function setup() {
  const dir = tempDir();
  const db = openDb(paths(dir).db);
  const repoPath = gitRepo(['track/rust', 'track/ios']);
  apply(db, (tx) => {
    tx.emit({ kind: 'company_changed', company: company({ chiefOfStaffId: 'neo', dailyCapUsd: 10, concurrency: 2 }) });
    tx.emit({ kind: 'repo_changed', repo: repo({ id: 'receipts', path: repoPath, gates: [] }) });
    tx.emit({ kind: 'team_changed', team: team({ id: 'office', name: 'Office', leadId: 'neo' }) });
    tx.emit({ kind: 'team_changed', team: team({ id: 'rust', name: 'Rust', leadId: 'rust-pm', dailyCapUsd: 8, repos: [{ repoId: 'receipts', baseBranch: 'track/rust', mergeTarget: null }] }) });
    for (const person of [employee({ id: 'neo', name: 'Neo', teamId: 'office' }), employee({ id: 'rust-pm', name: 'rust-pm', teamId: 'rust', model: 'claude-opus-5-5' }), employee({ id: 'api', name: 'api-engineer', teamId: 'rust', model: 'claude-sonnet-5-5', capabilities: ['read_files', 'run_commands', 'write_code'] })]) {
      tx.emit({ kind: 'employee_changed', employee: person });
    }
  });
  const ctx = { db, now: T0, paths: paths(dir), skills: SKILLS };
  const use = (name: string, input: object) => adminTool(ctx, name, input);
  return { db, ctx, use, repoPath };
}

describe("Morpheus's tools", () => {
  it('describes the whole setup: teams, people with their models, caps, rules, repositories and what can be given', () => {
    const { ctx } = setup();
    const text = companySetup(ctx);
    expect(text).toMatch(/Daily cap \$10, 2 runs at once/);
    expect(text).toMatch(/Rust \(led by rust-pm; \$8 a day; works in .* on track\/rust, merges by card\)/);
    expect(text).toMatch(/api-engineer: Sonnet 5\.5, the model's own effort; tools read files, run commands, write code/);
    expect(text).toMatch(/Skill sets: apple-skills \(3\)/);
    expect(text).toContain('Rules every employee gets:');
  });

  it('sets up a team and its people in plain words: a set of skills by its name, a model by its label', async () => {
    const { db, use } = setup();
    expect(await use('create_team', { name: 'iOS', purpose: 'Builds the app.', repo: 'receipts', baseBranch: 'track/ios', dailyCapUsd: 15, buildsWithXcode: true })).toMatch(/Created the team iOS/);
    const ios = store.allTeams(db).find((entry) => entry.name === 'iOS')!;
    expect(ios).toMatchObject({ dailyCapUsd: 15, selfManaged: false, repos: [{ repoId: 'receipts', baseBranch: 'track/ios', mergeTarget: null }] });
    expect(ios.sandboxWrite).toContain('~/Library/Developer/Xcode');
    expect(await use('hire', { team: 'ios', name: 'ios-pm', role: 'Leads iOS.', model: 'Opus 5.5', effort: 'high', lead: true, tools: ['read_files', 'run_commands', 'write_code'], skills: ['apple-skills'] })).toMatch(/Hired ios-pm on iOS/);
    const pm = store.allEmployees(db).find((person) => person.name === 'ios-pm')!;
    expect(pm).toMatchObject({ teamId: ios.id, model: 'claude-opus-5-5', effort: 'high', skills: ['apple-skills:swift', 'apple-skills:swiftui', 'apple-skills:testing'] });
    expect(store.getTeam(db, ios.id)!.leadId).toBe(pm.id);
    expect(await use('update_employee', { employee: 'IOS-PM', model: 'Fable 5.2', effort: null })).toMatch(/ios-pm: model Fable 5\.2, the model's own effort/);
    expect(store.getEmployee(db, pm.id)).toMatchObject({ model: 'claude-fable-5-2', effort: null });
    expect(await use('update_team', { team: 'iOS', dailyCapUsd: 20 })).toMatch(/iOS \(led by ios-pm; \$20 a day/);
  });

  it('changes the company: its cap, how many run at once, the rules, and a repository\'s gates', async () => {
    const { db, use, repoPath } = setup();
    expect(await use('update_company', { dailyCapUsd: 30, concurrency: 3 })).toMatch(/daily cap \$30 \(was \$10\).*3 runs at once \(was 2\)/);
    expect(await use('update_company', { addRule: '- Every report names the boards it built.' })).toMatch(/rules/);
    expect(store.getCompany(db)!.rules).toMatch(/Every report names the boards it built\.$/);
    expect(await use('set_gates', { repo: repoPath, gates: [{ name: 'ios-branch', command: 'bash ios/scripts/ci-test.sh', timeoutMinutes: 45, lock: 'xcode' }] })).toMatch(/ios-branch/);
    expect(store.getRepo(db, 'receipts')!.gates).toMatchObject([{ name: 'ios-branch', lock: 'xcode' }]);
  });

  it('sets who decides cards first: the chief of staff on the user\'s behalf, or the user', async () => {
    const { db, use } = setup();
    expect(await use('company_setup', {})).toMatch(/Decisions come to the user\./);
    expect(await use('update_company', { decider: 'chief' })).toMatch(/decisions go to .* first \(were the user's\)/);
    expect(store.getCompany(db)!.decider).toBe('chief');
    expect(await use('company_setup', {})).toMatch(/Decisions go to .* first, who answers them for the user; money, tools, hiring and the machine stay with the user\./);
    expect(await use('update_company', { decider: 'chief' })).toMatch(/Nothing changed/);
    expect(await use('update_company', { decider: 'user' })).toMatch(/decisions come to the user \(went to .* first\)/);
  });

  it('can stop counting cost: nothing is stopped for it, and the setup no longer speaks of caps', async () => {
    const { db, ctx, use } = setup();
    expect(await use('update_company', { costs: 'off' })).toMatch(/cost is no longer counted: no cap stops work, and no spend is shown/);
    expect(store.getCompany(db)!.costs).toBe('off');
    const text = companySetup(ctx);
    expect(text).not.toMatch(/\$\d/);
    expect(text).toMatch(/Cost is not counted: nothing is stopped for it and it is not shown\./);
    expect(await use('update_company', { costs: 'on' })).toMatch(/cost is counted again/);
    expect(companySetup(ctx)).toMatch(/Daily cap \$10/);
  });

  it('removes a team and fires someone, and says who went', async () => {
    const { db, use } = setup();
    expect(await use('fire', { employee: 'api-engineer' })).toMatch(/Fired api-engineer/);
    expect(store.getEmployee(db, 'api')!.fired).toBe(true);
    expect(await use('remove_team', { team: 'Rust' })).toMatch(/Removed the team Rust.*rust-pm/);
    expect(store.allTeams(db).map((entry) => entry.name)).toEqual(['Office']);
  });

  it('refuses in words it can act on: an unknown team, person, model or skill, a branch that does not exist', async () => {
    const { use } = setup();
    await expect(use('hire', { team: 'Sales', name: 'x', role: 'x', model: 'Opus 5.5', tools: ['read_files'] })).rejects.toThrow(/no team "Sales".*Office, Rust/);
    await expect(use('update_employee', { employee: 'nobody', role: 'x' })).rejects.toThrow(/nobody here called "nobody"/i);
    await expect(use('hire', { team: 'Rust', name: 'x', role: 'x', model: 'GPT-9', tools: ['read_files'] })).rejects.toThrow(/no model "GPT-9".*Fable 5\.2/);
    await expect(use('hire', { team: 'Rust', name: 'x', role: 'x', model: 'Opus 5.5', tools: ['read_files'], skills: ['figma'] })).rejects.toThrow(/no skill or set "figma"/);
    await expect(use('create_team', { name: 'Web', purpose: 'x', repo: 'receipts', baseBranch: 'track/web' })).rejects.toThrow(/no branch "track\/web"/);
    await expect(use('make_coffee', {})).rejects.toThrow(/no admin tool make_coffee/);
  });

  it('lists every tool it offers', () => {
    expect(ADMIN_TOOLS).toEqual(['company_setup', 'create_team', 'update_team', 'remove_team', 'hire', 'update_employee', 'fire', 'update_company', 'add_repository', 'set_gates']);
  });

  it('registers a repository after the company was set up, so a team can be given it', async () => {
    const { db, use } = setup();
    const second = gitRepo();
    await expect(use('add_repository', { path: `${second}/nope` })).rejects.toThrow(/missing/);
    await expect(use('add_repository', { path: path.dirname(second) })).rejects.toThrow(/not a git repository/);
    expect(await use('add_repository', { path: `${second}/`, gates: [{ name: 'tests', command: 'npm test', timeoutMinutes: 10, lock: null }] })).toMatch(/Registered .* with the gate tests/);
    expect(store.allRepos(db).map((entry) => entry.path)).toContain(second);
    await expect(use('add_repository', { path: second })).rejects.toThrow(/already registered/);
    expect(await use('update_team', { team: 'Rust', repo: second, baseBranch: 'team' })).toMatch(/Rust/);
  });
});
