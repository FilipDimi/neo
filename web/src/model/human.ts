/**
 * What a person's page and a task's drawer say, in the words of someone who does not write code: who this is and what
 * they are doing, where a task stands and what happened on it. Pure functions of the store and the clock, like the
 * rest of `model/`; the model ids, tool calls and run records they are made from stay one step away on the screen.
 */
import type { EventRow } from '../../../src/shared/events.ts';
import type { Run, Task } from '../../../src/shared/types.ts';
import { ago, WHY, type TaskLine } from '../../../src/shared/view.ts';
import { whenPast } from '../format.ts';
import { PALETTE, SKIN } from '../office/layout.ts';
import type { Store } from '../store/reduce.ts';
import { liveRuns, openDecisions, personStatus } from './select.ts';

const authored = (run: Run): boolean => run.mode === 'work' || run.mode === 'brief' || run.mode === 'integrate';
const count = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

// ---------- a model, as people say it ----------

/** "claude-sonnet-5-5" is "Sonnet 5.5". An id that is not of that shape is left as it is. */
export function modelName(id: string): string {
  const parts = id.replace(/^claude-/, '').split('-');
  const family = parts.find((part) => /^[a-z]+$/i.test(part));
  // A date at the end is not part of the version.
  const version = parts.filter((part) => /^\d{1,2}$/.test(part));
  if (!id.startsWith('claude-') || !family || version.length === 0) return id;
  return `${family[0]!.toUpperCase()}${family.slice(1)} ${version.join('.')}`;
}

// ---------- what a person remembers ----------

export type Note = { date: string; text: string };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** The memory index as notes: each dated line with its day said as people say it, newest first; any other line kept as it is, after them. */
export function memoryNotes(index: string): Note[] {
  const dated: (Note & { iso: string })[] = [];
  const loose: Note[] = [];
  for (const line of index.split('\n').map((one) => one.trim()).filter(Boolean)) {
    const found = /^-\s*(\d{4})-(\d{2})-(\d{2}):\s*(.*)$/.exec(line);
    if (found) dated.push({ iso: `${found[1]}-${found[2]}-${found[3]}`, date: `${Number(found[3])} ${MONTHS[Number(found[2]) - 1] ?? ''}`.trim(), text: found[4]!.trim() });
    else loose.push({ date: '', text: line.replace(/^-\s*/, '') });
  }
  // Stable: notes of one day keep the order they were written in, the later one first.
  const newestFirst = dated.map((note, at) => ({ note, at })).sort((a, b) => b.note.iso.localeCompare(a.note.iso) || b.at - a.at);
  return [...newestFirst.map(({ note }) => ({ date: note.date, text: note.text })), ...loose];
}

// ---------- a task, in a word and as a path ----------

/** Where a task stands, in a word or two. A task the board no longer holds is said from its line. */
export function stateWord(store: Store, taskId: string, line?: TaskLine): string {
  const task = store.tasks.get(taskId) ?? line;
  if (!task) return '';
  switch (task.state) {
    case 'done':
      return task.dropped ? 'Not needed' : task.mergedInto ? 'Landed' : 'Done';
    case 'failed':
      return 'Stopped';
    case 'blocked':
      if (openDecisions(store).some((card) => card.taskId === taskId)) return 'Waiting on you';
      return [...store.decisions.values()].some((card) => card.answeredAt === null && card.deciderId && card.taskId === taskId) ? 'Being decided' : 'Waiting';
    case 'review':
      return 'In review';
    case 'running':
      return 'Being worked on';
    case 'briefing':
      return 'Being planned';
    default:
      return 'Waiting to start';
  }
}

/** One step of a task's path. `now`: it is here. `held`: it is here and waits on someone. `stopped`: it ended here. */
export type Step = { label: string; state: 'done' | 'now' | 'next' | 'held' | 'stopped' };

/** The path every task takes: asked for, built, checked, done. The step it is on is the one to look at. */
export function taskPath(store: Store, taskId: string): Step[] {
  const task = store.tasks.get(taskId);
  if (!task) return [];
  // A ticket closed as not needed was asked for and ended there: nothing was built or checked.
  if (task.dropped) return [{ label: 'Asked', state: 'done' }, { label: 'Built', state: 'next' }, { label: 'Checked', state: 'next' }, { label: 'Not needed', state: 'done' }];
  const labels = ['Asked', 'Built', 'Checked', task.mergedInto ? 'Landed' : 'Done'];
  if (task.state === 'done') return labels.map((label) => ({ label, state: 'done' as const }));
  const stageOf = (state: Task['state'] | null): number => (state === 'review' ? 2 : state === 'running' || state === 'briefing' ? 1 : 0);
  const runs = [...store.runs.values()].filter((run) => run.taskId === taskId).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  // A stopped task does not say where it was: its runs do. A review after work that was reported means it had reached
  // the check. A lead answering a member's question runs as a review too, after work that stopped with the question:
  // that task was still being built.
  const lastWork = runs.findLastIndex(authored);
  const reached = runs.length === 0 ? 0 : lastWork >= 0 && runs[lastWork]!.outcome === 'done' && runs.slice(lastWork + 1).some((run) => run.mode === 'review') ? 2 : 1;
  const stage = task.state === 'failed' ? reached : task.state === 'blocked' ? stageOf(task.blockedFrom) : stageOf(task.state);
  const here: Step['state'] = task.state === 'failed' ? 'stopped' : task.state === 'blocked' ? 'held' : 'now';
  return labels.map((label, index) => ({ label, state: index < stage ? 'done' : index === stage ? here : 'next' }));
}

