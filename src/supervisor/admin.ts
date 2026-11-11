/**
 * Morpheus's tools: the company's setup, changed from a conversation. Each makes the change the
 * screen makes through the API, with the same checks, and answers in a line of plain words that
 * says what changed. A refusal is an Error whose message says what to do instead.
 */
import { z } from 'zod';
import { apply } from '../db/apply.ts';
import type { Db } from '../db/open.ts';
import * as store from '../db/store.ts';
import { git } from '../git/git.ts';
import { EFFORT_LABELS, MODEL_LABELS } from '../shared/prices.ts';
import { skillSets, skillsInBrief } from '../shared/skills.ts';
import { XCODE_BUILD_FOLDERS } from '../shared/teams.ts';
import { ADMIN_INPUT, type AdminTool } from '../shared/adminTools.ts';
import { Capability, Company, Effort, Team, TeamRepo, type Employee, type Repo } from '../shared/types.ts';
import { CAPABILITIES } from './blastRadius.ts';
import { edit, fire, hire, removeTeam, type HireCtx } from './hiring.ts';
import { TEAM_DEFAULTS } from './setup.ts';

const labelOf = (model: string): string => MODEL_LABELS[model] ?? model;
const effortOf = (effort: Effort | null | undefined): string => (effort ? `${EFFORT_LABELS[effort]?.toLowerCase() ?? effort} effort` : "the model's own effort");
const toolsOf = (tools: Capability[]): string => tools.map((tool) => CAPABILITIES[tool].label).join(', ') || 'no tools';
const usd = (amount: number): string => `$${Number.isInteger(amount) ? amount : amount.toFixed(2)}`;

function findTeam(db: Db, wanted: string): Team {
  const teams = store.allTeams(db);
  const plain = wanted.trim().toLowerCase();
  const team = teams.find((entry) => entry.id === wanted.trim()) ?? teams.find((entry) => entry.name.toLowerCase() === plain);
  if (!team) throw new Error(`There is no team "${wanted}". The teams are: ${teams.map((entry) => entry.name).join(', ') || 'none yet'}.`);
  return team;
}

function findEmployee(db: Db, wanted: string): Employee {
  const staff = store.allEmployees(db).filter((employee) => !employee.fired);
  const plain = wanted.trim().toLowerCase();
  const employee = staff.find((entry) => entry.id === wanted.trim()) ?? staff.find((entry) => entry.name.toLowerCase() === plain);
  if (!employee) throw new Error(`There is nobody here called "${wanted}". The employees are: ${staff.map((entry) => entry.name).join(', ')}.`);
  return employee;
}

function findRepo(db: Db, wanted: string): Repo {
  const repos = store.allRepos(db);
  const repo = repos.find((entry) => entry.id === wanted.trim() || entry.path === wanted.trim().replace(/\/+$/, ''));
  if (!repo) throw new Error(`There is no repository "${wanted}". The repositories are: ${repos.map((entry) => `${entry.path} (id ${entry.id})`).join(', ') || 'none yet'}.`);
  return repo;
}

function findModel(wanted: string): string {
  const plain = wanted.trim().toLowerCase();
  const found = Object.entries(MODEL_LABELS).find(([id, label]) => id === plain || label.toLowerCase() === plain);
  if (!found) throw new Error(`There is no model "${wanted}". The models are: ${Object.entries(MODEL_LABELS).map(([id, label]) => `${label} (${id})`).join(', ')}.`);
  return found[0];
}

/** Skill ids, with the name of a set standing for every skill in it. */
function findSkills(ctx: HireCtx, wanted: string[]): string[] {
  const installed = ctx.skills.map((skill) => skill.id);
  const { sets } = skillSets(installed);
  return [
    ...new Set(
      wanted.flatMap((name) => {
        const set = sets.find((entry) => entry.name === name.trim());
        if (set) return set.ids;
        if (installed.includes(name.trim())) return [name.trim()];
        throw new Error(`There is no skill or set "${name}". Sets: ${sets.map((entry) => entry.name).join(', ') || 'none'}. Use company_setup for every skill.`);
      }),
    ),
  ];
}

