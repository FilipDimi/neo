import { describe, expect, it } from 'vitest';
import { IllegalTransition, TRANSITIONS, transition, type TaskEvent } from '../../src/supervisor/taskState.ts';
import type { TaskState } from '../../src/shared/types.ts';

const TABLE: [TaskEvent, TaskState, TaskState][] = [
  ['start_brief', 'queued', 'briefing'],
  ['start_work', 'queued', 'running'],
  ['subtasks_created', 'briefing', 'running'],
  ['reported_done', 'briefing', 'review'],
  ['reported_done', 'running', 'review'],
  ['approved', 'review', 'done'],
  ['sent_back', 'review', 'running'],
  ['complete', 'briefing', 'done'],
  ['complete', 'running', 'done'],
  ['complete', 'review', 'done'],
  ['block', 'queued', 'blocked'],
  ['block', 'briefing', 'blocked'],
  ['block', 'running', 'blocked'],
  ['block', 'review', 'blocked'],
  ['fail', 'queued', 'failed'],
  ['fail', 'briefing', 'failed'],
  ['fail', 'running', 'failed'],
  ['fail', 'review', 'failed'],
  ['fail', 'blocked', 'failed'],
];
const STATES: TaskState[] = ['queued', 'briefing', 'running', 'review', 'blocked', 'done', 'failed'];
const EVENTS = Object.keys(TRANSITIONS) as TaskEvent[];

describe('transition', () => {
  it.each(TABLE)('%s from %s gives %s', (event, from, to) => {
    expect(transition({ state: from, blockedFrom: null }, event).state).toBe(to);
  });

  it('remembers where a task was blocked from and returns there', () => {
    const blocked = transition({ state: 'review', blockedFrom: null }, 'block');
    expect(blocked).toEqual({ state: 'blocked', blockedFrom: 'review' });
    expect(transition(blocked, 'unblock')).toEqual({ state: 'review', blockedFrom: null });
  });

  it('throws on every pair outside the table', () => {
    const legal = new Set([...TABLE.map(([event, from]) => `${event}:${from}`), 'unblock:blocked']);
    let illegal = 0;
    for (const event of EVENTS)
      for (const from of STATES) {
        if (legal.has(`${event}:${from}`)) continue;
        illegal += 1;
        expect(() => transition({ state: from, blockedFrom: from === 'blocked' ? 'running' : null }, event), `${event} from ${from}`).toThrow(IllegalTransition);
      }
    expect(illegal).toBe(EVENTS.length * STATES.length - legal.size);
  });

  it('refuses to unblock a task that does not know where it came from', () => {
    expect(() => transition({ state: 'blocked', blockedFrom: null }, 'unblock')).toThrow(IllegalTransition);
  });
});