export const priorityWord = (priority: 1 | 2 | 3): string => (priority === 1 ? 'High' : priority === 2 ? 'Normal' : 'Low');

// ---------- a person, at a glance ----------

export type Work = { taskId: string; title: string; did: string; state: string; when: string; /** Whether the board still holds the task, so that it can be opened. */ open: boolean };
export type PersonView = {
  /** Where they belong and what they are doing, in two short sentences. */
  who: string;
  /** What is in front of them right now, and the task it opens. */
  doing: { text: string; taskId: string | null } | null;
  /** The week in one sentence. */
  week: string;
  /** The tasks they last had a hand in, newest first. */
  recent: Work[];
  portrait: { shirt: string; skin: string };
};

const LEAD_SHIRT = '#F4F4F6';
const CHIEF_SHIRT = '#2A2A2E';
const hash = (text: string): number => [...text].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) >>> 0, 7);

/** What someone wears and looks like, in the office and on their page: the team's colour, white for a lead, dark for the chief of staff. */
export function portraitOf(store: Store, employeeId: string): { shirt: string; skin: string } {
  const employee = store.employees.get(employeeId);
  const skin = SKIN[hash(employeeId) % SKIN.length]!;
  if (!employee) return { shirt: PALETTE[0]!.shirt, skin };
  const staff = [...store.employees.values()].filter((one) => !one.fired);
  const chiefId = store.company?.chiefOfStaffId ?? null;
  const chief = staff.find((one) => one.id === chiefId);
  if (employee.id === chiefId) return { shirt: CHIEF_SHIRT, skin };
  // The teams in the order the office lays out their rugs: the chief of staff's own office only when someone else works in it.
  const teams = [...store.teams.values()].filter((team) => !chief || team.id !== chief.teamId || staff.some((one) => one.teamId === team.id && one.id !== chief.id));
  const at = teams.findIndex((team) => team.id === employee.teamId);
  if (at >= 0 && teams[at]!.leadId === employee.id) return { shirt: LEAD_SHIRT, skin };
  return { shirt: PALETTE[Math.max(0, at) % PALETTE.length]!.shirt, skin };
}

const VERB: Record<Run['mode'], string> = { work: 'Working on', brief: 'Planning', integrate: 'Putting together', review: 'Reviewing', route: 'Answering in the chat' };
const WEEK_MS = 7 * 24 * 3600_000;

/**
 * A person's page, above the fold: who they are, what they are doing, how the week went and what they last worked on.
 * `runs` are theirs, as the engine gives them to the page; `lines` name the tasks of those runs, for the ones the
 * board no longer holds.
 */