/** A team may only name repositories that are registered and branches that exist in them. */
export async function checkTeam(db: Db, team: Team): Promise<Team> {
  if (team.removed) throw new Error(`The team ${team.name} was removed.`);
  for (const entry of z.array(TeamRepo).parse(team.repos)) {
    const repo = store.getRepo(db, entry.repoId);
    if (!repo) throw new Error(`There is no repository ${entry.repoId}.`);
    for (const branch of [entry.baseBranch, ...(entry.mergeTarget ? [entry.mergeTarget] : [])]) {
      if ((await git(repo.path, ['rev-parse', '-q', '--verify', `refs/heads/${branch}`])).code !== 0) throw new Error(`The repository at ${repo.path} has no branch "${branch}".`);
    }
  }
  return Team.parse(team);
}

/** The team's fields that a tool call changed, applied to what it was. */
function withFields(db: Db, team: Team, input: Omit<z.infer<typeof ADMIN_INPUT.update_team>, 'team'>): Team {
  const next: Team = { ...team };
  for (const key of ['purpose', 'selfManaged', 'dailyCapUsd', 'leaseMinutes', 'maxReviewRounds'] as const) if (input[key] !== undefined) (next as Record<string, unknown>)[key] = input[key];
  if (input.name !== undefined) next.name = input.name;
  if (input.repo !== undefined || input.baseBranch !== undefined || input.mergeTarget !== undefined) {
    const current = team.repos[0];
    const repoId = input.repo !== undefined ? findRepo(db, input.repo).id : current?.repoId;
    const baseBranch = input.baseBranch ?? current?.baseBranch;
    if (!repoId || !baseBranch) throw new Error('A team that works in a repository needs both the repository and its base branch.');
    next.repos = [{ repoId, baseBranch, mergeTarget: input.mergeTarget !== undefined ? input.mergeTarget : (current?.mergeTarget ?? null) }];
  }
  if (input.buildsWithXcode !== undefined) {
    const others = team.sandboxWrite.filter((folder) => !XCODE_BUILD_FOLDERS.includes(folder));
    next.sandboxWrite = input.buildsWithXcode ? [...others, ...XCODE_BUILD_FOLDERS] : others;
  }
  return next;
}

function describeTeam(db: Db, team: Team): string {
  const lead = team.leadId ? store.getEmployee(db, team.leadId)?.name : null;
  const where = team.repos[0];
  const repo = where ? store.getRepo(db, where.repoId) : undefined;
  const parts = [
    team.selfManaged ? 'self-managed' : lead ? `led by ${lead}` : 'led, but has no lead yet',
    `${usd(team.dailyCapUsd)} a day`,
    where ? `works in ${repo?.path ?? where.repoId} on ${where.baseBranch}, ${where.mergeTarget ? `merges onto ${where.mergeTarget} by itself` : 'merges by card'}` : 'works in plain folders',
    ...(team.sandboxWrite.includes(XCODE_BUILD_FOLDERS[0]!) ? ['builds with Xcode'] : []),
  ];
  return `${team.name} (${parts.join('; ')})`;
}

