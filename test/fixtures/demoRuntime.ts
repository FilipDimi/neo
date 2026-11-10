/**
 * A runtime with no model that plays every role plausibly: the chief of staff writes tasks, a
 * lead splits them, members write a file and report, reviewers approve, the lead integrates.
 * `npm run demo` runs the real engine on it, so the whole product can be looked at for free.
 *
 * A word in a task's brief changes what its employee does:
 *   HANG     never finishes (the lease expires)
 *   OUTSIDE  tries to write a file outside its folder (refused, with a card)
 *   ASK      asks the user a question
 *   REDO     the reviewer sends the work back once
 */
import type { RuntimeFactory } from '../../src/runtime/sdk.ts';
import { staged, type Scene } from './staged.ts';

const pace = Number(process.env.VS_DEMO_DELAY_MS ?? 1500);
const wait = (factor = 1) => new Promise((resolve) => setTimeout(resolve, pace * factor));
const sentBack = new Set<string>();

const titleOf = (s: Scene): string => /^# Task: (.+)$/m.exec(s.input.prompt)?.[1] ?? 'the task';
const slug = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 30) || 'work';

async function play(s: Scene): Promise<void> {
  const prompt = s.input.prompt;
  const title = titleOf(s);
  switch (s.mode) {
    case 'route': {
      await s.engine('set_status', { text: 'reading your message' });
      await wait();
      const teams = [...prompt.matchAll(/^- (.+?) \(teamId: ([^;]+); (self-managed|led)[^\n]*\n((?: {4}- .*\n?)*)/gm)].filter((team) => !/^Office$/i.test(team[1]!));
      const asked = /^The user wrote[^\n]*\n\n([\s\S]*?)\n\nTurn this into work/m.exec(prompt)?.[1]?.trim() ?? 'the request';
      let written = 0;
      for (const [index, team] of teams.slice(0, 2).entries()) {
        const [, name, teamId, kind, members] = team;
        const assigneeId = kind === 'self-managed' ? /\(id: ([^)]+)\)/.exec(members ?? '')?.[1] : undefined;
        if (kind === 'self-managed' && !assigneeId) continue;
        const piece = asked.split(/\band\b|[.;]/).map((part) => part.trim()).filter(Boolean)[index] ?? asked;
        const made = await s.engine('create_task', { teamId, ...(assigneeId ? { assigneeId } : {}), title: piece.slice(0, 60), brief: `${piece}. (From the company chat: "${asked}")`, priority: 2, doneCondition: `"${piece}" is done and reported.`, capUsd: 2 });
        if (made.ok) written += 1;
        await wait(0.5);
        void name;
      }
      return s.say(written > 0 ? `I wrote ${written} task${written === 1 ? '' : 's'} from that and put ${written === 1 ? 'it' : 'them'} on the board.` : 'I could not find a team for that. Add a team, then ask again.');
    }
    case 'brief': {
      await s.engine('set_status', { text: `splitting "${title.slice(0, 30)}"` });
      await wait();
      const people = [...prompt.matchAll(/\(assigneeId: ([^)]+)\)/g)].map((match) => match[1]!);
      const gates = /Gates you can name: ([^.\n]+)\./.exec(prompt)?.[1]?.split(', ') ?? [];
      if (people.length < 2) {
        s.write(`${slug(title)}.md`, `# ${title}\n\nDone by the lead.\n`);
        return void (await s.engine('report_done', { summary: `Did "${title}" myself: it was too small to split.` }));
      }
      const subtasks = people.slice(0, 2).map((assigneeId, index) => ({
        title: `${title.slice(0, 44)}: part ${index + 1}`,
        assigneeId,
        brief: `Part ${index + 1} of "${title}". Write your part under part-${index + 1}/.`,
        ownership: [`part-${index + 1}`],
        doneCondition: `part-${index + 1}/ holds the finished part.`,
        gates: gates.slice(0, 1),
        priority: 2,
        capUsd: 0.5,
        retryAllowed: true,
      }));
      return void (await s.engine('propose_subtasks', { subtasks }));
    }
    case 'work': {
      if (prompt.includes('HANG')) return new Promise(() => {});
      await s.engine('set_status', { text: `${s.resumed ? 'fixing' : 'working on'} ${title.slice(0, 36)}` });
      await wait(2);
      if (prompt.includes('ASK') && !s.resumed) return void (await s.engine('request_decision', { question: `For "${title}": should this follow the old layout or the new one?`, options: ['The old layout', 'The new layout'] }));
      if (prompt.includes('OUTSIDE') && !s.resumed) await s.tool('Write', { file_path: '/tmp/vs-demo-outside.txt', content: 'outside' });
      const owned = /^Files this task owns: (.+)$/m.exec(prompt)?.[1]?.split(', ')[0];
      const dir = owned && owned !== 'everything in your folder' ? `${owned}/` : '';
      s.write(`${dir}${slug(title)}.md`, `# ${title}\n\nWritten by ${s.who}${s.resumed ? ', revised' : ''}.\n`);
      await wait();
      return void (await s.engine('report_done', { summary: `${s.resumed ? 'Revised' : 'Wrote'} ${dir}${slug(title)}.md for "${title}".` }));
    }
    case 'review': {
      await s.engine('set_status', { text: `reviewing ${title.slice(0, 40)}` });
      await wait(1.5);
      if (prompt.includes('REDO') && !sentBack.has(title)) {
        sentBack.add(title);
        return void (await s.engine('submit_review', { verdict: 'send_back', notes: 'Close, but say who it is for in the first line.' }));
      }
      return void (await s.engine('submit_review', { verdict: 'approve', notes: '' }));
    }
    case 'integrate': {
      await s.engine('set_status', { text: `putting ${title.slice(0, 36)} together` });
      await wait(1.5);
      return void (await s.engine('report_done', { summary: `Integrated the parts of "${title}".` }));
    }
  }
}

export const startSession: RuntimeFactory = staged(play);
