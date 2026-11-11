/**
 * The company's tools for a Claude session: talk to the chief of staff or to any employee, read
 * the boards, see the cards that wait for the user and press their buttons, put work on a team.
 *
 * They are a second way in, beside the screen, and they go through the same door: the engine's
 * own API on this machine, with the same token. Nothing here reads the database or does anything
 * the screen cannot do.
 */
import { z } from 'zod';
import { ADMIN_DESCRIPTION, ADMIN_INPUT, ADMIN_TOOLS } from '../shared/adminTools.ts';
import type { Decision, Employee, Message, Run, Task, Team } from '../shared/types.ts';
import { countsCost } from '../shared/view.ts';

export type Call = <T>(method: 'GET' | 'POST', route: string, body?: unknown) => Promise<T>;
export type Ctx = {
  call: Call;
  /** How long a tool waits for an employee's reply before saying that none has come yet. */
  waitMs?: number;
  pollMs?: number;
  /** Starts the engine on this machine when it is not running. Only the real server has one. */
  start?: () => Promise<string>;
};
export type Tool = { name: string; description: string; input: z.ZodRawShape; run(args: Record<string, unknown>, ctx: Ctx): Promise<string> };

/** What is said to every session that has these tools, before it uses one. */
export const INSTRUCTIONS = `This is the user's line to their chief of staff (Neo, unless they renamed it) and the company it runs. When the user says "ask Neo", "tell Neo" or names the company, use chat: Neo knows every board and turns a request into tasks on the right team. These tools reach a company of AI employees that runs on this Mac: teams with boards of tasks, a chief of staff who answers questions and turns requests into tasks, and cards for the decisions that are the user's alone. The same company is on screen at http://127.0.0.1:4317.

Read: now (every board, who is running, cards waiting, spend today), tasks, task (one task with its runs), cards, replies (what employees last said to the user).
Talk: chat (the chief of staff: questions about the company, and requests it turns into tasks on the right team), morpheus (the admin, as an employee: questions about the setup, and changes to teams, people, models, caps, rules and gates said in plain words), message (one employee by name: answered as a conversation; work that is asked for goes on that employee's own team's board).
Act: answer_card (presses one button of a card), new_task (puts a task straight on a team's board), start (starts the company when a tool says it is not running).
Setup: company_setup reads the whole setup (teams, people, models, caps, rules, gates); create_team, update_team, remove_team, hire, update_employee, fire, update_company and set_gates change it at once. Use a setup tool only when the user asked for that change, and read company_setup first.

Ask the user before answer_card unless they named the card and the button themselves: a card is a decision that is theirs (a merge, a raised cap, a tool handed to an employee). Ask before new_task unless they asked for that task. chat and message cost a little and can start work; use now, tasks and cards for plain questions about what is going on, which cost nothing.
An employee's reply can take from a few seconds to a few minutes. When a tool says no reply has come yet, tell the user so and call replies later; do not send the message again.`;

type Snapshot = { company: { name: string; chiefOfStaffId: string | null; adminId?: string | null; costs?: 'on' | 'off' } | null; teams: Team[]; employees: Employee[]; tasks: Task[]; runs: Run[]; decisions: Decision[]; messages: Message[] };

/** A problem that is the caller's to fix, said in words it can act on. */
class Refused extends Error {}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const usd = (amount: number): string => `$${amount.toFixed(2)}`;
const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/** An employee or a team by its id or by its name, whatever the capitals. */
function byName<T extends { id: string; name: string }>(list: T[], wanted: string): T | undefined {
  const plain = wanted.trim().toLowerCase();
  return list.find((entry) => entry.id === wanted.trim()) ?? list.find((entry) => entry.name.toLowerCase() === plain);
}

/** Waits for what an employee says back about one message. Null when nothing came in time. */
async function replyTo(ctx: Ctx, sent: Message): Promise<Message | null> {
  const until = Date.now() + (ctx.waitMs ?? 120_000);
  for (;;) {
    const { messages } = await ctx.call<Snapshot>('GET', '/api/snapshot');
    const reply = messages.find((message) => message.fromId === sent.toId && message.toId === 'user' && message.taskId === sent.taskId && message.at >= sent.at);
    if (reply) return reply;
    if (Date.now() >= until) return null;
    await sleep(ctx.pollMs ?? 2000);
  }
}