export function personView(store: Store, employeeId: string, runs: Run[], now: Date, lines: TaskLine[] = []): PersonView | null {
  const employee = store.employees.get(employeeId);
  if (!employee) return null;
  const team = store.teams.get(employee.teamId);
  const belongs = store.company?.chiefOfStaffId === employeeId ? 'Chief of staff' : team?.leadId === employeeId ? `Leads ${team.name}` : `${team?.name ?? 'No'} team`;
  const name = (id: string | null | undefined): string => (id && store.employees.get(id)?.name) || 'Someone';

  // What is in front of them. A card on the user's desk about them comes first: their run went silent, or a task of
  // theirs is held by a card. Then the run that is live. Then a card about their task that someone decides for the user.
  const open = openDecisions(store);
  const mineHeld = (task: Task): boolean => task.state === 'blocked' && task.assigneeId === employeeId;
  const silent = open.find((card) => card.kind === 'lease' && card.employeeId === employeeId);
  const held = silent ? (silent.taskId ? store.tasks.get(silent.taskId) : undefined) : [...store.tasks.values()].find((task) => mineHeld(task) && open.some((card) => card.taskId === task.id));
  const onUser = Boolean(silent || held);
  const live = liveRuns(store).find((run) => run.employeeId === employeeId);
  const liveTask = live ? store.tasks.get(live.taskId) : undefined;
  const deciding = [...store.decisions.values()].find((card) => card.answeredAt === null && card.deciderId && card.taskId !== null && mineHeld(store.tasks.get(card.taskId) ?? ({} as Task)));
  const decided = deciding?.taskId ? store.tasks.get(deciding.taskId) : undefined;
  const saying = onUser ? 'Waiting on you' : live ? (live.mode === 'review' ? 'Reviewing now' : 'Working now') : decided ? 'Waiting for a decision' : 'Free right now';
  const doing = onUser
    ? held
      ? { text: `Waiting on you about "${held.title}"`, taskId: held.kind === 'work' ? held.id : null }
      : { text: 'Their run went quiet: the card is on your desk', taskId: null }
    : live
      ? { text: live.mode === 'route' || liveTask?.kind === 'chat' ? VERB.route : `${VERB[live.mode]} "${liveTask?.title ?? 'a task'}", for ${ago(live.startedAt, now)}`, taskId: liveTask?.kind === 'work' ? liveTask.id : null }
      : decided
        ? { text: `${name(deciding!.deciderId)} is deciding about "${decided.title}"`, taskId: decided.id }
        : null;

  // By task, not by run: a task they went back to four times is one line. A task the board no longer holds is named
  // from its line.
  const byId = new Map(lines.map((line) => [line.id, line]));
  const known = (taskId: string): TaskLine | undefined => store.tasks.get(taskId) ?? byId.get(taskId);
  const mine = runs.filter((run) => run.employeeId === employeeId && known(run.taskId)?.kind === 'work');
  const last = new Map<string, Run[]>();
  for (const run of [...mine].sort((a, b) => a.startedAt.localeCompare(b.startedAt))) last.set(run.taskId, [...(last.get(run.taskId) ?? []), run]);
  const when = (run: Run): string => (run.outcome === 'running' ? 'now' : `${ago(run.endedAt ?? run.startedAt, now)} ago`);
  const recent = [...last.entries()]
    .map(([taskId, of]) => ({ taskId, of, at: of.at(-1)!.endedAt ?? of.at(-1)!.startedAt }))
    .sort((a, b) => b.at.localeCompare(a.at))
    .map(({ taskId, of }): Work => {
      const did = of.some((run) => run.mode === 'integrate') ? 'put it together' : of.some((run) => run.mode === 'work') ? 'worked on it' : of.some((run) => run.mode === 'brief') ? 'planned it' : 'reviewed it';
      return { taskId, title: known(taskId)!.title, did, state: stateWord(store, taskId, byId.get(taskId)), when: when(of.at(-1)!), open: store.tasks.has(taskId) };
    });

  const since = new Date(now.getTime() - WEEK_MS).toISOString();
  const thisWeek = mine.filter((run) => (run.endedAt ?? run.startedAt) >= since);
  const worked = new Set(thisWeek.filter(authored).map((run) => run.taskId)).size;
  const reviewed = new Set(thisWeek.filter((run) => run.mode === 'review' && run.reason !== 'answered').map((run) => run.taskId)).size;
  const parts = [...(worked > 0 ? [`worked on ${count(worked, 'task')}`] : []), ...(reviewed > 0 ? [`reviewed ${worked > 0 ? reviewed : count(reviewed, 'task')}`] : [])];
  const week = parts.length === 0 ? `${employee.name} has not worked on anything this week.` : `This week ${employee.name} ${parts.join(' and ')}.`;

  return { who: `${belongs}. ${saying}.`, doing, week, recent, portrait: portraitOf(store, employeeId) };
}

// ---------- what happened on a task ----------

export type Happening = { id: number; at: string; text: string };

/**
 * What happened on a task, newest first, each a plain sentence: who started what, how it ended, what the checks said,
 * who decided. Nothing a session typed is in it: that is the live feed, for whoever wants it.
 */