/** Everything Morpheus needs to see before changing the setup, in plain text. */
export function companySetup(ctx: HireCtx): string {
  const { db } = ctx;
  const company = store.getCompany(db);
  if (!company) return 'There is no company yet.';
  const name = (id: string | null | undefined) => (id ? (store.getEmployee(db, id)?.name ?? id) : 'nobody');
  const staff = store.allEmployees(db).filter((employee) => !employee.fired);
  const teams = store.allTeams(db).map((team) => {
    const people = staff.filter((employee) => employee.teamId === team.id);
    const lines = people.map((employee) => `  - ${employee.name}${employee.id === team.leadId ? ' (lead)' : ''}: ${labelOf(employee.model)}, ${effortOf(employee.effort)}; tools ${toolsOf(employee.capabilities)}; skills ${skillsInBrief(employee.skills) || 'none'}. Role: ${employee.role}`);
    return [`- ${describeTeam(db, team)}. ${team.purpose}`.trim(), ...lines].join('\n');
  });
  const repos = store.allRepos(db).map((repo) => `- ${repo.path} (id ${repo.id}): ${repo.gates.length === 0 ? 'no gates' : repo.gates.map((gate) => `${gate.name} (\`${gate.command}\`, ${gate.timeoutMinutes} min${gate.lock ? `, lock ${gate.lock}` : ''})`).join('; ')}`);
  const { sets, singles } = skillSets(ctx.skills.map((skill) => skill.id));
  return [
    `${company.name}. Daily cap ${usd(company.dailyCapUsd)}, ${company.concurrency} runs at once. Chief of staff: ${name(company.chiefOfStaffId)}. Admin: ${name(company.adminId)}.`,
    company.decider === 'chief' ? `Decisions go to ${name(company.chiefOfStaffId)} first, who answers them for the user; money, tools, hiring and the machine stay with the user.` : 'Decisions come to the user.',
    `Teams:\n${teams.join('\n') || '(none)'}`,
    `Repositories:\n${repos.join('\n') || '(none)'}`,
    `Models: ${Object.entries(MODEL_LABELS).map(([id, label]) => `${label} (${id})`).join(', ')}. Efforts: ${Effort.options.join(', ')}, or the model's own.`,
    `Tools: ${Capability.options.filter((tool) => tool !== 'git_push' && tool !== 'send_messages').join(', ')}.`,
    `Skill sets: ${sets.map((set) => `${set.name} (${set.ids.length})`).join(', ') || 'none'}. Single skills: ${singles.join(', ') || 'none'}.`,
    `Rules every employee gets:\n${company.rules.trim() || '(none written)'}`,
  ].join('\n\n');
}