async function said(ctx: Ctx, sent: Message, name: string): Promise<string> {
  const reply = await replyTo(ctx, sent);
  return reply ? `${name}: ${reply.text}` : `${name} has not answered yet. The message was delivered and is being worked on: call replies in a little while to read the answer. Do not send it again.`;
}

export const TOOLS: Tool[] = [
  {
    name: 'start',
    description: 'Starts the company on this Mac if it is not running, and says where it is. Use it when another tool says the company is not running.',
    input: {},
    run: async (_args, ctx) => {
      if (!ctx.start) throw new Refused('The company cannot be started from here.');
      return ctx.start();
    },
  },
  {
    name: 'now',
    description: 'What the company is doing right now: every team\'s board, who is running, the cards waiting for the user, and what was spent today. Costs nothing; use it first for any question about what is going on.',
    input: {},
    run: async (_args, ctx) => (await ctx.call<{ text: string }>('GET', '/api/now')).text,
  },
  {
    name: 'chat',
    description: 'Says something to the chief of staff, as the company chat on screen does, and waits for the reply. The chief of staff answers questions about the company and turns requests for work into tasks on the right teams.',
    input: { text: z.string().min(1).describe('What to say, in the user\'s own words where they gave them.') },
    run: async (args, ctx) => {
      const { company, employees } = await ctx.call<Snapshot>('GET', '/api/snapshot');
      const chief = employees.find((employee) => employee.id === company?.chiefOfStaffId);
      if (!chief || chief.fired) throw new Refused('This company has no chief of staff to talk to. Use message to write to an employee by name, or hire a chief of staff on screen.');
      const { message } = await ctx.call<{ message: Message }>('POST', '/api/chat', { text: text(args.text) });
      return said(ctx, message, chief.name);
    },
  },
  {
    name: 'morpheus',
    description: "Says something to Morpheus, the admin of this company app, and waits for the reply. Morpheus changes the setup at once (teams, people, models, efforts, tools, skills, caps, rules, gates). He does not change the app's code: a bug or a feature for the app goes to the morpheus chat in the Claude app.",
    input: { text: z.string().min(1).describe('What to say, in the user\'s own words where they gave them.') },
    run: async (args, ctx) => {
      const { company, employees } = await ctx.call<Snapshot>('GET', '/api/snapshot');
      const admin = employees.find((employee) => employee.id === company?.adminId);
      if (!admin || admin.fired) throw new Refused('This company has no admin yet: nobody is set up as Morpheus.');
      const { message } = await ctx.call<{ message: Message }>('POST', `/api/employees/${admin.id}/message`, { text: text(args.text) });
      if (message.taskId === null) return `${admin.name} is in the middle of a run, so your message goes to it as that run's next turn. There is no separate reply.`;
      return said(ctx, message, admin.name);
    },
  },
  {
    name: 'message',
    description: 'Writes to one employee by name and waits for the reply. It is a conversation: a question is answered in words; if work is asked for, that employee puts it on its own team\'s board.',
    input: { to: z.string().min(1).describe('The employee\'s name, as on screen.'), text: z.string().min(1) },
    run: async (args, ctx) => {
      const { employees } = await ctx.call<Snapshot>('GET', '/api/snapshot');
      const staff = employees.filter((employee) => !employee.fired);
      const employee = byName(staff, text(args.to));
      if (!employee) throw new Refused(`Nobody here is called "${text(args.to)}". The employees are: ${staff.map((entry) => entry.name).join(', ')}.`);
      const { message } = await ctx.call<{ message: Message }>('POST', `/api/employees/${employee.id}/message`, { text: text(args.text) });
      // A busy employee gets the message as the next turn of the run it is in: there is no separate answer to wait for.
      if (message.taskId === null) return `${employee.name} is in the middle of a run, so your message goes to it as that run's next turn. There is no separate reply: look at the task it is working on.`;
      return said(ctx, message, employee.name);
    },
  },
  {
    name: 'replies',
    description: 'What employees last said to the user, newest last. Use it to read an answer that had not come yet when chat or message returned.',
    input: { count: z.number().int().min(1).max(20).optional().describe('How many, 5 unless said.') },
    run: async (args, ctx) => {
      const { messages, employees } = await ctx.call<Snapshot>('GET', '/api/snapshot');
      const name = (id: string) => employees.find((employee) => employee.id === id)?.name ?? id;
      const toUser = messages.filter((message) => message.toId === 'user').slice(-(typeof args.count === 'number' ? args.count : 5));
      return toUser.length === 0 ? 'Nobody has said anything to you yet.' : toUser.map((message) => `${name(message.fromId)}: ${message.text}`).join('\n\n');
    },
  },
  {
    name: 'cards',
    description: 'The decision cards waiting for the user, each with its id and its buttons. Costs nothing.',
    input: {},
    run: async (_args, ctx) => {
      const { decisions } = await ctx.call<{ decisions: Decision[] }>('GET', '/api/decisions');
      if (decisions.length === 0) return 'No card is waiting for you.';
      return decisions
        .map((card) => `Card ${card.id} (${card.kind}): ${card.text}\n  Buttons: ${card.options.map((option) => `${option.id}: ${option.label}`).join(' | ')}${card.freeText ? '\n  Takes words with the answer.' : ''}`)
        .join('\n\n');
    },
  },
  {
    name: 'answer_card',
    description: 'Presses one button of a card, for the user. A card is a decision that is the user\'s alone: ask them first unless they named the card and the button themselves.',
    input: { card: z.string().min(1).describe('The card\'s id, from cards.'), option: z.string().min(1).describe('The id of the button, from cards.'), text: z.string().optional().describe('Words to go with it, for a card that takes them: an answer, or notes to send back.') },
    run: async (args, ctx) => {
      const { decisions } = await ctx.call<{ decisions: Decision[] }>('GET', '/api/decisions');
      const card = decisions.find((entry) => entry.id === text(args.card));
      if (!card) throw new Refused(`No card ${text(args.card)} is waiting. ${decisions.length === 0 ? 'No card is waiting at all.' : `The cards waiting are: ${decisions.map((entry) => entry.id).join(', ')}.`}`);
      const option = card.options.find((entry) => entry.id === text(args.option));
      if (!option) throw new Refused(`That card has no button "${text(args.option)}". Its buttons are: ${card.options.map((entry) => entry.id).join(', ')}.`);
      await ctx.call('POST', `/api/decisions/${card.id}/answer`, { optionId: option.id, ...(text(args.text) ? { text: text(args.text) } : {}) });
      return `Pressed "${option.label}" on the card: ${card.text.split('\n')[0]}`;
    },
  },
  {
    name: 'tasks',
    description: 'The tasks on the boards: what is open, and what finished today. Costs nothing.',
    input: {},
    run: async (_args, ctx) => {
      const { company, tasks, teams, employees, runs } = await ctx.call<Snapshot>('GET', '/api/snapshot');
      const priced = countsCost(company);
      const work = tasks.filter((task) => task.kind === 'work');
      if (work.length === 0) return 'There is no task on any board.';
      const cost = (taskId: string) => runs.filter((run) => run.taskId === taskId).reduce((sum, run) => sum + run.costUsd, 0);
      return work
        .map((task) => `${task.id}  "${task.title}"  ${teams.find((team) => team.id === task.teamId)?.name ?? task.teamId} · ${task.state}${task.assigneeId ? ` · ${employees.find((employee) => employee.id === task.assigneeId)?.name ?? task.assigneeId}` : ''}${priced ? ` · ${usd(cost(task.id))}` : ''}`)
        .join('\n');
    },
  },
  {
    name: 'task',
    description: 'One task in full: its brief, where it stands, each run with who did it and what they reported, its sub-tasks, and any card waiting on it. Costs nothing.',
    input: { id: z.string().min(1).describe('The task\'s id, from tasks.') },
    run: async (args, ctx) => {
      const { company, employees } = await ctx.call<Snapshot>('GET', '/api/snapshot');
      const priced = countsCost(company);
      const name = (id: string) => employees.find((employee) => employee.id === id)?.name ?? id;
      const { task, children, runs, decisions } = await ctx.call<{ task: Task; children: Task[]; runs: Run[]; decisions: Decision[] }>('GET', `/api/tasks/${encodeURIComponent(text(args.id))}`);
      return [
        `"${task.title}" (${task.state}${task.mergedInto ? `, merged into ${task.mergedInto}` : ''}${task.branch ? `, branch ${task.branch}` : ''})`,
        task.brief.trim(),
        task.doneCondition.trim() ? `Done when: ${task.doneCondition.trim()}` : '',
        children.length > 0 ? `Sub-tasks:\n${children.map((child) => `- ${child.id} "${child.title}" (${child.state})`).join('\n')}` : '',
        runs.length > 0 ? `Runs:\n${runs.map((run) => `- ${run.mode} by ${name(run.employeeId)}: ${run.outcome}${run.reason ? ` (${run.reason})` : ''}${priced ? `, ${usd(run.costUsd)}` : ''}${run.summary ? `\n  ${run.summary.trim().replace(/\n/g, '\n  ')}` : ''}`).join('\n')}` : 'No run yet.',
        decisions.length > 0 ? `Waiting on you:\n${decisions.map((card) => `- card ${card.id}: ${card.text}`).join('\n')}` : '',
      ]
        .filter(Boolean)
        .join('\n\n');
    },
  },
  {
    name: 'new_task',
    description: 'Puts a task straight on a team\'s board. On a team with a lead, leave the assignee out and the lead briefs it; a self-managed team needs one. For a request in loose words, chat is usually better: the chief of staff picks the team and writes the brief.',
    input: {
      team: z.string().min(1).describe('The team\'s name, as on screen.'),
      title: z.string().min(1),
      brief: z.string().min(1).describe('What to do, standing on its own.'),
      doneCondition: z.string().optional().describe('How someone can check that it is done.'),
      assignee: z.string().optional().describe('An employee\'s name.'),
    },
    run: async (args, ctx) => {
      const { teams, employees } = await ctx.call<Snapshot>('GET', '/api/snapshot');
      const team = byName(teams, text(args.team));
      if (!team) throw new Refused(`There is no team "${text(args.team)}". The teams are: ${teams.map((entry) => entry.name).join(', ')}.`);
      const staff = employees.filter((employee) => !employee.fired && employee.teamId === team.id);
      const assignee = text(args.assignee) ? byName(staff, text(args.assignee)) : undefined;
      if (text(args.assignee) && !assignee) throw new Refused(`Nobody on ${team.name} is called "${text(args.assignee)}". On that team: ${staff.map((entry) => entry.name).join(', ') || 'nobody yet'}.`);
      const { task } = await ctx.call<{ task: Task }>('POST', '/api/tasks', { teamId: team.id, title: text(args.title), brief: text(args.brief), ...(text(args.doneCondition) ? { doneCondition: text(args.doneCondition) } : {}), ...(assignee ? { assigneeId: assignee.id } : {}) });
      return `Created task ${task.id} "${task.title}" on ${team.name}${assignee ? ` for ${assignee.name}` : team.selfManaged ? '' : '; its lead will brief it'}.`;
    },
  },
];

