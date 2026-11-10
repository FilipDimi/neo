/**
 * The first company: the company row, its office team, and its chief of staff.
 */
import path from 'node:path';
import { apply } from '../db/apply.ts';
import type { Paths } from '../db/dataDir.ts';
import type { Db } from '../db/open.ts';
import * as store from '../db/store.ts';
import { PRESETS } from '../presets/presets.ts';
import type { Company, Employee, Team } from '../shared/types.ts';

export const DEFAULT_MODELS: Company['models'] = { lead: 'claude-opus-5-5', member: 'claude-sonnet-5-5', routine: 'claude-haiku-5-5' };

export const TEAM_DEFAULTS: Omit<Team, 'id' | 'name' | 'purpose'> = {
  leadId: null,
  selfManaged: false,
  dailyCapUsd: 20,
  repos: [],
  mayPush: false,
  mayOpenPr: false,
  mayPublish: false,
  maySend: false,
  mayPay: false,
  mayDelete: false,
  leaseMinutes: 15,
  maxReviewRounds: 3,
  sandboxWrite: [],
};

export class AlreadySetUp extends Error {}

export function setupCompany(ctx: { db: Db; now: Date; paths: Paths }, input: { name: string; rules?: string; chiefName?: string; auth?: Company['auth']; models?: Partial<Company['models']> }): Company {
  if (store.getCompany(ctx.db)) throw new AlreadySetUp('This data directory already holds a company.');
  const chiefId = store.newId();
  const officeId = store.newId();
  const company: Company = {
    id: 'company',
    name: input.name.trim(),
    rules: input.rules?.trim() ?? '',
    auth: input.auth ?? 'subscription',
    concurrency: 3,
    dailyCapUsd: 40,
    models: { ...DEFAULT_MODELS, ...input.models },
    denyRead: [],
    minFreeGb: 5,
    services: [],
    chiefOfStaffId: chiefId,
    paused: null,
  };
  const office: Team = { ...TEAM_DEFAULTS, id: officeId, name: 'Office', purpose: 'Keeps the company moving: turns what the user asks for into tasks on the right teams.', leadId: chiefId, dailyCapUsd: 5 };
  const preset = PRESETS.chief_of_staff;
  const chief: Employee = { id: chiefId, teamId: officeId, name: input.chiefName?.trim() || 'Chief of staff', role: preset.role, skills: preset.skills, capabilities: preset.capabilities, model: company.models[preset.tier], memoryDir: path.join(ctx.paths.memory, chiefId), chatSessionId: null, fired: false };
  apply(
    ctx.db,
    (tx) => {
      tx.emit({ kind: 'company_changed', company });
      tx.emit({ kind: 'team_changed', team: office });
      tx.emit({ kind: 'employee_changed', employee: chief });
    },
    ctx.now,
  );
  return company;
}
