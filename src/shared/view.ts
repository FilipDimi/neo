/**
 * How a task is shown, as pure functions of rows and the clock. The engine's plain page and the
 * web app both use these, so a card's colour and its status line mean one thing everywhere.
 * Shared with the web app: no Node imports here.
 */
import type { Company, Decision, Run, Task } from './types.ts';

/** A time of day as the line shows it: "14:02", in the local time of whoever reads it. */
const hhmm = (iso: string): string => {
  const at = new Date(iso);
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
};

/**
 * What stands behind a piece of work, in one line, from what the engine verified only: the gates it ran itself,
 * the commands the run ran and the files it cites that it found to hold. Null when there is nothing.
 */
export function checkedLine(run: Pick<Run, 'gateResults' | 'checks'>): string | null {
  const gates = new Map<string, Run['gateResults'][number]>();
  for (const result of run.gateResults ?? []) gates.set(result.name, result); // the last result of each gate is the one that stands
  const items = [...gates.values()].map((result) => `${result.name} (gate, ${result.exitCode === 0 ? `passed${result.at ? ` ${hhmm(result.at)}` : ''}` : 'FAILED'})`);
  const commands = (run.checks ?? []).filter((check) => check.kind === 'command').map((check) => check.shown);
  const files = (run.checks ?? []).filter((check) => check.kind === 'file');
  items.push(...commands, ...(files.length >= 3 ? [`cites ${files.length} files`] : files.map((check) => check.shown)));
  return items.length === 0 ? null : `Checked: ${items.join(' · ')}`;
}

/** True where cost is counted: caps stop work and spend is shown. The engine and the screen both ask this, and nothing else decides it. */
export const countsCost = (company: Pick<Company, 'costs'> | null | undefined): boolean => company?.costs !== 'off';

/** What a card's colour stands for. The client picks the colour. */
export type Attention = 'none' | 'working' | 'review' | 'waiting_on_you' | 'silent' | 'over_budget';

export function ago(iso: string, now: Date): string {
  const seconds = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return `${seconds} s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h`;
  return `${Math.floor(seconds / 86400)} d`;
}

const times = (n: number): string => (n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`);
const authored = (run: Run): boolean => run.mode === 'work' || run.mode === 'brief' || run.mode === 'integrate';

/** `decisions` are the task's own open cards. */
export function attention(task: Task, liveRun: Run | undefined, decisions: Decision[], now: Date): Attention {
  if (decisions.some((d) => d.kind === 'lease')) return 'silent';
  if (decisions.some((d) => d.kind === 'cap')) return 'over_budget';
  if (decisions.length > 0) return 'waiting_on_you';
  if (liveRun && now.getTime() > new Date(liveRun.leaseUntil).getTime()) return 'silent';
  if (task.state === 'review') return 'review';
  if (liveRun || task.state === 'briefing' || task.state === 'running') return 'working';
  return 'none';
}

/** How many things that finished before today the board keeps within reach. The engine sends that many; the page shows them. */
export const EARLIER_SHOWN = 5;

/** Why a task is waiting, in a few words, by the kind of card that is open on it. */
export const WHY: Record<Decision['kind'], string> = {
  lease: 'lease expired',
  failed: 'the run failed',
  cap: 'over its cap',
  tool: 'a call was refused',
  capability: 'needs a tool',
  merge: 'ready to merge',
  question: 'has a question',
  briefing: 'its split was refused',
  review: 'the review needs you',
  ownership: 'changed files it does not own',
  staffing: 'nobody to do it',
  invariant: 'nothing is working on it',
  health: 'waiting on the machine',
  usage_limit: 'paused at the usage limit',
};

function gatePart(task: Task, runs: Run[]): string {
  if (task.gates.length === 0) return '';
  const results = [...runs].reverse().find((run) => run.gateResults.length > 0)?.gateResults ?? [];
  const passed = task.gates.filter((name) => results.some((r) => r.name === name && r.exitCode === 0)).length;
  return passed === task.gates.length ? 'gates passed' : `gates ${passed}/${task.gates.length}`;
}

/** The third line of a board card. `runs` are the task's runs, oldest first. */
export function cardLine(task: Task, runs: Run[], decisions: Decision[], now: Date, children: Task[] = []): string {
  const parts = (...items: string[]) => items.filter(Boolean).join(' · ');
  const live = runs.find((run) => run.outcome === 'running');
  switch (task.state) {
    case 'blocked': {
      const card = decisions[0];
      if (!card) return '';
      const expired = runs.filter((run) => run.outcome === 'expired').length;
      const why = card.kind === 'lease' ? `lease expired ${times(Math.max(1, expired))}` : WHY[card.kind];
      return parts(runs.length > 0 ? `${runs.length} run${runs.length === 1 ? '' : 's'}` : '', why, `decision open ${ago(card.askedAt, now)}`);
    }
    case 'briefing':
    case 'running': {
      if (live) return live.activity ?? parts(`event ${ago(live.lastEventAt, now)} ago`, runs.some((run) => run.gateResults.length > 0) ? gatePart(task, runs) : '');
      if (children.length > 0) return `${children.filter((child) => child.state === 'done').length} of ${children.length} sub-tasks done`;
      return '';
    }
    case 'review': {
      const work = [...runs].reverse().find(authored);
      return parts(work?.diffLines != null ? `diff ${work.diffLines} lines` : '', task.gates.length > 0 ? gatePart(task, runs) : '');
    }
    case 'done':
      return task.mergedInto ? `merged ${task.mergedInto}` : '';
    case 'failed': {
      // Why the last run ended badly. A run that ended well did not fail the task: its reason is something else (a reviewer's verdict).
      const last = runs.at(-1);
      const reason = last && last.outcome !== 'done' ? last.reason : null;
      return !reason || reason === 'task_stopped' || reason === 'stopped_by_user' ? 'stopped' : `failed: ${reason}`;
    }
    default:
      return '';
  }
}

/** The live run that has been quiet the longest. */
export function longestSilence(liveRuns: Run[], now: Date): { runId: string; seconds: number; leaseMinutes: number } | null {
  let longest: { runId: string; seconds: number; leaseMinutes: number } | null = null;
  for (const run of liveRuns) {
    const seconds = Math.max(0, Math.round((now.getTime() - new Date(run.lastEventAt).getTime()) / 1000));
    if (!longest || seconds > longest.seconds) longest = { runId: run.id, seconds, leaseMinutes: run.leaseMinutes };
  }
  return longest;
}
