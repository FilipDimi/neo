/**
 * The progress watch. A run that is heard from is not a run that gets anywhere: the lease knows only the first.
 * This counts, from what the engine records of a session anyway, the tool calls a run makes without progress, and
 * notices a command that keeps failing the same way. No model judges anything here: every number is a count.
 *
 * Progress is something new in the folder (its tree is one it has not held before in this run), a check that newly
 * holds, or a call that moves the task (a report, a question, a decision). Reading, searching and failing are not.
 */
export type Budget = { askAfter: number; stopAfter: number; lookEvery: number };
/** From the company's record: no finished run went more than 38 calls without changing a file, and 97 in 100 stayed under 22. */
export const BUDGET: Budget = { askAfter: 50, stopAfter: 75, lookEvery: 10 };
/** How often in a row one command may fail, with nothing written in between, before it is refused. */
export const SAME_COMMAND_FAILS = 3;

/** The engine's own tools that move a task along. Calling one is progress. */
export const MOVES: ReadonlySet<string> = new Set(['report_done', 'request_decision', 'request_tools', 'propose_subtasks', 'submit_review', 'record_decision', 'contract_version', 'create_task', 'call_meeting', 'decide']);

const WRITES: ReadonlySet<string> = new Set(['Write', 'Edit', 'NotebookEdit']);
const READS: ReadonlySet<string> = new Set(['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch']);

export type Watch = {
  /** Calls since the last progress. */
  calls: number;
  /** How many calls it had made without progress when it was asked where it stands. Null: not asked. */
  asked: number | null;
  /** Every tree the folder has held in this run, as far as the engine looked. */
  trees: Set<string>;
  /** When the folder was last seen to hold something new. */
  changedAt: string | null;
  /** What was called since the last progress. */
  seen: { reads: number; commands: number; failed: number; writes: number; gates: number; other: number };
  /** The tool of each call that has no result yet, and for a command all of what was asked. */
  open: Map<string, { tool: string; command: string | null }>;
  /** Calls the engine refused: they were never made, so their "result" says nothing. */
  denied: Set<string>;
  /** The message that asked where it stands, until it is known to have arrived. */
  askId: string | null;
  /** The command that failed last, and how often in a row with nothing written and no other command succeeding in between. */
  failing: { command: string; times: number } | null;
  /** The folder is being looked at: one look at a time. */
  looking: boolean;
};

export const newWatch = (): Watch => ({ calls: 0, asked: null, trees: new Set(), changedAt: null, seen: { reads: 0, commands: 0, failed: 0, writes: 0, gates: 0, other: 0 }, open: new Map(), denied: new Set(), askId: null, failing: null, looking: false });

type Call = { id: string; tool: string; input: unknown };
/**
 * A command as it is compared: everything that was asked for, its words however they were spaced. The same words
 * with more time, or sent to the background, is another try.
 */
const commandOf = (call: Pick<Call, 'tool' | 'input'>): string | null => {
  if (call.tool !== 'Bash') return null;
  const input = (call.input ?? {}) as Record<string, unknown>;
  if (typeof input.command !== 'string') return null;
  const rest = Object.keys(input)
    .filter((key) => key !== 'command' && key !== 'description')
    .sort()
    .map((key) => `${key}=${JSON.stringify(input[key])}`);
  return [input.command.trim().split(/\s+/).join(' '), ...rest].join('\u0000');
};

/** A tool call was made. The engine's own tools are counted where they are answered, not here. */
export function called(watch: Watch, call: Call): void {
  const command = commandOf(call);
  watch.open.set(call.id, { tool: call.tool, command });
  if (call.tool.startsWith('mcp__engine__')) {
    if (call.tool === 'mcp__engine__run_gate') watch.seen.gates += 1;
    // A call that moves the task is counted like any other until it is accepted: one that is refused again and again is no progress.
    else watch.seen.other += 1;
  } else if (command !== null) watch.seen.commands += 1;
  else if (WRITES.has(call.tool)) watch.seen.writes += 1;
  else if (READS.has(call.tool)) watch.seen.reads += 1;
  else watch.seen.other += 1;
  watch.calls += 1;
}

