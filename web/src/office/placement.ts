/**
 * Where an employee is in the office. A pure function of the store, so the room cannot say
 * anything the board does not: a desk with a dark screen is idle, a lit one is a run, the meeting
 * room is a review, the couch under the red lamp is stuck and needs the user.
 */
import type { Run } from '../../../src/shared/types.ts';
import { WHY } from '../../../src/shared/view.ts';
import { liveRuns, openDecisions, runsOf } from '../model/select.ts';
import type { Store } from '../store/reduce.ts';

export type Placement = { where: 'desk' | 'meeting' | 'stuck'; screen: 'dark' | 'lit'; bubble: string | null; /** `waiting`: at work, and held up by the engine for a moment (a check that is running, a turn to wait for). */ tone: 'plain' | 'review' | 'stuck' | 'waiting'; decisionId: string | null; taskId: string | null };

/** A status line is a sentence of up to this many characters; the room wraps it, so all of it is kept. */
const BUBBLE_MAX = 60;
export const cut = (text: string, max = BUBBLE_MAX): string => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);

/**
 * What someone says, on at most `lines` lines of `perLine` letters, broken between words. A sentence is never cut
 * in the middle of a word to fit beside the next seat: what does not fit ends with an ellipsis after a whole word.
 * Only a word longer than a line is cut.
 */
export function wrap(text: string, perLine: number, lines = 2): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of text.trim().split(/\s+/)) {
    if (word.length > perLine) {
      // A word longer than a line is the only thing ever cut. It goes on a line of its own where there is one, so the
      // words before it stay whole; where there is none, the line before it ends the bubble.
      if (!line) return [...out, cut(word, perLine)];
      if (out.length < lines - 1) return [...out, line, cut(word, perLine)];
      let last = line;
      while (`${last}…`.length > perLine && last.includes(' ')) last = last.slice(0, last.lastIndexOf(' '));
      return [...out, `${last}…`];
    }
    if (!line || `${line} ${word}`.length <= perLine) {
      line = line ? `${line} ${word}` : word;
      continue;
    }
    if (out.length === lines - 1) {
      // No room for another line: this one ends the bubble, with whole words only.
      let last = line;
      while (`${last}…`.length > perLine && last.includes(' ')) last = last.slice(0, last.lastIndexOf(' '));
      return [...out, `${last}…`];
    }
    out.push(line);
    line = word;
  }
  return line ? [...out, line] : out;
}
const times = (n: number): string => (n <= 1 ? '' : n === 2 ? ', twice' : `, ${n} times`);
/** What someone is on, as they would say it, when their run has said nothing of its own. */
const DOING: Record<Run['mode'], string> = { work: 'Working on', brief: 'Planning', integrate: 'Putting together', review: 'Reviewing', route: 'Answering' };
const authored = (run: Run): boolean => run.mode === 'work' || run.mode === 'brief' || run.mode === 'integrate';

export function placement(employeeId: string, store: Store, _now: Date): Placement {
  const open = openDecisions(store);

  // 1. Stuck: their run went silent, or their task is blocked on a card. The first that holds wins.
  const silent = open.find((decision) => decision.kind === 'lease' && decision.employeeId === employeeId);
  const blocked = [...store.tasks.values()].find((task) => task.state === 'blocked' && task.assigneeId === employeeId && open.some((decision) => decision.taskId === task.id));
  const card = silent ?? (blocked ? open.find((decision) => decision.taskId === blocked.id) : undefined);
  if (card) {
    const runs = card.taskId ? runsOf(store, card.taskId) : [];
    const lease = (card.runId ? store.runs.get(card.runId) : runs.at(-1))?.leaseMinutes;
    const bubble = card.kind === 'lease' ? `Quiet for ${lease ?? '?'} min${times(runs.filter((run) => run.outcome === 'expired').length)}` : WHY[card.kind];
    return { where: 'stuck', screen: 'dark', bubble, tone: 'stuck', decisionId: card.id, taskId: card.taskId };
  }

  // 2. In the meeting room: the author of work under review, and whoever is reviewing right now.
  const live = liveRuns(store).find((run) => run.employeeId === employeeId);
  const reviewing = live?.mode === 'review' ? store.tasks.get(live.taskId) : undefined;
  const underReview =
    reviewing ??
    [...store.tasks.values()].find((task) => {
      if (task.state !== 'review') return false;
      const author = runsOf(store, task.id).filter(authored).at(-1)?.employeeId ?? task.assigneeId;
      return author === employeeId;
    });
  if (underReview) return { where: 'meeting', screen: 'dark', bubble: `Reviewing ${cut(underReview.title, 30)}`, tone: 'review', decisionId: null, taskId: underReview.id };

  // 3. At the desk with the screen lit: a run. The bubble is the employee's own status line when it has set one.
  if (live) {
    const task = store.tasks.get(live.taskId);
    // Waiting is not working: a run the engine holds up for a moment says what for, quietly.
    if (live.waiting) return { where: 'desk', screen: 'lit', bubble: live.waiting.on === 'gate' ? `Waiting for the check "${cut(live.waiting.what, 24)}"` : 'Waiting for my turn', tone: 'waiting', decisionId: null, taskId: live.taskId };
    const doing = live.mode === 'route' || task?.kind === 'chat' ? 'Answering a message' : `${DOING[live.mode]} ${task?.title ?? 'a task'}`;
    return { where: 'desk', screen: 'lit', bubble: cut(live.activity ?? doing), tone: 'plain', decisionId: null, taskId: live.taskId };
  }

  // 4. Idle.
  return { where: 'desk', screen: 'dark', bubble: null, tone: 'plain', decisionId: null, taskId: null };
}
