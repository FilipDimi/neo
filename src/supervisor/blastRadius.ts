/**
 * The blast radius: what a session can touch. Three mechanisms, none of them a prompt:
 * which tools exist in the session, the sandbox around every command, and the supervisor's
 * answer on every tool call. Nothing here judges a command by its text.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { owns } from '../git/ownership.ts';
import type { SessionInput } from '../runtime/sdk.ts';
import type { ToolCall, ToolDecision } from '../shared/runtime.ts';
import type { Capability, Company, Employee, Grant, RunMode, Task, Team } from '../shared/types.ts';

/** What the hire form offers. Two capabilities have no tool: the engine does those things, or nobody does. */
export const CAPABILITIES: Record<Capability, { label: string; tools: string[] }> = {
  read_files: { label: 'read files', tools: ['Read', 'Glob', 'Grep'] },
  run_commands: { label: 'run commands', tools: ['Bash'] },
  write_code: { label: 'write code', tools: ['Write', 'Edit'] },
  web_search: { label: 'web search', tools: ['WebSearch', 'WebFetch'] },
  git_push: { label: 'git push', tools: [] },
  send_messages: { label: 'send messages', tools: [] },
};
const ORDER = Object.keys(CAPABILITIES) as Capability[];

/** Sending messages to people has no tool in this version, whatever the team's flag says. */
export function availableCapabilities(team: Pick<Team, 'mayPush'>): Capability[] {
  return ORDER.filter((capability) => (capability === 'git_push' ? team.mayPush : capability !== 'send_messages'));
}

/** Never readable, by tool or by command: keys, logins, other sessions' transcripts. */
export const DEFAULT_DENY_READ = ['~/.ssh', '~/.aws', '~/.gnupg', '~/.netrc', '~/.kube', '~/.docker', '~/.gcp', '~/.config/gcloud', '~/.config/gh', '~/.claude.json', '~/.claude/.credentials.json', '~/.claude/projects'];

const home = (entry: string): string => (entry === '~' || entry.startsWith('~/') ? path.join(os.homedir(), entry.slice(2)) : entry);
const isEnvFile = (file: string): boolean => /^\.env(\..+)?$/.test(path.basename(file)) && !/\.(example|sample|template)$/.test(file);

export type Radius = { task: Task; team: Team; employee: Employee; mode: RunMode; folder: string; company: Company; grants: Grant[] };

export function sessionShape(input: Omit<Radius, 'grants'> & { envFiles: string[] }): { tools: string[]; sandbox: SessionInput['sandbox']; additionalDirectories: string[] } {
  const { team, employee, mode, company } = input;
  const readOnly = mode === 'review' || mode === 'route';
  const allowed = new Set(availableCapabilities(team));
  const capabilities = ORDER.filter((c) => employee.capabilities.includes(c) && allowed.has(c) && !(readOnly && (c === 'write_code' || c === 'run_commands')));
  const tools = [...capabilities.flatMap((c) => CAPABILITIES[c].tools), ...(employee.skills.length > 0 ? ['Skill'] : [])];
  return {
    tools,
    // Every command runs inside the sandbox, or not at all: it writes only to the task folder and the team's build folders.
    sandbox: tools.includes('Bash')
      ? {
          enabled: true,
          failIfUnavailable: true,
          autoAllowBashIfSandboxed: true,
          allowUnsandboxedCommands: false,
          filesystem: { allowWrite: team.sandboxWrite.map(home), denyRead: [...DEFAULT_DENY_READ, ...company.denyRead].map(home).concat(input.envFiles) },
        }
      : undefined,
    additionalDirectories: [employee.memoryDir],
  };
}

/** The real path of a file that may not exist yet: its nearest existing ancestor resolved, the rest appended. */
function realTarget(file: string): string {
  let existing = file;
  const rest: string[] = [];
  while (!fs.existsSync(existing) && path.dirname(existing) !== existing) {
    rest.unshift(path.basename(existing));
    existing = path.dirname(existing);
  }
  return path.join(fs.existsSync(existing) ? fs.realpathSync(existing) : existing, ...rest);
}

const inside = (file: string, dir: string): boolean => file === dir || file.startsWith(`${dir}${path.sep}`);

/** What a grant is for: the file for a write, the exact input for anything else. Content may differ on the second try. */
export function grantKey(call: ToolCall, folder: string): string {
  const input = (call.input ?? {}) as Record<string, unknown>;
  const target = typeof input.file_path === 'string' ? path.resolve(folder, input.file_path) : JSON.stringify(input);
  return createHash('sha256').update(`${call.tool}\n${target}`).digest('hex');
}

export type Verdict = ToolDecision & { stop?: boolean; card?: string; useGrant?: string };

/** The supervisor's answer to "may this tool call run?". A refusal with a card stops the run and asks the user. */
export function judgeToolCall(ctx: Radius, call: ToolCall): Verdict {
  const verdict = judge(ctx, call);
  if (!verdict.card) return verdict;
  const key = grantKey(call, ctx.folder);
  const grant = ctx.grants.find((g) => !g.used && g.tool === call.tool && g.inputHash === key);
  return grant ? { allow: true, useGrant: grant.id } : verdict;
}

function judge(ctx: Radius, call: ToolCall): Verdict {
  const input = (call.input ?? {}) as Record<string, unknown>;
  const refuse = (card: string): Verdict => ({ allow: false, stop: true, card, reason: `Refused: ${card.replace(/^wants to /, 'you may not ')}. The user has been asked; this run ends here.` });
  if (call.tool.startsWith('mcp__engine__')) return { allow: true };
  switch (call.tool) {
    case 'Write':
    case 'Edit': {
      if (typeof input.file_path !== 'string') return refuse(`wants to use ${call.tool} without naming a file`);
      const folder = fs.existsSync(ctx.folder) ? fs.realpathSync(ctx.folder) : ctx.folder;
      const target = realTarget(path.resolve(folder, input.file_path));
      if (!inside(target, folder)) return refuse(`wants to write ${target}, which is outside its task folder`);
      const relative = path.relative(folder, target);
      if (!owns(ctx.task.ownership, relative)) return refuse(`wants to change ${relative}, which is outside what this task owns (${ctx.task.ownership.join(', ')})`);
      return { allow: true };
    }
    case 'Read':
    case 'Glob':
    case 'Grep': {
      const named = typeof input.file_path === 'string' ? input.file_path : typeof input.path === 'string' ? input.path : null;
      if (named === null) return { allow: true };
      const target = path.resolve(ctx.folder, named);
      const denied = isEnvFile(target) || [...DEFAULT_DENY_READ, ...ctx.company.denyRead].map(home).some((entry) => inside(target, entry));
      // Not a card: reading a secret is never something to ask the user for. The session carries on without it.
      return denied ? { allow: false, reason: 'Refused: secrets and credentials are never readable. Carry on without this file.' } : { allow: true };
    }
    case 'Bash': // The sandbox confines every command; its text decides nothing.
    case 'Skill':
    case 'WebSearch':
    case 'WebFetch':
      return { allow: true };
    default:
      return refuse(`wants to use ${call.tool}, which this company does not provide`);
  }
}

/** The .env files of a repository, so the sandbox can hide them from commands too. A bounded walk. */
export function envFilesUnder(root: string, depth = 4): string[] {
  const found: string[] = [];
  const walk = (dir: string, left: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isFile() && isEnvFile(full)) found.push(full);
      else if (entry.isDirectory() && left > 0 && !['node_modules', '.git', 'target', 'build', 'DerivedData', '.build', 'Pods'].includes(entry.name)) walk(full, left - 1);
    }
  };
  walk(root, depth);
  return found;
}
