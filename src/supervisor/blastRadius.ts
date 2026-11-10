/**
 * The blast radius: what a session can touch. Three mechanisms, none of them a prompt:
 * which tools exist in the session, the sandbox around every command, and the supervisor's
 * answer on every tool call. Nothing here judges a command by its text.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { owns } from '../git/ownership.ts';
import { leadsTo } from '../git/paths.ts';
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
export const DEFAULT_DENY_READ = [
  '~/.ssh', '~/.aws', '~/.gnupg', '~/.netrc', '~/.kube', '~/.docker', '~/.gcp', '~/.azure', '~/.config/gcloud', '~/.config/gh', '~/.config/git/credentials', '~/.config/op',
  '~/.git-credentials', '~/.cargo/credentials', '~/.cargo/credentials.toml', '~/.gem/credentials', '~/.terraform.d', '~/.password-store',
  '~/.claude.json', '~/.claude/.credentials.json', '~/.claude/projects',
];
/**
 * Files the Read tool never opens but a command still can: settings that often hold a token
 * (npm, yarn and pip stop working when they cannot read their own), and the keychains (signing a
 * build reads them; they are encrypted). A command has no network to send anything anywhere.
 */
export const TOOL_DENY_READ = ['~/.npmrc', '~/.yarnrc.yml', '~/.pypirc', '~/.config/pip/pip.conf', '~/Library/Keychains'];

const systemFolders = new Map<string, string>();
/** macOS keeps a cache and a temp folder per user under /var/folders; `getconf` names them. Xcode writes to both. */
function systemFolder(name: string): string {
  if (!systemFolders.has(name)) {
    let found = `$${name}`;
    try {
      found = execFileSync('getconf', [name], { encoding: 'utf8' }).trim().replace(/\/$/, '');
    } catch {
      // Not macOS: the entry stays as written and matches nothing.
    }
    systemFolders.set(name, found);
  }
  return systemFolders.get(name)!;
}

const home = (entry: string): string => {
  if (entry === '$DARWIN_USER_CACHE_DIR' || entry === '$DARWIN_USER_TEMP_DIR') return systemFolder(entry.slice(1));
  return entry === '~' || entry.startsWith('~/') ? path.join(os.homedir(), entry.slice(2)) : entry;
};
const isEnvFile = (file: string): boolean => /^\.env(\..+)?$/i.test(path.basename(file)) && !/\.(example|sample|template)$/i.test(file);

/** `protect` is the engine's own files (its token, its database): no session reads those. */
export type Radius = { task: Task; team: Team; employee: Employee; mode: RunMode; folder: string; company: Company; grants: Grant[]; protect?: string[] | undefined };

/**
 * What a command may touch. A session's commands and a repository's gates get the same lists:
 * they write to the task folder and the team's build folders, never to the folder's git
 * directory (its hooks and settings would run later, outside any sandbox), and never read a secret.
 */
export function commandLimits(input: { folder: string; team: Pick<Team, 'sandboxWrite'>; company: Pick<Company, 'denyRead'>; envFiles: string[]; protect?: string[] | undefined }): { allowWrite: string[]; denyWrite: string[]; denyRead: string[] } {
  return {
    allowWrite: input.team.sandboxWrite.map(home),
    denyWrite: [path.join(input.folder, '.git')],
    denyRead: [...DEFAULT_DENY_READ, ...input.company.denyRead, ...(input.protect ?? [])].map(home).concat(input.envFiles),
  };
}

export function sessionShape(input: Omit<Radius, 'grants'> & { envFiles: string[] }): { tools: string[]; sandbox: SessionInput['sandbox']; additionalDirectories: string[] } {
  const { team, employee, mode, company } = input;
  const readOnly = mode === 'review' || mode === 'route';
  const allowed = new Set(availableCapabilities(team));
  const capabilities = ORDER.filter((c) => employee.capabilities.includes(c) && allowed.has(c) && !(readOnly && (c === 'write_code' || c === 'run_commands')));
  const tools = [...capabilities.flatMap((c) => CAPABILITIES[c].tools), ...(employee.skills.length > 0 ? ['Skill'] : [])];
  return {
    tools,
    // Every command runs inside the sandbox, or not at all: it writes only to the task folder and the team's build folders.
    sandbox: tools.includes('Bash') ? { enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false, filesystem: commandLimits({ folder: input.folder, team, company, envFiles: input.envFiles, protect: input.protect }) } : undefined,
    additionalDirectories: [employee.memoryDir],
  };
}

// The Mac's disk ignores case, and shows the same files a second time under /System/Volumes/Data.
const DATA_VOLUME = '/System/Volumes/Data';
const spelled = (file: string): string => {
  const plain = file === DATA_VOLUME || file.startsWith(`${DATA_VOLUME}/`) ? file.slice(DATA_VOLUME.length) || path.sep : file;
  return process.platform === 'darwin' ? plain.toLowerCase() : plain;
};
const inside = (file: string, dir: string): boolean => spelled(file) === spelled(dir) || spelled(file).startsWith(`${spelled(dir).replace(/\/$/, '')}${path.sep}`);

const SECRET = { allow: false, reason: 'Refused: secrets and credentials are never readable. Carry on without this file.' };

/** True for a file no session opens with a tool: a secret, a login, an env file, the engine's own token and database. */
function unreadable(ctx: Radius, file: string): boolean {
  const target = leadsTo(file);
  if (target === null || isEnvFile(target)) return true;
  return [...DEFAULT_DENY_READ, ...TOOL_DENY_READ, ...ctx.company.denyRead, ...(ctx.protect ?? [])].some((entry) => inside(target, leadsTo(home(entry)) ?? home(entry)));
}

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
      const folder = leadsTo(ctx.folder) ?? ctx.folder;
      const target = leadsTo(path.resolve(ctx.folder, input.file_path));
      if (target === null || !inside(target, folder)) return refuse(`wants to write ${target ?? input.file_path}, which is outside its task folder`);
      const relative = target.slice(folder.length + 1);
      if (relative === '') return refuse('wants to write over its task folder itself');
      if (relative.split(path.sep).some((part) => part.toLowerCase() === '.git')) return refuse(`wants to write ${relative}, inside a git directory, which only the engine changes`);
      if (!owns(ctx.task.ownership, relative)) return refuse(`wants to change ${relative}, which is outside what this task owns (${ctx.task.ownership.join(', ')})`);
      return { allow: true };
    }
    // A refused read is not a card: reading a secret is never something to ask the user for. The session carries on without it.
    case 'Read':
      return typeof input.file_path === 'string' && unreadable(ctx, path.resolve(ctx.folder, input.file_path)) ? SECRET : { allow: true };
    case 'Glob':
    case 'Grep': {
      // A search opens every file under its root, so its root stays where the task's own files are.
      const root = leadsTo(typeof input.path === 'string' ? path.resolve(ctx.folder, input.path) : ctx.folder);
      const pattern = call.tool === 'Glob' && typeof input.pattern === 'string' ? input.pattern : '';
      const climbs = path.isAbsolute(pattern) || pattern.split(/[\\/]/).includes('..');
      const places = [ctx.folder, ctx.employee.memoryDir].map((dir) => leadsTo(dir) ?? dir);
      if (root === null || climbs || !places.some((dir) => inside(root, dir))) return { allow: false, reason: 'Refused: search inside your task folder or your memory folder. To read one file from elsewhere, name it.' };
      return unreadable(ctx, root) ? SECRET : { allow: true };
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