/** A call's result arrived. */
export function resulted(watch: Watch, id: string, ok: boolean): void {
  const call = watch.open.get(id);
  watch.open.delete(id);
  // A call the engine refused was not made: it did not fail, and it changed nothing.
  if (watch.denied.delete(id) || !call) return;
  if (call.command !== null) {
    if (!ok) {
      watch.seen.failed += 1;
      watch.failing = watch.failing?.command === call.command ? { command: call.command, times: watch.failing.times + 1 } : { command: call.command, times: 1 };
    } else watch.failing = null; // Another command went through: whatever failed may go differently now.
    return;
  }
  if (WRITES.has(call.tool) && ok) watch.failing = null;
}

/** The engine refused this call before it was made. */
export function refused(watch: Watch, id: string): void {
  watch.denied.add(id);
}

/** The question where it stands did not reach the session: it has not been asked. */
export function undelivered(watch: Watch): void {
  watch.asked = null;
  watch.askId = null;
}

/** Why a call is refused before it is made: it is the command that just failed the same way, again and again. Null: no reason. */
export function refusal(watch: Watch, call: Pick<Call, 'tool' | 'input'>): string | null {
  const command = commandOf(call);
  if (command === null || watch.failing?.command !== command || watch.failing.times < SAME_COMMAND_FAILS) return null;
  return `Refused: this exact command has failed ${watch.failing.times} times in a row in this run, with nothing written and no other command succeeding in between. Change something first (the code, or the command; if you are waiting for something, wait longer in one command or look at what it is waiting for), or call mcp__engine__report_done and say what fails and what you tried.`;
}

/** The run got somewhere: the count starts again. */
export function progressed(watch: Watch, at: Date, folderChanged = false): void {
  watch.calls = 0;
  watch.asked = null;
  watch.seen = { reads: 0, commands: 0, failed: 0, writes: 0, gates: 0, other: 0 };
  if (folderChanged) watch.changedAt = at.toISOString();
}

/**
 * What the folder looks like now, taken into account: its tree, or where it has none its print. Returns what to do
 * about the run.
 */
export function looked(watch: Watch, tree: string, at: Date, budget: Budget): 'carry_on' | 'ask' | 'stop' {
  const fresh = !watch.trees.has(tree);
  // The first look is where the run began, not a change.
  const first = watch.trees.size === 0;
  watch.trees.add(tree);
  if (first) return 'carry_on';
  if (fresh) {
    progressed(watch, at, true);
    return 'carry_on';
  }
  // Never stopped without having been asked, and given the whole margin after it, however late a look came.
  if (watch.asked !== null) return watch.calls >= Math.max(budget.stopAfter, watch.asked + (budget.stopAfter - budget.askAfter)) ? 'stop' : 'carry_on';
  if (watch.calls < budget.askAfter) return 'carry_on';
  watch.asked = watch.calls;
  return 'ask';
}

const times = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;

/** What the run called since its last progress, in words, for the card. */
export function account(watch: Watch): string {
  const { reads, commands, failed, writes, gates } = watch.seen;
  const parts = [
    `read or searched ${times(reads, 'time', 'times')}`,
    `ran ${times(commands, 'command', 'commands')}${commands > 0 ? ` (${failed} failed)` : ''}`,
    ...(writes > 0 ? [`wrote ${times(writes, 'time', 'times')} without leaving anything new`] : []),
    ...(gates > 0 ? [`asked for a gate ${times(gates, 'time', 'times')}`] : []),
  ];
  return parts.length <= 1 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
}

export const askText = (calls: number, left: number): string =>
  `The engine counts progress, and in your last ${calls} tool calls it has seen none: nothing new in your folder, no check newly passing, no report. Say to yourself in one line where you stand, then do one of these now. Make the change you have been working towards. Or call mcp__engine__report_done with what you have and what is left. Or, if something blocks you that only someone else can lift, ask with mcp__engine__request_decision. After ${left} more calls without progress the engine stops this run.`;