/** Runs one of Morpheus's tools. Answers in words; throws an Error, in words too, when it cannot. */
export async function adminTool(ctx: HireCtx, name: string, raw: unknown): Promise<string> {
  const { db } = ctx;
  const at = ctx.now;
  switch (name as AdminTool) {
    case 'company_setup':
      return companySetup(ctx);
    case 'create_team': {
      const input = ADMIN_INPUT.create_team.parse(raw);
      const draft: Team = Team.parse({ ...TEAM_DEFAULTS, id: store.newId(), name: input.name, purpose: input.purpose ?? '' });
      const team = await checkTeam(db, withFields(db, draft, input));
      apply(db, (tx) => tx.emit({ kind: 'team_changed', team }), at);
      return `Created the team ${describeTeam(db, team)}.${team.selfManaged ? '' : ' Hire its lead with lead: true.'}`;
    }
    case 'update_team': {
      const input = ADMIN_INPUT.update_team.parse(raw);
      const team = await checkTeam(db, withFields(db, findTeam(db, input.team), input));
      apply(db, (tx) => tx.emit({ kind: 'team_changed', team }), at);
      return `Changed the team. ${describeTeam(db, team)}.`;
    }
    case 'remove_team': {
      const team = findTeam(db, ADMIN_INPUT.remove_team.parse(raw).team);
      const people = store.allEmployees(db).filter((employee) => employee.teamId === team.id && !employee.fired);
      removeTeam(ctx, team.id);
      return `Removed the team ${team.name}${people.length > 0 ? `, and fired ${people.map((employee) => employee.name).join(', ')}` : ''}.`;
    }
    case 'hire': {
      const input = ADMIN_INPUT.hire.parse(raw);
      const team = findTeam(db, input.team);
      const employee = hire(ctx, { name: input.name, teamId: team.id, role: input.role, model: findModel(input.model), effort: input.effort ?? null, lead: input.lead ?? false, skills: findSkills(ctx, input.skills ?? []), capabilities: input.tools });
      return `Hired ${employee.name} on ${team.name}${input.lead ? ' as its lead' : ''}: ${labelOf(employee.model)}, ${effortOf(employee.effort)}; tools ${toolsOf(employee.capabilities)}; skills ${skillsInBrief(employee.skills) || 'none'}.`;
    }
    case 'update_employee': {
      const input = ADMIN_INPUT.update_employee.parse(raw);
      const before = findEmployee(db, input.employee);
      const after = edit(ctx, before.id, {
        ...(input.role !== undefined && { role: input.role }),
        ...(input.model !== undefined && { model: findModel(input.model) }),
        ...(input.effort !== undefined && { effort: input.effort }),
        ...(input.tools !== undefined && { capabilities: input.tools }),
        ...(input.skills !== undefined && { skills: findSkills(ctx, input.skills) }),
      });
      return `${after.name}: model ${labelOf(after.model)}, ${effortOf(after.effort)}; tools ${toolsOf(after.capabilities)}; skills ${skillsInBrief(after.skills) || 'none'}. Role: ${after.role} It takes effect at their next run.`;
    }
    case 'fire': {
      const employee = findEmployee(db, ADMIN_INPUT.fire.parse(raw).employee);
      if (store.getCompany(db)?.adminId === employee.id) throw new Error('That is you. The admin is not fired from a conversation; the user can do it on the person page.');
      fire(ctx, employee.id);
      return `Fired ${employee.name}. Their memory is archived.`;
    }
    case 'update_company': {
      const input = ADMIN_INPUT.update_company.parse(raw);
      const before = store.getCompany(db);
      if (!before) throw new Error('There is no company yet.');
      const rules = input.rules ?? (input.addRule ? `${before.rules.trimEnd()}\n${input.addRule.trim()}` : before.rules);
      if (input.decider === 'chief' && !before.chiefOfStaffId) throw new Error('There is no chief of staff to decide for the user. Hire one first.');
      const after = Company.parse({ ...before, ...(input.dailyCapUsd !== undefined && { dailyCapUsd: input.dailyCapUsd }), ...(input.concurrency !== undefined && { concurrency: input.concurrency }), ...(input.decider !== undefined && { decider: input.decider }), rules });
      const chief = store.getEmployee(db, after.chiefOfStaffId ?? '')?.name ?? 'the chief of staff';
      apply(db, (tx) => tx.emit({ kind: 'company_changed', company: after }), at);
      const changed = [
        after.dailyCapUsd !== before.dailyCapUsd ? `daily cap ${usd(after.dailyCapUsd)} (was ${usd(before.dailyCapUsd)})` : '',
        after.concurrency !== before.concurrency ? `${after.concurrency} runs at once (was ${before.concurrency})` : '',
        after.rules !== before.rules ? 'the rules changed; every run from now on gets the new text' : '',
        (after.decider ?? 'user') !== (before.decider ?? 'user') ? (after.decider === 'chief' ? `decisions go to ${chief} first (were the user's)` : `decisions come to the user (went to ${chief} first)`) : '',
      ].filter(Boolean);
      return changed.length > 0 ? `Company: ${changed.join('; ')}.` : 'Nothing changed: those are the values already set.';
    }
    case 'set_gates': {
      const input = ADMIN_INPUT.set_gates.parse(raw);
      const repo = findRepo(db, input.repo);
      apply(db, (tx) => tx.emit({ kind: 'repo_changed', repo: { ...repo, gates: input.gates } }), at);
      return `Gates of ${repo.path}: ${input.gates.map((gate) => `${gate.name} (${gate.timeoutMinutes} min${gate.lock ? `, lock ${gate.lock}` : ''})`).join(', ') || 'none'}.`;
    }
    default:
      throw new Error(`There is no admin tool ${name}.`);
  }
}
