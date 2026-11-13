/**
 * A design meeting: teams agree on what passes between them before they build against it. Each affected lead writes
 * its team's position alone; the author team's lead drafts the design from all of them; every other lead reviews it in
 * turn. When they agree (or the chief of staff accepts it once the rounds run out), its decisions go on record and each
 * team with work from it gets a ticket built on them. The flow carries it; this file says what a meeting is.
 */
import type { Tx } from '../db/apply.ts';
import type { Db } from '../db/open.ts';
import * as store from '../db/store.ts';
import type { Employee, Repo, Run, Task, Team } from '../shared/types.ts';
import type { ToolReply } from '../runtime/tools.ts';
import type { TOOL_INPUT } from '../worker/protocol.ts';
import type { z } from 'zod';
import * as decisions from './decisions.ts';
import { builtOnFor, recordDecision } from './record.ts';
import { requestFor } from './scheduler.ts';

export type MeetingCall = z.infer<typeof TOOL_INPUT.call_meeting>;
type Report = z.infer<typeof TOOL_INPUT.report_done>;
export type Proposals = NonNullable<Run['proposals']>;
type Meeting = NonNullable<Task['meeting']>;

/** A team that has a lead to speak for it. */
const canMeet = (db: Db, team: Team): boolean => {
  const lead = !team.removed && !team.selfManaged && team.leadId ? store.getEmployee(db, team.leadId) : undefined;
  return Boolean(lead && !lead.fired);
};

/** A team named by its id or by its name, in any case. A removed team is not found. */
function teamNamed(db: Db, name: string): Team | undefined {
  const wanted = name.trim().toLowerCase();
  return store.allTeams(db).find((team) => !team.removed && (team.id === name.trim() || team.name.toLowerCase() === wanted));
}

const names = (teams: Team[]): string => teams.map((team) => team.name).join(', ');