// The setup tools: the same ones Morpheus has inside the company, called straight through the engine's API.
for (const name of ADMIN_TOOLS) {
  TOOLS.push({
    name,
    description: `${ADMIN_DESCRIPTION[name]} Changes the company's setup at once: use it only when the user asked for that change.`,
    input: ADMIN_INPUT[name].shape,
    run: async (args, ctx) => (await ctx.call<{ text: string }>('POST', `/api/admin/${name}`, args)).text,
  });
}

/** Calls the engine's API on this machine the way its own screen does: with the token, and as a request from its own address. */
export function caller(port: number, token: string): Call {
  const origin = `http://127.0.0.1:${port}`;
  return async <T>(method: 'GET' | 'POST', route: string, body?: unknown): Promise<T> => {
    let response: Response;
    try {
      response = await fetch(`${origin}${route}`, { method, headers: { authorization: `Bearer ${token}`, origin, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    } catch {
      throw new Refused(`The company is not running on this Mac: nothing answers on port ${port}. Call the start tool to start it, or in a terminal, in the app's folder: npm run live`);
    }
    const json = (await response.json().catch(() => ({}))) as T & { error?: string };
    if (response.status === 401) throw new Refused('The engine did not accept the token. It was probably started with another data folder than these tools read (VS_DATA_DIR).');
    if (!response.ok) throw new Refused(json.error ?? `The engine answered ${response.status} to ${method} ${route}.`);
    return json;
  };
}

/** Runs one tool. A refusal comes back as words for the session to act on, never as a crash. */
export async function runTool(name: string, args: unknown, ctx: Ctx): Promise<{ text: string; isError: boolean }> {
  const tool = TOOLS.find((entry) => entry.name === name);
  if (!tool) return { text: `There is no tool named ${name}.`, isError: true };
  try {
    return { text: await tool.run((args ?? {}) as Record<string, unknown>, ctx), isError: false };
  } catch (failure) {
    return { text: failure instanceof Error ? failure.message : String(failure), isError: true };
  }
}
