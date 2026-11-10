/** The recorded company day (see scripts/story.ts), replayed up to a named mark. */
import type { EventRow } from '../../../src/shared/events.ts';
import { fromSnapshot, reduce, type Snapshot, type Store } from '../store/reduce.ts';
import recorded from './story.json' with { type: 'json' };

const story = recorded as unknown as { snapshot: Snapshot; marks: { name: string; eventId: number; now: string }[]; events: EventRow[] };

export const storyMarks = story.marks.map((mark) => mark.name);
export const storyEvents = story.events;
export const storySnapshot = story.snapshot;

/** The store and the clock as they were at a mark. */
export function storyAt(name: string): { store: Store; now: Date } {
  const mark = story.marks.find((m) => m.name === name);
  if (!mark) throw new Error(`the story has no mark "${name}"; it has: ${storyMarks.join(', ')}`);
  let store = fromSnapshot(story.snapshot);
  for (const row of story.events) if (row.id <= mark.eventId) store = reduce(store, row);
  return { store, now: new Date(mark.now) };
}

export const taskTitled = (store: Store, title: string) => [...store.tasks.values()].find((task) => task.title === title);