/** "Rust, iOS and Web". */
export function listed(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

export type MeetingPlan = { caller: Employee; author: Team; teams: Team[]; repoId: string; call: MeetingCall };

/** Whether this can be a meeting, and if it can, who is in it. Refusals say what would work. */
export function planMeeting(db: Db, callerId: string, call: MeetingCall): MeetingPlan | { refused: string } {
  const caller = store.getEmployee(db, callerId);
  const company = store.getCompany(db);
  const leads = store.allTeams(db).some((team) => !team.removed && team.leadId === callerId);
  if (!caller || caller.fired || (company?.chiefOfStaffId !== callerId && !leads)) return { refused: 'A design meeting is called by a team\'s lead or the chief of staff. Tell your lead what you need from the other team.' };
  const teams: Team[] = [];
  for (const name of call.teams) {
    const team = teamNamed(db, name);
    if (!team) return { refused: `There is no team "${name}". The teams that can meet are: ${names(store.allTeams(db).filter((other) => canMeet(db, other)))}.` };
    if (!teams.some((other) => other.id === team.id)) teams.push(team);
  }
  if (teams.length < 2) return { refused: 'A design meeting needs at least two teams: name every team the question touches. One team settles its own design in its own work.' };
  const leaderless = teams.find((team) => !canMeet(db, team));
  if (leaderless) return { refused: `${leaderless.name} has no lead to write its position${leaderless.selfManaged ? ': it is self-managed' : ''}. Leave it out, or give it a lead first.` };
  const author = teamNamed(db, call.author);
  if (!author || !teams.some((team) => team.id === author.id)) return { refused: `The author must be one of the teams in the meeting (${names(teams)}): the one that builds what the others use.` };
  const repoId = author.repos[0]?.repoId;
  if (!repoId) return { refused: `${author.name} works in no repository, so there is nowhere to write the design. Make the author a team that does.` };
  const topic = call.topic.trim().toLowerCase();
  const open = store.listTasks(db).find((task) => task.meeting && task.state !== 'done' && task.state !== 'failed' && task.meeting.topic.trim().toLowerCase() === topic);
  if (open) return { refused: `A design meeting on "${open.meeting!.topic}" is already being held. Its decisions go on record when it is agreed: carry on with what does not depend on it.` };
  return { caller, author, teams: [author, ...teams.filter((team) => team.id !== author.id)], repoId, call };
}

/** The meeting, and one position for each team, in one change. Each lead is asked for its position at once. */
export function holdMeeting(tx: Tx, db: Db, now: Date, plan: MeetingPlan): Task {
  const { caller, author, teams, call } = plan;
  const topic = call.topic.trim();
  const leadOf = (team: Team) => store.getEmployee(db, team.leadId!)!;
  const meeting = store.newTask(
    {
      teamId: author.id,
      assigneeId: author.leadId,
      createdBy: caller.id,
      title: `Design: ${topic}`,
      summary: `${listed(teams.map((team) => team.name))} agree on ${topic}.`.slice(0, 300),
      brief: `A design meeting of ${listed(teams.map((team) => team.name))} on "${topic}", called by ${caller.name}.\n\nThe question: ${call.question.trim()}\n\nEach team's lead writes its position alone. ${author.name}'s lead drafts the design from all of them, in this task's folder, and every other lead reviews it in turn. When they all approve, its decisions go on record and each team with work from it gets a ticket built on them.`,
      doneCondition: 'Every other lead in the meeting has approved the design.',
      repoId: plan.repoId,
      state: 'running',
      capUsd: 5,
      meeting: { topic, question: call.question.trim(), calledBy: caller.id, teams: teams.map((team) => team.id), approvedBy: [] },
    },
    now,
  );
  tx.emit({ kind: 'task_changed', task: meeting, cause: 'created' });
  for (const [index, team] of teams.entries()) {
    const at = new Date(now.getTime() + index + 1);
    const repoId = team.repos.find((entry) => entry.repoId === plan.repoId)?.repoId ?? team.repos[0]?.repoId ?? null;
    const position = store.newTask(
      {
        teamId: team.id,
        parentId: meeting.id,
        assigneeId: team.leadId,
        createdBy: caller.id,
        title: `Position on ${topic}`,
        summary: `${team.name}'s position on ${topic}.`.slice(0, 300),
        brief: `${team.name}'s position in the design meeting on "${topic}".\n\nThe question: ${call.question.trim()}`,
        doneCondition: `${team.name}'s position is reported.`,
        repoId,
        meetingRole: 'position',
      },
      at,
    );
    tx.emit({ kind: 'task_changed', task: position, cause: 'created' });
    tx.emit({ kind: 'run_requested', request: store.newRequest({ taskId: position.id, mode: 'work', employeeId: leadOf(team).id, reason: 'new' }, at) });
  }
  return meeting;
}

/** What a lead is told when it is asked for its team's position. */
export function positionTurn(db: Db, position: Task): string {
  const meeting = position.parentId ? store.getTask(db, position.parentId) : undefined;
  const m = meeting?.meeting;
  const team = store.getTeam(db, position.teamId)!;
  if (!meeting || !m) return position.brief;
  const author = store.getTeam(db, meeting.teamId)!;
  const others = m.teams.filter((id) => id !== team.id).map((id) => store.getTeam(db, id)).filter((other): other is Team => other !== undefined);
  const { topic, question } = m;
  const caller = store.getEmployee(db, m.calledBy)?.name ?? 'The chief of staff';
  return `# Your team's position: ${topic}

${caller} has called a design meeting of ${listed([team.name, ...others.map((other) => other.name)])} on "${topic}". You speak for ${team.name}.

The question: ${question}

Write ${team.name}'s position, alone: you do not see the other teams' positions until the design is drafted, and they do not see yours. Say what ${team.name} needs, what it can offer, what constrains it, and what you propose. Read what you need in your folder, and cite files where you make a claim. Change no file: a position is words, and nothing in your folder is kept.

${author.id === team.id ? `${team.name} is the author: once every position is in, you draft the design from all of them.` : `${author.name}'s lead drafts the design from every position, and you review it for ${team.name} before it is agreed.`}

When it is written, call mcp__engine__report_done: its summary is your position, whole, as the author will read it.`;
}

/** The positions that came in, in the meeting's order: each under its team's name and its lead's. */
function positionsOf(db: Db, meeting: Task): { team: Team; by: string; position: string | null }[] {
  const children = store.listTasks(db, { parentId: meeting.id }).filter((child) => child.meetingRole === 'position');
  return (meeting.meeting?.teams ?? []).flatMap((teamId) => {
    const team = store.getTeam(db, teamId);
    const child = children.find((one) => one.teamId === teamId);
    if (!team || !child) return [];
    const run = store.runsOf(db, child.id).findLast((one) => one.mode === 'work' && one.outcome === 'done');
    return [{ team, by: store.getEmployee(db, run?.employeeId ?? child.assigneeId ?? '')?.name ?? 'its lead', position: child.state === 'done' ? (run?.summary?.trim() ?? null) : null }];
  });
}

/** What the author team's lead is told to draft the design: every position, and what its report must hold. */
export function draftTurn(db: Db, meeting: Task, repo: Repo): string {
  const m = meeting.meeting!;
  const teams = m.teams.map((id) => store.getTeam(db, id)).filter((team): team is Team => team !== undefined);
  const author = teams[0]!;
  const contract = repo.contract?.paths ?? [];
  const positions = positionsOf(db, meeting)
    .map(({ team, by, position }) => `## ${team.name}, by ${by}\n${position ?? '(no position: it did not finish)'}`)
    .join('\n\n');
  return `# Task: ${meeting.title}

You draft the design for the meeting of ${listed(teams.map((team) => team.name))} on "${m.topic}", called by ${store.getEmployee(db, m.calledBy)?.name ?? 'the chief of staff'}. ${author.name} writes it because it builds what the others use. Every other lead then reviews it for its own team, one after another, and it is agreed only when every one of them approves.

The question: ${m.question}

Each team's position, written alone:

${positions}

Write the design in your folder, so that every team can build against it from the files alone:
${contract.length > 0 ? `- If it changes the contract (${contract.join(', ')}), first get its version with mcp__engine__contract_version, then change the contract's files and state that version in them.\n` : ''}- Anything else the design needs, write as a short design note where the repository keeps such notes.
- Where the positions disagree, settle it and say which way and why. Do not build the feature itself: each team builds its part on its own ticket once the design is agreed.

Then call mcp__engine__report_done with:
- summary: the design in a few sentences;
- decisions: what the design settles, one sentence each, with why. They go on record, numbered, when it is agreed;
- followUps: one ticket for each team with work from it (team, title, brief, doneCondition), from ${listed(teams.map((team) => team.name))}. They are made when it is agreed, built on its decisions;
- checks: what you checked, as in any report.
If it is sent back, change what the review asks for and report again; give decisions and followUps again only if they change, since the last ones you gave stand.`;
}

/** The decisions and the tickets a report proposes, checked: only the design of a meeting proposes any. */
export function proposalsOf(db: Db, task: Task | undefined, report: Report): { proposals?: Proposals } | { refused: string } {
  if (report.decisions === undefined && report.followUps === undefined) return {};
  if (!task?.meeting) return { refused: 'decisions and followUps are only for the design of a design meeting, and this task is not one. Report again without them.' };
  const teams = task.meeting.teams.map((id) => store.getTeam(db, id)).filter((team): team is Team => team !== undefined);
  const followUps: Proposals['followUps'] = [];
  for (const wanted of report.followUps ?? []) {
    const team = teams.find((one) => one.id === wanted.team.trim() || one.name.toLowerCase() === wanted.team.trim().toLowerCase());
    if (!team) return { refused: `A follow-up's team must be one of the meeting's: ${names(teams)}. "${wanted.team}" is not. Report again.` };
    followUps.push({ teamId: team.id, title: wanted.title.trim(), brief: wanted.brief.trim(), doneCondition: wanted.doneCondition.trim() });
  }
  return { proposals: { decisions: (report.decisions ?? []).map((one) => ({ statement: one.statement.trim(), why: one.why.trim() })), followUps } };
}

/** The proposals that stand: those of the author's last report that gave any. */
export function proposalsStanding(db: Db, meeting: Task): Proposals {
  return store.runsOf(db, meeting.id).findLast((run) => run.mode !== 'review' && run.proposals)?.proposals ?? { decisions: [], followUps: [] };
}

/** The teams still to review the design, in the meeting's order: a removed team, a fired lead and the author's own are passed over. */
export function nextReviewer(db: Db, meeting: Task): { team: Team; lead: Employee } | null {
  const m = meeting.meeting!;
  const authorLead = store.getTeam(db, meeting.teamId)?.leadId ?? null;
  for (const teamId of m.teams) {
    if (teamId === meeting.teamId || m.approvedBy.includes(teamId)) continue;
    const team = store.getTeam(db, teamId);
    const lead = team && !team.removed && team.leadId && team.leadId !== authorLead ? store.getEmployee(db, team.leadId) : undefined;
    if (team && lead && !lead.fired) return { team, lead };
  }
  return null;
}

/** What a reviewing lead is told about the meeting, above the usual review: the question, its own position, what is proposed. */
export function reviewMaterial(db: Db, meeting: Task, team: Team): ReviewMeeting {
  const m = meeting.meeting!;
  const proposals = proposalsStanding(db, meeting);
  const approvedBy = m.approvedBy.map((id) => store.getTeam(db, id)?.name).filter((name): name is string => Boolean(name));
  return {
    topic: m.topic,
    question: m.question,
    team: team.name,
    position: positionsOf(db, meeting).find((entry) => entry.team.id === team.id)?.position ?? null,
    decisions: proposals.decisions,
    followUps: proposals.followUps.map((one) => ({ team: store.getTeam(db, one.teamId)?.name ?? one.teamId, title: one.title, doneCondition: one.doneCondition })),
    approvedBy,
  };
}
export type ReviewMeeting = { topic: string; question: string; team: string; position: string | null; decisions: Proposals['decisions']; followUps: { team: string; title: string; doneCondition: string }[]; approvedBy: string[] };

/** Approved for one team: the first still to approve whose lead gave this review. */
export function withApproval(db: Db, meeting: Task, reviewerId: string): Task {
  const m = meeting.meeting!;
  const team = m.teams.find((id) => id !== meeting.teamId && !m.approvedBy.includes(id) && store.getTeam(db, id)?.leadId === reviewerId) ?? nextReviewer(db, meeting)?.team.id;
  return team ? { ...meeting, meeting: { ...m, approvedBy: [...m.approvedBy, team] } } : meeting;
}

/** Whether every team that could review the design approved it. */
function agreed(db: Db, meeting: Task): boolean {
  return nextReviewer(db, meeting) === null && meeting.meeting!.approvedBy.length > 0;
}

/**
 * The design is settled: its decisions go on record, by the author's lead, and each follow-up becomes a ticket on its
 * team, built on them. The chief of staff tells the user in one message. All in one change.
 */
export function settleMeeting(tx: Tx, db: Db, now: Date, meeting: Task): void {
  const m: Meeting = meeting.meeting!;
  const proposals = proposalsStanding(db, meeting);
  const authorRun = store.runsOf(db, meeting.id).findLast((run) => run.mode !== 'review' && run.proposals);
  const writer = authorRun?.employeeId ?? store.getTeam(db, meeting.teamId)?.leadId ?? null;
  const entries = proposals.decisions.map((one) => recordDecision(tx, db, now, { statement: one.statement, why: one.why, by: { kind: 'lead', employeeId: writer }, taskId: meeting.id, repoId: meeting.repoId }));
  const ids = entries.map((entry) => entry.id);
  const made: string[] = [];
  const left: string[] = [];
  for (const [index, wanted] of proposals.followUps.entries()) {
    const team = store.getTeam(db, wanted.teamId);
    if (!team || team.removed) {
      left.push(`"${wanted.title}" (its team was removed)`);
      continue;
    }
    const at = new Date(now.getTime() + index + 1);
    const repoId = team.repos.find((entry) => entry.repoId === meeting.repoId)?.repoId ?? team.repos[0]?.repoId ?? null;
    const builtOn = builtOnFor(db, { decisions: ids, repoId });
    const ticket = store.newTask(
      {
        teamId: team.id,
        createdBy: writer ?? m.calledBy,
        title: wanted.title,
        brief: `${wanted.brief}\n\nThis comes from the design meeting on "${m.topic}"${ids.length > 0 ? `, which decided ${listed(ids)}` : ''}${meeting.contractVersion ? ` and set the contract at ${meeting.contractVersion}` : ''}. Build on that; if something in it turns out wrong, say so in your report rather than work around it.`,
        doneCondition: wanted.doneCondition,
        repoId,
        capUsd: 5,
        ...(builtOn ? { builtOn } : {}),
      },
      at,
    );
    tx.emit({ kind: 'task_changed', task: ticket, cause: 'created' });
    const who = requestFor(ticket, team);
    if ('problem' in who) decisions.raise(tx, db, now, { taskId: ticket.id, kind: 'staffing', text: decisions.staffingText(ticket, who.problem), options: decisions.optionsFor('staffing') });
    else tx.emit({ kind: 'run_requested', request: store.newRequest({ taskId: ticket.id, ...who, reason: 'new' }, at) });
    made.push(`${team.name} "${wanted.title}"`);
  }
  const chiefId = store.getCompany(db)?.chiefOfStaffId;
  const chief = chiefId ? store.getEmployee(db, chiefId) : undefined;
  if (!chief || chief.fired) return;
  const sentence = (text: string) => text.trim().replace(/[.\s]+$/, '');
  // Who accepted it as it is, when the leads did not all agree, and why: the card's answer says.
  const accepted = store.allDecisions(db).findLast((card) => card.taskId === meeting.id && card.kind === 'review' && card.answer?.optionId === 'accept');
  const acceptedBy = accepted?.answer?.by ? (store.getEmployee(db, accepted.answer.by)?.name ?? 'the chief of staff') : 'you';
  const how = agreed(db, meeting)
    ? `Design agreed: ${m.topic}.`
    : accepted
      ? `Design settled: ${m.topic}. The leads did not all agree, and ${acceptedBy} accepted it as it is${accepted.answer?.why ? `: ${sentence(accepted.answer.why)}` : ''}.`
      : `Design settled: ${m.topic}, with no other lead left to review it.`;
  const text = [
    how,
    entries.length > 0 ? `Decided ${entries.map((entry) => `${entry.id}: ${sentence(entry.statement)}`).join('; ')}.` : 'Nothing was put on record.',
    meeting.contractVersion ? `Contract ${meeting.contractVersion}.` : '',
    made.length > 0 ? `Tickets: ${made.join(', ')}.` : 'No tickets.',
    left.length > 0 ? `Not made: ${left.join(', ')}.` : '',
  ]
    .filter(Boolean)
    .join(' ');
  const at = now.toISOString();
  tx.emit({ kind: 'message_sent', message: { id: store.newId(), fromId: chief.id, toId: 'user', taskId: meeting.id, text, state: 'delivered', at, deliveredAt: at } });
}

/** What the one who called the meeting is told. */
export function meetingReply(plan: MeetingPlan, meeting: Task): ToolReply {
  const others = plan.teams.slice(1).map((team) => team.name);
  return { ok: true, text: `Called: "${meeting.meeting!.topic}", with ${listed(plan.teams.map((team) => team.name))}. Each lead writes its team's position alone; then ${plan.author.name}'s lead drafts the design and ${listed(others)} review it. Its decisions go on record when it is agreed. You do not wait for it: carry on with what does not depend on it.` };
}
