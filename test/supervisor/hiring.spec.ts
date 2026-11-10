import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { apply } from '../../src/db/apply.ts';
import { paths } from '../../src/db/dataDir.ts';
import { openDb } from '../../src/db/open.ts';
import * as store from '../../src/db/store.ts';
import type { SkillRef } from '../../src/runtime/skills.ts';
import { edit, fire, hire } from '../../src/supervisor/hiring.ts';
import { company, employee, T0, team, tempDir } from '../helpers.ts';

const SKILLS: SkillRef[] = [
  { id: 'dataviz', label: 'dataviz', description: 'Charts.', source: 'bundled', path: null },
  { id: 'user:postgresql', label: 'postgresql', description: 'SQL.', source: 'user', path: '/skills/postgresql' },
];

function setup(teams = [team({ id: 'ios', name: 'Engineering iOS' }), team({ id: 'marketing', name: 'Marketing', selfManaged: true })]) {
  const dir = tempDir();
  const db = openDb(paths(dir).db);
  apply(db, (tx) => {
    tx.emit({ kind: 'company_changed', company: company() });
    for (const t of teams) tx.emit({ kind: 'team_changed', team: t });
  });
  return { dir, db, ctx: { db, now: T0, paths: paths(dir), skills: SKILLS } };
}

describe('hire', () => {
  it("hires from a preset with the company's model for the tier, and makes a lead the team's lead", () => {
    const { db, ctx, dir } = setup();
    const lead = hire(ctx, { preset: 'engineering_lead', name: 'Priya', teamId: 'ios' });
    const engineer = hire(ctx, { preset: 'engineer', name: 'Ada', teamId: 'ios' });
    expect(lead).toMatchObject({ name: 'Priya', teamId: 'ios', model: 'claude-opus-5-5', fired: false, capabilities: ['read_files', 'run_commands', 'write_code'] });
    expect(engineer).toMatchObject({ model: 'claude-sonnet-5-5' });
    expect(lead.role.length).toBeGreaterThan(30);
    expect(lead.memoryDir).toBe(path.join(dir, 'memory', lead.id));
    expect(store.getTeam(db, 'ios')?.leadId).toBe(lead.id);
    expect(store.getEmployee(db, engineer.id)).toEqual(engineer);
  });

  it("hires from the form's fields", () => {
    const { ctx } = setup();
    const ada = hire(ctx, { name: 'Ada', teamId: 'marketing', role: 'Reads the usage logs and writes a weekly note.', model: 'claude-sonnet-5-5', lead: false, skills: ['dataviz', 'user:postgresql'], capabilities: ['read_files', 'run_commands'] });
    expect(ada).toMatchObject({ skills: ['dataviz', 'user:postgresql'], capabilities: ['read_files', 'run_commands'], role: 'Reads the usage logs and writes a weekly note.' });
  });

  it('refuses a skill that is not installed and a capability the team does not allow', () => {
    const { ctx } = setup();
    const form = { name: 'Ada', teamId: 'ios', role: 'Writes code for the app.', model: 'claude-sonnet-5-5', lead: false, skills: [], capabilities: ['read_files' as const] };
    expect(() => hire(ctx, { ...form, skills: ['user:nope'] })).toThrow(/user:nope/);
    expect(() => hire(ctx, { ...form, capabilities: ['read_files', 'send_messages'] })).toThrow(/send messages/);
    expect(() => hire(ctx, { ...form, capabilities: ['git_push'] })).toThrow(/git push/);
    expect(() => hire(ctx, { ...form, name: ' ' })).toThrow(/name/);
    expect(() => hire(ctx, { ...form, teamId: 'nowhere' })).toThrow(/team/);
  });

  it('refuses to hire someone with no tools at all: such an employee can do nothing but ask', () => {
    const { ctx } = setup();
    expect(() => hire(ctx, { name: 'Pat', teamId: 'ios', role: 'Researches the market.', model: 'claude-sonnet-5-5', lead: false, skills: [], capabilities: [] })).toThrow(/at least one tool/);
    expect(() => edit(ctx, hire(ctx, { preset: 'engineer', name: 'Ada', teamId: 'ios' }).id, { capabilities: [] })).toThrow(/at least one tool/);
  });

  it('refuses a second lead, and a lead for a self-managed team', () => {
    const { ctx } = setup();
    hire(ctx, { preset: 'engineering_lead', name: 'Priya', teamId: 'ios' });
    expect(() => hire(ctx, { preset: 'engineering_lead', name: 'Second', teamId: 'ios' })).toThrow(/already has a lead/);
    expect(() => hire(ctx, { preset: 'engineering_lead', name: 'Lead', teamId: 'marketing' })).toThrow(/self-managed/);
  });
});

