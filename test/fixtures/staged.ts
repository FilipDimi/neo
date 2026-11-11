/** A fake runtime where each session plays a role: the play function is told who is running and in which mode. */
import fs from 'node:fs';
import path from 'node:path';
import { fakeRuntime, type FakeRuntime, type Turn } from './fakeRuntime.ts';

export type Scene = Turn & {
  /** 'decide' is the chief of staff's conversation about a card: a route run with the tool that answers it. */
  mode: 'brief' | 'work' | 'review' | 'integrate' | 'route' | 'decide';
  who: string;
  cwd: string;
  /** True when this session picks up an earlier one (a send-back, an answer, a retry). */
  resumed: boolean;
  write(file: string, content: string): void;
  read(file: string): string;
};

function modeOf(turn: Turn): Scene['mode'] {
  const tools = turn.input.engineTools?.names ?? [];
  if (tools.includes('propose_subtasks')) return 'brief';
  if (tools.includes('submit_review')) return 'review';
  if (tools.includes('decide')) return 'decide';
  if (tools.includes('create_task')) return 'route';
  return /Every sub-task of this task is finished|conflict/i.test(turn.input.prompt) ? 'integrate' : 'work';
}

/** `play` runs for the first turn of every session; later turns (reminders, messages) do nothing unless `everyTurn`. */
export function staged(play: (scene: Scene) => Promise<void> | void, options: { everyTurn?: boolean; costPerTurn?: number } = {}): FakeRuntime {
  return fakeRuntime(async (turn) => {
    if (turn.index > 0 && !options.everyTurn) return;
    const cwd = turn.input.cwd;
    await play({
      ...turn,
      mode: modeOf(turn),
      who: /You are ([^,]+),/.exec(turn.input.systemPrompt)?.[1] ?? '?',
      cwd,
      resumed: turn.input.resumeSessionId !== undefined,
      write: (file, content) => {
        fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
        fs.writeFileSync(path.join(cwd, file), content);
      },
      read: (file) => fs.readFileSync(path.join(cwd, file), 'utf8'),
    });
  }, options);
}
