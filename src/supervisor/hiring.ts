/**
 * Hiring, firing and editing employees. An employee is a row: the definition a session receives
 * is generated from it at every run, so an edit takes effect at the next run and nothing here
 * touches a run in flight.
 */
import fs from 'node:fs';
import path from 'node:path';
import { apply } from '../db/apply.ts';
import type { Paths } from '../db/dataDir.ts';
import type { Db } from '../db/open.ts';
import * as store from '../db/store.ts';
import { PRESETS, type PresetId } from '../presets/presets.ts';
import type { SkillRef } from '../runtime/skills.ts';
import type { Capability, Effort, Employee, Team } from '../shared/types.ts';
import { availableCapabilities, CAPABILITIES } from './blastRadius.ts';

export type HireCtx = { db: Db; now: Date; paths: Paths; skills: SkillRef[] };
export type HireForm = { name: string; teamId: string; role: string; model: string; effort?: Effort | null | undefined; lead: boolean; skills: string[]; capabilities: Capability[] };
export type HireInput = HireForm | { preset: PresetId; name: string; teamId: string };

function checkKit(ctx: HireCtx, team: Team, skills: string[], capabilities: Capability[]): void {
  if (capabilities.length === 0) throw new Error('give the employee at least one tool: with none it can read nothing and do nothing but ask');
  const missing = skills.find((id) => !ctx.skills.some((skill) => skill.id === id));
  if (missing) throw new Error(`the skill "${missing}" is not installed on this machine`);
  const allowed = availableCapabilities(team);
  const off = capabilities.find((capability) => !allowed.includes(capability));
  if (off) throw new Error(`"${CAPABILITIES[off].label}" is off for the team ${team.name}`);
}

export function hire(ctx: HireCtx, input: HireInput): Employee {
  const team = store.getTeam(ctx.db, input.teamId);
  const company = store.getCompany(ctx.db);
  if (!team || !company) throw new Error(`there is no team ${input.teamId}`);
  if (team.removed) throw new Error(`the team ${team.name} was removed`);
  if (!input.name.trim()) throw new Error('an employee needs a name');
  const form: HireForm =
    'preset' in input
      ? { name: input.name, teamId: input.teamId, role: PRESETS[input.preset].role, model: company.models[PRESETS[input.preset].tier], lead: PRESETS[input.preset].lead, skills: PRESETS[input.preset].skills, capabilities: PRESETS[input.preset].capabilities }
      : input;
  if (!form.role.trim()) throw new Error('an employee needs a role sentence');
  if (!form.model.trim()) throw new Error('an employee needs a model');
  checkKit(ctx, team, form.skills, form.capabilities);
  if (form.lead) {
    if (team.selfManaged) throw new Error(`the team ${team.name} is self-managed, so it has no lead`);
    const current = team.leadId ? store.getEmployee(ctx.db, team.leadId) : undefined;
    if (current && !current.fired) throw new Error(`the team ${team.name} already has a lead, ${current.name}`);
  }
  const id = store.newId();
  const employee: Employee = { id, teamId: team.id, name: form.name.trim(), role: form.role.trim(), skills: form.skills, capabilities: form.capabilities, model: form.model, effort: form.effort ?? null, memoryDir: path.join(ctx.paths.memory, id), chatSessionId: null, fired: false };
  apply(
    ctx.db,
    (tx) => {
      tx.emit({ kind: 'employee_changed', employee });
      if (form.lead) tx.emit({ kind: 'team_changed', team: { ...team, leadId: id } });
    },
    ctx.now,
  );
  return employee;
}

/** Firing stops nothing in flight. The memory is archived, not deleted. */
/**
 * Removes a team: everyone on it is fired (their memory archived, as for any firing) and the team leaves every list.
 * Its record stays, so the work it finished can still be named. Refused while any of its work is not finished,
 * and for the chief of staff's own team.
 */
export function removeTeam(ctx: HireCtx, teamId: string): Team {
  const team = store.getTeam(ctx.db, teamId);
  if (!team) throw new Error(`there is no team ${teamId}`);
  if (team.removed) throw new Error(`the team ${team.name} was already removed`);
  const chief = store.getCompany(ctx.db)?.chiefOfStaffId;
  const people = store.allEmployees(ctx.db).filter((employee) => employee.teamId === team.id && !employee.fired);
  if (chief && people.some((employee) => employee.id === chief)) throw new Error(`the team ${team.name} is the chief of staff's own team; it cannot be removed`);
  const open = store.listTasks(ctx.db, { teamId: team.id }).filter((task) => task.state !== 'done' && task.state !== 'failed');
  if (open.length > 0) throw new Error(`the team ${team.name} still has work that is not finished: ${open.map((task) => `"${task.title}"`).join(', ')}. Finish or stop it first`);
  for (const employee of people) fire(ctx, employee.id);
  const removed: Team = { ...store.getTeam(ctx.db, team.id)!, leadId: null, removed: true };
  apply(ctx.db, (tx) => tx.emit({ kind: 'team_changed', team: removed }), ctx.now);
  return removed;
}

export function fire(ctx: HireCtx, employeeId: string): void {
  const employee = store.getEmployee(ctx.db, employeeId);
  if (!employee) throw new Error(`there is no employee ${employeeId}`);
  if (fs.existsSync(employee.memoryDir)) {
    const archive = path.join(ctx.paths.memory, 'archive');
    fs.mkdirSync(archive, { recursive: true });
    fs.renameSync(employee.memoryDir, path.join(archive, `${employee.id}-${ctx.now.toISOString().slice(0, 10)}`));
  }
  const team = store.getTeam(ctx.db, employee.teamId);
  const company = store.getCompany(ctx.db);
  apply(
    ctx.db,
    (tx) => {
      tx.emit({ kind: 'employee_changed', employee: { ...employee, fired: true } });
      if (team?.leadId === employee.id) tx.emit({ kind: 'team_changed', team: { ...team, leadId: null } });
      if (company?.chiefOfStaffId === employee.id) tx.emit({ kind: 'company_changed', company: { ...company, chiefOfStaffId: null } });
    },
    ctx.now,
  );
}

/** Takes effect at the employee's next run. */
export function edit(ctx: HireCtx, employeeId: string, patch: Partial<Pick<Employee, 'name' | 'role' | 'model' | 'effort' | 'skills' | 'capabilities'>>): Employee {
  const employee = store.getEmployee(ctx.db, employeeId);
  const team = employee && store.getTeam(ctx.db, employee.teamId);
  if (!employee || !team) throw new Error(`there is no employee ${employeeId}`);
  const next: Employee = { ...employee, ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) };
  if (!next.name.trim() || !next.role.trim() || !next.model.trim()) throw new Error('an employee needs a name, a role sentence and a model');
  checkKit(ctx, team, next.skills, next.capabilities);
  apply(ctx.db, (tx) => tx.emit({ kind: 'employee_changed', employee: next }), ctx.now);
  return next;
}