describe('fire and edit', () => {
  it('firing archives the memory and clears a lead from its team', () => {
    const { db, ctx, dir } = setup();
    const lead = hire(ctx, { preset: 'engineering_lead', name: 'Priya', teamId: 'ios' });
    fs.mkdirSync(lead.memoryDir, { recursive: true });
    fs.writeFileSync(path.join(lead.memoryDir, 'index.md'), '- a memory\n');
    fire(ctx, lead.id);
    expect(store.getEmployee(db, lead.id)?.fired).toBe(true);
    expect(store.getTeam(db, 'ios')?.leadId).toBeNull();
    expect(fs.existsSync(lead.memoryDir)).toBe(false);
    const archived = fs.readdirSync(path.join(dir, 'memory', 'archive'));
    expect(archived).toHaveLength(1);
    expect(fs.readFileSync(path.join(dir, 'memory', 'archive', archived[0]!, 'index.md'), 'utf8')).toBe('- a memory\n');
    // The seat is free again.
    expect(() => hire(ctx, { preset: 'engineering_lead', name: 'Next', teamId: 'ios' })).not.toThrow();
  });

  it('an edit changes the role, the model, the skills and the tools, with the same checks as hiring', () => {
    const { db, ctx } = setup();
    const ada = hire(ctx, { preset: 'engineer', name: 'Ada', teamId: 'ios' });
    edit(ctx, ada.id, { role: 'Now owns the roster client.', model: 'claude-opus-5-5', skills: ['dataviz'], capabilities: ['read_files'] });
    // Effort is chosen per person and can be changed, or handed back to the model.
    expect(store.getEmployee(ctx.db, ada.id)!.effort ?? null).toBeNull();
    expect(edit(ctx, ada.id, { effort: 'max' }).effort).toBe('max');
    expect(store.getEmployee(ctx.db, ada.id)).toMatchObject({ effort: 'max', model: 'claude-opus-5-5' });
    expect(edit(ctx, ada.id, { effort: null }).effort).toBeNull();
    expect(hire(ctx, { name: 'Lin', teamId: 'ios', role: 'Thinks hard.', model: 'claude-fable-5-2', effort: 'high', lead: false, skills: [], capabilities: ['read_files'] })).toMatchObject({ model: 'claude-fable-5-2', effort: 'high' });
    expect(store.getEmployee(db, ada.id)).toMatchObject({ role: 'Now owns the roster client.', model: 'claude-opus-5-5', skills: ['dataviz'], capabilities: ['read_files'], name: 'Ada' });
    expect(() => edit(ctx, ada.id, { skills: ['user:nope'] })).toThrow(/user:nope/);
    expect(() => edit(ctx, 'nobody', { role: 'x' })).toThrow(/employee/);
  });

  it('keeps an employee that already exists out of the way of a new one', () => {
    const { ctx } = setup();
    apply(ctx.db, (tx) => tx.emit({ kind: 'employee_changed', employee: employee({ id: 'old', teamId: 'ios' }) }));
    expect(hire(ctx, { preset: 'engineer', name: 'Ada', teamId: 'ios' }).id).not.toBe('old');
  });
});
