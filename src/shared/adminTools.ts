/**
 * The names, inputs and descriptions of Morpheus's tools. Kept apart from what runs them, so that a
 * worker can offer the tools to its session without loading the engine.
 */
import { z } from 'zod';
import { Capability, Effort, Gate } from './types.ts';

export const ADMIN_TOOLS = ['company_setup', 'create_team', 'update_team', 'remove_team', 'hire', 'update_employee', 'fire', 'update_company', 'add_repository', 'set_gates', 'set_record', 'import_decisions'] as const;
export type AdminTool = (typeof ADMIN_TOOLS)[number];

const teamFields = {
  purpose: z.string().optional(),
  selfManaged: z.boolean().optional().describe('true: no lead, each task needs an assignee and nobody reviews unless a task names a reviewer'),
  dailyCapUsd: z.number().nonnegative().optional(),
  leaseMinutes: z.number().positive().optional(),
  maxReviewRounds: z.number().int().positive().optional(),
  repo: z.string().optional().describe("a registered repository's path or id"),
  baseBranch: z.string().optional().describe('the branch the team works from, in that repository'),
  mergeTarget: z.string().nullable().optional().describe('the branch finished work lands on by itself; null: every merge is a card for the user'),
  buildsWithXcode: z.boolean().optional().describe('may write Xcode build folders, and its gates get what Xcode needs'),
};

/** What each tool takes. The engine validates every call against these before it runs. */
export const ADMIN_INPUT = {
  company_setup: z.object({}),
  create_team: z.object({ name: z.string().min(1), ...teamFields }),
  update_team: z.object({ team: z.string().min(1).describe('name or id'), name: z.string().min(1).optional(), ...teamFields }),
  remove_team: z.object({ team: z.string().min(1) }),
  hire: z.object({
    team: z.string().min(1),
    name: z.string().min(1),
    role: z.string().min(1).describe('one sentence'),
    model: z.string().min(1).describe('a model id or its label, like "Fable 5.2"'),
    effort: Effort.nullable().optional().describe('null or left out: the model\'s own'),
    lead: z.boolean().optional(),
    tools: z.array(Capability).min(1),
    skills: z.array(z.string()).optional().describe('skill ids, or the name of a set to give all of it'),
  }),
  update_employee: z.object({
    employee: z.string().min(1).describe('name or id'),
    role: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    effort: Effort.nullable().optional(),
    tools: z.array(Capability).min(1).optional(),
    skills: z.array(z.string()).optional().describe('the whole new list: skill ids or set names'),
  }),
  fire: z.object({ employee: z.string().min(1) }),
  update_company: z.object({
    dailyCapUsd: z.number().nonnegative().optional(),
    concurrency: z.number().int().positive().optional(),
    rules: z.string().optional().describe('the whole new text of the rules every employee gets'),
    addRule: z.string().optional().describe('one line added at the end of the rules'),
    costs: z.enum(['on', 'off']).optional().describe("'off': cost is not counted. No task cap or daily cap stops work, no card asks about one, and no spend is shown anywhere. For a company on a subscription, where the figures are list prices and not a bill; the plan's own usage limit still pauses the company. 'on': caps stop work and spend is shown"),
    decider: z.enum(['user', 'chief']).optional().describe("who is asked first when a card is raised. 'chief': the chief of staff answers it on the user's behalf and hands on only what nobody in the company can settle; money, tools, hiring and the machine always stay with the user. 'user': every card is the user's"),
  }),
  add_repository: z.object({ path: z.string().min(1).describe('the folder of a git repository on this machine'), gates: z.array(Gate).optional() }),
  set_gates: z.object({ repo: z.string().min(1), gates: z.array(Gate) }),
  set_record: z.object({
    repo: z.string().min(1),
    decisionsFolder: z.string().min(1).nullable().optional().describe('where the engine writes one file per decision when work lands, from the top of the repository, such as docs/decisions; null: it writes none'),
    contract: z.array(z.string().min(1)).min(1).nullable().optional().describe('the folders or files that are the contract between teams, such as docs/contract; a change to them then needs a version from the engine; null: no contract'),
    contractStartsAt: z.string().optional().describe('the version the contract is at now, such as 0.10.1: counting goes on from it'),
  }),
  import_decisions: z.object({
    repo: z.string().min(1),
    file: z.string().min(1).describe('a markdown table of decisions kept by hand, such as docs/decisions.md, whose rows begin | D-12 | date | decision | why |'),
    branches: z.array(z.string().min(1)).min(1).optional().describe('the branches to read it on, in order: the first to use a number keeps it. Left out: the branch checked out'),
  }),
} satisfies Record<AdminTool, z.ZodType>;

export const ADMIN_DESCRIPTION: Record<AdminTool, string> = {
  company_setup: 'The company as it is set up now: every team with its lead, cap, repository and branches; every person with model, effort, tools and skills; the caps, the rules, each repository\'s gates, and the models, tools and skills that can be given. Read it before changing anything.',
  create_team: 'Create a team. Without a repository it works in plain folders. A led team gets its lead by hiring someone with lead: true.',
  update_team: 'Change a team: its name, purpose, cap, branches, whether it is led, whether it builds with Xcode.',
  remove_team: 'Remove a team: everyone on it is fired and it leaves the board and the office. Refused while it has unfinished work.',
  hire: 'Hire someone onto a team: a name, one sentence for the role, a model, an optional effort, the tools and the skills.',
  update_employee: "Change someone's role, model, effort, tools or skills. It takes effect at their next run.",
  fire: 'Fire someone. Their memory is archived. A lead leaves their team without a lead.',
  update_company: 'Change the company: the daily cap for all teams together, how many runs may happen at once, the rules every employee gets, whether cost is counted at all, and who decides cards first (the user, or the chief of staff on the user\'s behalf).',
  add_repository: 'Register a git repository on this machine, so teams can be given it to work in (update_team, with a base branch). Gates can be given now or set later.',
  set_record: "Say where a repository keeps the company's record: the folder the engine writes decision files into, and the files that are its contract. Either can be taken away with null.",
  import_decisions: 'Take a log of decisions that was kept by hand into the record, with the numbers it had. Safe to run again: what is on record already is left alone.',
  set_gates: "Replace a repository's gates: named commands the engine runs to check work. Gates that share a lock never run side by side.",
};