export function happenings(events: EventRow[], store: Store, now: Date): Happening[] {
  const who = (id: string | null | undefined): string => (id === 'user' ? 'You' : (id && store.employees.get(id)?.name) || 'Someone');
  const STARTED: Record<Run['mode'], string> = { work: 'started working on it', brief: 'started planning it', integrate: 'started putting the parts together', review: 'started reviewing it', route: 'started answering' };
  const told: Happening[] = [];
  const say = (row: EventRow, text: string | null) => void (text && told.push({ id: row.id, at: whenPast(row.at, now), text }));
  // A run's ending is written down again when its work is committed: it is told once, by how it ended the first time.
  const over = new Map<string, string | null>();
  // Work that follows a send-back is a fix, from its start to its report.
  let sentBack = false;
  const fixing = new Set<string>();
  // A lead's answer to a member's question runs as a review, after work that stopped with the question. It is no review.
  let asked = false;
  const answering = new Set<string>();
  for (const row of events) {
    const event = row.event;
    switch (event.kind) {
      case 'task_changed':
        if (event.cause === 'created') say(row, `${who(event.task.createdBy)} asked for it.`);
        else if (event.cause === 'state' && event.task.state === 'done') say(row, event.task.dropped ? `${who(event.task.dropped.by)} closed it as not needed.` : event.task.mergedInto ? `It landed on ${event.task.mergedInto}.` : 'It is done.');
        else if (event.cause === 'state' && event.task.state === 'failed') say(row, 'It was stopped.');
        break;
      case 'run_started': {
        const name = who(event.run.employeeId);
        if (sentBack && authored(event.run)) fixing.add(event.run.id);
        if (asked && event.run.mode === 'review') answering.add(event.run.id);
        if (event.run.mode !== 'route') sentBack = false;
        if (authored(event.run)) asked = false;
        say(row, fixing.has(event.run.id) ? `${name} started fixing it.` : answering.has(event.run.id) ? `${name} took the question.` : `${name} ${STARTED[event.run.mode]}.`);
        break;
      }
      case 'run_ended': {
        const { run } = event;
        const name = who(run.employeeId);
        if (over.has(run.id)) {
          // The one ending that changes after the fact: an approval that did not stand, because a check it relied on failed.
          if (run.mode === 'review' && run.reason === 'sent_back' && over.get(run.id) === 'approved') {
            over.set(run.id, 'sent_back');
            sentBack = true;
            say(row, `${name}'s approval did not stand: a check it relied on failed, so it went back.`);
          }
          break;
        }
        over.set(run.id, run.reason);
        if (run.mode === 'review' && run.outcome === 'done' && run.reason === 'sent_back') sentBack = true;
        if (authored(run) && run.reason === 'question') asked = true;
        if (answering.has(run.id)) asked = false;
        say(row, fixing.has(run.id) && run.outcome === 'done' ? `${name} reported it fixed.` : answering.has(run.id) && run.reason === 'escalated' ? `${name} passed the question on.` : ended(run, name));
        break;
      }
      case 'gate_finished':
        // A check the employee asked for while working is its own business; the engine's own are the task's.
        if (!event.asked) say(row, `The check "${event.result.name}" ${event.result.exitCode === 0 ? 'passed' : 'failed'}${event.result.reused ? ' (on exactly these files, a moment before)' : ''}.`);
        break;
      case 'decision_raised':
        say(row, event.decision.deciderId ? `${who(event.decision.deciderId)} was asked to decide: ${WHY[event.decision.kind]}.` : `A decision is waiting on you: ${WHY[event.decision.kind]}.`);
        break;
      case 'decision_answered': {
        const { answer, options } = event.decision;
        const pressed = options.find((option) => option.id === answer?.optionId);
        if (event.result === 'applied' && answer && pressed) say(row, `${who(answer.by ?? 'user')} decided: ${pressed.label}.`);
        break;
      }
      default:
        break;
    }
  }
  return told.reverse();
}

/** How a run ended, as a sentence. Null when its ending says nothing worth a line. */
function ended(run: Run, name: string): string | null {
  if (run.mode === 'route') return null;
  if (run.outcome === 'done') {
    if (run.mode !== 'review') return run.mode === 'brief' ? `${name} finished planning it.` : run.mode === 'integrate' ? `${name} put the parts together.` : `${name} reported it done.`;
    const mustFix = (run.findings ?? []).filter((finding) => finding.severity === 'blocking').length;
    if (run.reason === 'approved') return `${name} approved it.`;
    if (run.reason === 'sent_back') return `${name} sent it back${mustFix > 0 ? `: ${count(mustFix, 'thing')} to fix` : ''}.`;
    if (run.reason === 'escalated') return `${name} could not decide it.`;
    if (run.reason === 'answered') return `${name} answered a question about it.`;
    return null;
  }
  switch (run.reason) {
    case 'question':
      return `${name} stopped with a question.`;
    case 'tools':
      return `${name} asked for a tool it does not have.`;
    case 'stopped_by_user':
      return `You stopped ${name}'s run.`;
    case 'no_progress':
      return `${name} was stopped: it was getting nowhere.`;
    case 'waiting':
      return `${name} is waiting for another task.`;
    case 'task_stopped':
    case 'restart':
    case 'usage_limit':
      return null;
    default:
      return run.outcome === 'expired' ? `${name}'s run went silent.` : run.outcome === 'failed' ? `${name}'s run failed.` : run.outcome === 'over_budget' ? `${name}'s run reached its budget.` : null;
  }
}
