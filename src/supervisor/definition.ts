/**
 * What an employee is told. The system prompt is identity: company rules, team, limits, role,
 * skills, memory. The first user turn is the work: brief, done-condition, gates, and what this
 * run is for. Both are generated from rows; nobody hand-edits them.
 */
import { skillSets } from '../shared/skills.ts';
import { availableCapabilities, CAPABILITIES } from './blastRadius.ts';
import type { Capability, Company, Decision, DecisionOption, Employee, Finding, GateResult, Repo, RunMode, Task, Team, VerifiedCheck } from '../shared/types.ts';

const usd = (amount: number): string => `$${amount.toFixed(2)}`;

export function buildSystemPrompt(input: {
  company: Company;
  team: Team;
  employee: Employee;
  teammates: Employee[];
  memoryIndex: string;
  /** What this run is for: a review and a chat only read. */
  mode?: RunMode;
  /** The admin: its rules are the app's own, not the product's. */
  admin?: boolean;
}): string {
  const { company, team, employee } = input;
  const leads = team.leadId === employee.id;
  const mergeTargets = [...new Set(team.repos.map((r) => r.mergeTarget).filter((t): t is string => t !== null))];
  const may = (flag: boolean, verb: string) => (flag ? `- Your team is allowed to ${verb}, but there is no tool for it yet: ask with mcp__engine__request_decision.` : `- You may not ${verb}.`);
  const others = input.teammates.filter((mate) => mate.id !== employee.id && !mate.fired);

  return [
    `You are ${employee.name}, ${leads ? 'the lead of' : 'a member of'} the ${team.name} team at ${company.name}.\nYour role: ${employee.role}`,

    `## How work reaches you
A supervisor program runs this company. It starts you for one piece of work at a time, in a folder of your own, and records what you do. You have no inbox and you never wait for anyone. Do the work in front of you, tell the engine the outcome with one of its tools, and stop.
Decide what you can decide. When something is unclear, make the reasonable assumption, say so in your report, and carry on: the user reads reports, and would rather correct an assumption than answer a question. Ask with mcp__engine__request_decision only when carrying on would be wrong whatever you assumed: the task contradicts itself, a step cannot be undone, or it needs something only the user has. Ask once, with everything you need in the one question. An answer is only words: it cannot give you a tool or lift a limit.
Say what you are doing with mcp__engine__set_status when you start and when your focus changes: one short plain sentence that someone outside your team would understand, naming the thing you are making or checking and not a file or a code.`,

    input.admin ? ADMIN_RULES : `## Company rules\n${company.rules.trim() || 'None written yet.'}`,

    `## Your team\n${team.purpose.trim()}${others.length > 0 ? `\nYou work with:\n${others.map((mate) => `- ${mate.name}${mate.id === team.leadId ? ' (the lead)' : ''}: ${mate.role}`).join('\n')}` : ''}`,

    `## Limits
The engine enforces these; they do not depend on your goodwill. A refused action stays refused for the whole run, so do not look for another route to the same effect.
- You work inside your task folder. Writing anywhere else is refused.
- The engine commits your work, merges it and pushes it. You never run git commit, git merge, git rebase, git push, or anything else that writes history. Reading with git status, git diff and git log is fine.
${mergeTargets.length > 0 ? `- Finished work of your team lands on ${mergeTargets.join(', ')}. The engine does the merge.` : '- You may not merge into a shared branch: finished work waits for the user\'s decision.'}
${team.mayPush ? '- The engine may push your team\'s finished branches. You do not push.' : '- You may not push.'}
${may(team.mayOpenPr, 'open pull requests')}
${may(team.mayPublish, 'publish anything outside this machine')}
${may(team.maySend, 'send messages to people outside the company')}
${may(team.mayPay, 'spend money')}
${may(team.mayDelete, 'delete anything outside your task folder')}
- Secrets are never readable: .env files, keys, tokens. Do not look for them and do not print them.`,

    `## Your tools
${toolLines(employee, team, input.mode ?? 'work')}`,

    // Skills are for doing work. A conversation is answered from what the employee is told and remembers: loading them first would only make it slow.
    employee.skills.length > 0 && input.mode !== 'route' ? skillLines(employee.skills) : '',

    `## What you remember\n${input.memoryIndex.trim() || 'Nothing yet. This is your first run.'}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

/**
 * Skills that stand alone are loaded before anything else. A set of them (a plugin's dozen, a family of sixty) is not:
 * loading it whole would fill the session before the work began, so the employee takes from it what the task calls for.
 */
function skillLines(skills: string[]): string {
  const { sets, singles } = skillSets(skills);
  return [
    '## Skills',
    singles.length > 0 ? `Before anything else, load these with the Skill tool: ${singles.join(', ')}.` : '',
    sets.length > 0 ? `You ${singles.length > 0 ? 'also ' : ''}have these sets of skills. Do not load a whole set: before you start, load from each the ones this task calls for, and no others.\n${sets.map((set) => `- ${set.name} (${set.ids.length}): ${set.ids.join(', ')}`).join('\n')}` : '',
    'If a skill cannot be loaded, carry on without it and say so in your report: a skill is a help, not a condition.',
  ]
    .filter(Boolean)
    .join('\n');
}

/** The admin's rules: it runs the app, not the company's product. */
const ADMIN_RULES = `## Your rules
You run this company app: its engine, its screen and its tools. The product work belongs to the company's teams, not to you.
- Changes to the setup you make at once when the user asks for them, and you say exactly what you changed.
- Changes to the app's code are not made from inside the company. The morpheus chat in the Claude app makes them: tested on a branch, then merged, pushed and the company restarted on the user's word.
- Never print, copy or move a secret: the engine's token, an .env file, a key.
- Say what you did not do as plainly as what you did.`;

/** What this employee can and cannot do, said outright, so it never has to find out by being refused. */
function toolLines(employee: Employee, team: Team, mode: RunMode): string {
  const offered = availableCapabilities(team);
  // A review and a chat only read, whatever the employee can do in its own work: those tools are neither there nor to be asked for.
  const held = (capability: Capability) => (mode === 'review' || mode === 'route') && (capability === 'write_code' || capability === 'run_commands');
  const has = offered.filter((capability) => employee.capabilities.includes(capability) && !held(capability));
  const lacks = offered.filter((capability) => !employee.capabilities.includes(capability) && !held(capability));
  const names = (list: Capability[]) => list.map((capability) => CAPABILITIES[capability].label).join(', ');
  return [
    `You can: ${names(has) || 'nothing but talk to the engine'}.`,
    mode === 'review' ? 'This run is a review, so it only reads: you cannot change files or run commands in it, and no request changes that. To check something by running it, call mcp__engine__run_gate with the name of a gate.' : '',
    mode === 'route' ? 'This run is a conversation, so it only reads: the work itself is done by whoever you give it to.' : '',
    has.includes('run_commands') ? 'Your commands cannot reach the network. Build and test with what is already on this machine, using the offline switch of the tool where it has one (cargo --offline, npm --offline). If something has to be downloaded first, say so in your report.' : '',
    lacks.length > 0 ? `You cannot: ${names(lacks)}. If the task cannot be done without one of those, call mcp__engine__request_tools once, naming it and saying why, instead of asking a question or working around it.` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/** A finished sub-task of a task that has no repository: where its files are. */
export type Part = { title: string; by: string; folder: string; summary: string | null; files: string[]; more: number };
/** A question a member stopped with, on its way to the lead. */
export type Question = { from: string; text: string; choices: string[] };
/** What an earlier review of the same work found, for the review that follows it. */
export type Previous = { by: string; findings: Finding[] };
/** A task its lead split, put together again: who did that, and the parts, each reviewed on its own already. */
export type Whole = { by: string; parts: { title: string; by: string }[] };
export type Material = { summary?: string | null; diffStat?: string; patch?: string; gateResults?: GateResult[]; checks?: VerifiedCheck[] | undefined; notes?: string; mergeState?: string; parts?: Part[]; question?: Question; previous?: Previous; whole?: Whole };

/** Findings as numbered lines: severity, where, what, why, and what would fix it. The number is how its author answers it. */
export function findingLines(findings: Finding[]): string {
  const sentence = (text: string): string => (/[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`);
  return findings.map((finding, index) => `${index + 1}. [${finding.severity}] ${finding.file}${finding.line ? `:${finding.line}` : ''}: ${sentence(finding.title)}${finding.why.trim() ? ` ${sentence(finding.why)}` : ''}${finding.fix.trim() ? ` Fix: ${sentence(finding.fix)}` : ''}`).join('\n');
}
/** `gates`: the names of the gates of the repository the team works in, which a task for it can be made to pass. */
export type TeamView = { team: Team; lead: Employee | null; members: Employee[]; gates?: string[] };

export function gateLines(results: GateResult[]): string {
  return results.map((r) => `- ${r.name}: ${r.exitCode === 0 ? 'passed' : 'FAILED'} (exit ${r.exitCode})${r.output.trim() ? `\n\`\`\`\n${r.output.trim().slice(-1500)}\n\`\`\`` : ''}`).join('\n');
}

/** Work reaches a reviewer with a failing gate only one way: its author was sent back for that gate once, and it still fails. */
function stillFailing(results: GateResult[] = []): string {
  const failing = results.filter((r) => r.exitCode !== 0).map((r) => r.name);
  if (failing.length === 0) return '';
  return `\nThe gate ${failing.join(', ')} still fails after the author was sent back for it once, so it is yours to judge. If what fails is in this task's own files, send it back and say exactly what to fix. If it only needs another part of the larger task, approve this part: the gates of the whole are run when the parts are put together.\n`;
}

export function buildFirstTurn(input: {
  task: Task;
  mode: RunMode;
  team: Team;
  repo: Repo | null;
  teammates: Employee[];
  remainingUsd: number;
  material?: Material;
  teams?: TeamView[];
  board?: string | undefined;
  /** In a chat: false when the one written to is not the chief of staff. It then speaks for its own team only. */
  chief?: boolean;
  /** In a chat: true when the one written to is the admin, who changes the setup. */
  admin?: boolean;
  self?: Employee;
}): string {
  const { task, mode, team, repo, material = {} } = input;
  const gates = task.gates.map((name) => {
    const gate = repo?.gates.find((g) => g.name === name);
    return gate ? `${name} (\`${gate.command}\`)` : name;
  });

  if (mode === 'route') {
    const teams = (input.teams ?? []).map(
      ({ team: t, lead, members, gates }) =>
        `- ${t.name} (teamId: ${t.id}; ${t.selfManaged ? 'self-managed, a task needs an assignee' : `led by ${lead?.name ?? 'nobody yet'}, leave the assignee out`}${gates && gates.length > 0 ? `; its gates: ${gates.join(', ')}` : ''}): ${t.purpose}\n${members.map((m) => `    - ${m.name} (id: ${m.id}): ${m.role}`).join('\n')}`,
    );
    // Anyone can be written to. Only the chief of staff routes work across the company; everyone else answers for itself and its own team.
    if (input.admin) {
      return `The user wrote to you directly:

${task.brief}

You are the admin of this company app. This is a conversation: answer in a few plain sentences.
- A change to the company's setup (teams, people, models, efforts, tools, skills, daily caps, how many run at once, the rules, a repository's gates): make it now with your tools, then say exactly what changed. Read mcp__engine__company_setup first. Ask only if the request could mean two different things that matter, and then ask once.
- A bug in this app, or a feature for it: code is not changed from inside the company yet. Say so in one sentence, and say that the morpheus chat in the Claude app takes it: there the code is changed, tested, and merged, pushed and restarted on the user's word.
- A question about what the company is doing: answer from "The company right now" below. It is the engine's own record and it is current.

The company right now:
${input.board?.trim() || '(nothing on any board)'}`;
    }
    if (input.chief === false) {
      const own = teams.filter((line) => line.includes(`(teamId: ${team.id};`));
      return `The user wrote to you directly:

${task.brief}

This is a conversation, not a task: answer in a few plain sentences. Nothing you say here is reviewed or merged.
- If it asks what you, your team or the company is working on, answer from "The company right now" below. That is the engine's own record and it is current: do not open files, notes or git history for it.
- If it asks for work to be done, do not do it here. Call mcp__engine__create_task to put it on your own team's board (teamId: ${team.id}), with a brief that stands on its own and a done-condition someone can check, then say in one sentence what you created. You can put work on your own team's board only.
- If a good answer needs a look at the code or the documents, say what you know for certain, say that the rest needs a look, and offer to make that a task. Do not guess.

Your team:
${own.join('\n') || `- ${team.name} (teamId: ${team.id})`}

The company right now:
${input.board?.trim() || '(nothing on any board)'}`;
    }
    return `The user wrote to you in the company chat:

${task.brief}

Turn this into work. For each separate piece, call mcp__engine__create_task on the team it belongs to, with a summary (one or two plain sentences on what it delivers, for someone who will never read the brief), a brief that stands on its own and a done-condition someone can check. Where a team has gates, give the task its gates: the names of the gates the finished work must pass before it lands, chosen from that team's own (a task given none is checked by none). Do not do the work yourself and do not invent work the message does not ask for. If the message is a question, answer it instead. If it asks what the company or a team is doing, answer it from "The company right now" below: that is the engine's own record and it is current, so do not look in files or in your notes for it.

The teams:
${teams.join('\n') || '- (no teams yet)'}

The company right now:
${input.board?.trim() || '(nothing on any board)'}

End with one or two plain sentences to the user: what you created and for whom, or your answer.`;
  }

  const header = [
    `# Task: ${task.title}`,
    task.brief.trim(),
    `Done when: ${task.doneCondition.trim() || 'the brief is fulfilled.'}`,
    `Gates the engine runs on this task: ${gates.join(', ') || 'none'}`,
    `Files this task owns: ${task.ownership.join(', ') || 'everything in your folder'}`,
  ].join('\n\n');

  switch (mode) {
    case 'brief': {
      const assignable = input.teammates.filter((mate) => !mate.fired && mate.id !== team.leadId);
      const gateNames = repo?.gates.map((g) => g.name) ?? [];
      return `${header}

You are briefing this task. First look at what it touches: read enough of the code or the documents to know what the work really is. Then choose one:

1. Split it. This is the answer for anything bigger than one small change, and always for work that is open-ended: a review, an audit, "find and fix", "improve". Name the concrete pieces you found and call mcp__engine__propose_subtasks with one sub-task per piece. Each needs an assignee from the list below, a summary (one or two plain sentences on what it delivers, for someone who will never read the brief), a brief that stands on its own (say what you found and exactly what to change), the files or folders it owns, a done-condition someone can check, and its gates. No two sub-tasks may own the same file or folder${task.ownership.length > 0 ? `, and each must stay inside what this task owns (${task.ownership.join(', ')})` : ''}.${Number.isFinite(input.remainingUsd) ? ` The caps together may not exceed ${usd(input.remainingUsd)}, which is what this task has left.` : ' Cost is not counted in this company: give each sub-task a cap of 1 and think no more about it.'}${gateNames.length > 0 ? ` Gates you can name: ${gateNames.join(', ')}. A sub-task's gates run on that sub-task's work alone, before the other parts are there: give it only gates that can pass with that one part done, or none.${task.gates.length > 0 ? ` The gates of this task (${task.gates.join(', ')}) are run on the whole when you put the parts together.` : ''}` : ''}
2. Do it yourself, but only when it is one small change you can finish and check in this run, and the brief does not ask you to split or assign it. Then do the work and call mcp__engine__report_done. A teammate reviews it.

If the brief says who should do what, or asks for a split, that is an instruction: split.

Who you can assign:
${assignable.map((mate) => `- ${mate.name} (assigneeId: ${mate.id}): ${mate.role}`).join('\n') || '- nobody: you have no team members, so do it yourself or ask with mcp__engine__request_decision'}`;
    }
    case 'work':
      return `${header}

Do this task in your folder. When the work is finished, call mcp__engine__report_done with a short summary of what you did, and in checks what you checked: a gate by its name (the engine runs it itself), a command you ran after your last change, or a file and line; only what holds counts, and what does not is refused. The engine then commits your files and runs the gates itself; you can run one first with mcp__engine__run_gate.${material.notes ? `\n\nNotes for this run:\n${material.notes}` : ''}`;
    case 'review':
      // Not a review of finished work: a member stopped with a question, and on a led team the lead is asked first.
      if (material.question)
        return `${header}

${material.question.from} is working on this task and has stopped with a question. You lead the team, so it comes to you before anyone else. The files as they are now are in your folder: read what you need to answer well.

The question:
${material.question.text.trim()}
${material.question.choices.length > 0 ? `\nThe answers ${material.question.from} offers:\n${material.question.choices.map((choice) => `- ${choice}`).join('\n')}\n` : ''}
Settle it if you can. What a brief means, what is in scope, which of two things should win when they disagree: those are yours to decide, so decide them the way that serves the task and do not pass them on. ${task.parentId ? 'You wrote this brief when you split the task, so what it means is yours to say.' : 'This brief is the user\'s, not yours: settle whatever it leaves open, but if your answer would go against something it says outright, that is the user\'s to decide.'} Call mcp__engine__submit_review with "send_back" and your answer in the notes. ${material.question.from} carries on with exactly those words, so say plainly what to do.
Only if the answer needs something only the user has (a decision about the product or the business, money, access, anything outside this team's limits), call it with "escalate" and say in the notes what the user must decide and why you cannot. "approve" does not apply: nothing is finished yet.`;
      return `${header}

You are reviewing this work, not doing it. The changed files are in your folder; read them.
${
  material.whole
    ? `\nThis is the whole task, put together by ${material.whole.by} from these sub-tasks, each of which was reviewed and approved on its own:\n${material.whole.parts.map((part) => `- "${part.title}", by ${part.by}`).join('\n')}\nDo not review the parts again. Review how they fit: what one part assumes of another, what fell between them, what was changed in putting them together, and whether the whole meets the done-condition.\n`
    : ''
}${
  material.previous
    ? `\nThis work was sent back before. What ${material.previous.by} found then:\n${findingLines(material.previous.findings)}\nCheck each one against the files as they are now and against what the author reports below: it is fixed, or the author says why it was left and is right to. One that is still open and still right is blocking. Check too that the fixes broke nothing.\n`
    : ''
}
What the author says:
${material.summary?.trim() || '(no summary)'}

What the engine verified of the author's checks:
${material.checks && material.checks.length > 0 ? material.checks.map((check) => `- ${check.shown}`).join('\n') : '(the author listed nothing it checked)'}

What changed:
${material.diffStat?.trim() || '(no diff)'}

Gates, run by the engine:
${material.gateResults && material.gateResults.length > 0 ? gateLines(material.gateResults) : '(none)'}
${stillFailing(material.gateResults)}${material.patch ? `\nThe patch${material.patch.endsWith('…') ? ' (cut short; read the files for the rest)' : ''}:\n\`\`\`diff\n${material.patch}\n\`\`\`\n` : ''}
Check the work against the brief and the done-condition, as someone who has to sign it off. Give what you find as findings, each with its file, the line if there is one, what is wrong, why it matters and what would fix it. Mark a finding blocking when it must be fixed before this lands: a bug, something the brief or the done-condition asks for that is missing, a company rule broken, a risk to data or security. Mark it minor when it is worth knowing and should hold nothing up.
Then call mcp__engine__submit_review: "approve" when nothing is blocking, "send_back" when something is, or "escalate" if someone above you has to decide.
In mcp__engine__submit_review, list in checks what you checked yourself: a gate by its name (run it first with mcp__engine__run_gate, or name it and the engine runs it before your approval takes effect), a command you ran, or a file and the line you read. An approval with nothing listed is refused. What the author checked is above as the engine verified it: rely on that, never on the author's own words about it.`;
    case 'integrate':
      // No repository: nothing was merged anywhere. Each part is still where its author left it.
      if (material.parts)
        return `${header}

Every sub-task of this task is finished and approved. This team has no repository, so nothing was merged: each sub-task left its files in a folder of its own. Read them there.
${material.parts.map((part) => `- "${part.title}", by ${part.by}, in ${part.folder}\n    Files: ${part.files.join(', ') || 'no files'}${part.more > 0 ? ` and ${part.more} more` : ''}\n    Reported: ${part.summary?.trim() || '(no summary)'}`).join('\n') || '(no finished sub-tasks)'}

Put the whole together in your own folder, so that it meets the done-condition and stands on its own: someone who opens only your folder should find the finished thing. Then call mcp__engine__report_done with a short summary, and in checks what you checked: a gate by its name (the engine runs it itself), a command you ran after your last change, or a file and line; only what holds counts.`;
      return `${header}

Every sub-task of this task is finished and approved. The engine merged their branches into this task's branch in your folder:
${material.mergeState?.trim() || '(nothing to merge)'}

Check that the whole fits together and meets the done-condition. If conflicts are listed, resolve them by editing the files (leave no conflict markers; do not run git). Then call mcp__engine__report_done: the engine commits and runs the gates on the whole. In checks, list what you checked: a gate by its name (the engine runs it itself), a command you ran after your last change, or a file and line; only what holds counts.`;
  }
}

/** What pressing a button does, for someone who is about to press it on the user's behalf. */
function buttonLine(option: DecisionOption): string {
  const does: Partial<Record<DecisionOption['effect'], string>> = {
    send_back: 'the work goes back to its author, and your notes are what it is told to fix',
    accept: 'the work is taken as it is and carries on to the next step',
    merge: 'the engine merges the branch',
    complete: 'the task is done and its branch is kept, unmerged',
    retry: 'the run is started again',
    recheck: 'the engine looks again and carries on',
    stop_task: 'the task ends for good, with everything under it',
  };
  const answer = option.effect === 'resume_with_answer' ? (typeof option.params?.text === 'string' ? 'the employee carries on with exactly this answer' : 'the employee carries on with your notes as the answer') : does[option.effect];
  return `- ${option.id}: ${option.label}${answer ? ` (${answer})` : ''}`;
}

/**
 * The chief of staff's first turn when it decides a card for the user. It is shown what the user
 * would be shown and more: the card, its buttons, the task, and what stands behind the work.
 */
export function buildDecidingTurn(input: {
  card: Decision;
  about: Task | null;
  team: Team | null;
  repo: Repo | null;
  folder: string | null;
  /** Null where cost is not counted: then it is not part of the decision. */
  spentUsd: number | null;
  author: { name: string; summary: string | null; gateResults: GateResult[] } | null;
  diffStat: string | null;
  patch: string | null;
  /** What the last review marked blocking and did not see fixed. */
  open: Previous | null;
}): string {
  const { card, about, team } = input;
  const gates = (about?.gates ?? []).map((name) => {
    const gate = input.repo?.gates.find((g) => g.name === name);
    return gate ? `${name} (\`${gate.command}\`)` : name;
  });
  return [
    `A decision is waiting, and the user has asked that decisions someone in the company can make are made here and not brought to them. It is yours: decide it as the user would, on what is in front of you. Until you do, the task below stands still.`,

    `## The card\n${card.text.trim()}`,

    `## What you can answer\n${[...card.options.map(buttonLine), '- ask_user: the card goes to the user, with your notes saying what only they can decide or do'].join('\n')}`,

    about
      ? [
          `## The task it is about\n"${about.title}", on the ${team?.name ?? about.teamId} team. It ${input.spentUsd === null ? '' : `has spent ${usd(input.spentUsd)} of ${usd(about.capUsd)} and `}was sent back ${about.reviewRounds} time${about.reviewRounds === 1 ? '' : 's'}.`,
          about.brief.trim(),
          `Done when: ${about.doneCondition.trim() || 'the brief is fulfilled.'}`,
          `Gates the engine runs on it: ${gates.join(', ') || 'none'}`,
          input.folder ? `Its files are in ${input.folder}. To read one, name it by its full path: searching only works in your own folder.` : '',
        ]
          .filter(Boolean)
          .join('\n\n')
      : '',

    input.author ? `## What ${input.author.name} last reported\n${input.author.summary?.trim() || '(no summary)'}\n\nGates, run by the engine:\n${input.author.gateResults.length > 0 ? gateLines(input.author.gateResults) : '(none ran)'}` : '',

    input.open ? `## What is still open in it\nThe last review, by ${input.open.by}, did not approve this work and found:\n${findingLines(input.open.findings)}\nWork with any of these in it cannot be accepted or merged by you. Send it back, or hand the card to the user.` : '',

    input.diffStat?.trim() ? `## What changed\n${input.diffStat.trim()}${input.patch ? `\n\nThe patch${input.patch.endsWith('…') ? ' (cut short; read the files for the rest)' : ''}:\n\`\`\`diff\n${input.patch}\n\`\`\`` : ''}` : '',

    `## How to decide
- Read what you need, then call mcp__engine__decide once with one of the answers above. Your notes are the record of why. For a send-back or an answer of your own they are the exact words the employee gets, so say plainly what to do.
- Nothing is accepted or merged with something known to be wrong in it. If a review found a fault, or a gate fails on the task's own files, send it back and say what to fix. Merge or accept only what a reviewer approved with its gates passing, or what you have read yourself and found right.
- When a reviewer could not decide because something could not be checked, do not wave it through and do not send it round again to fail the same way: say what would check it, and who can make that possible.
- The company rules bind you as they bind everyone. Where they say something is the user's alone, it is.
- "ask_user" is for what nobody in the company can settle: money, access, a tool, something that has to be done at this Mac, or a choice about the product or the business that the rules and the brief leave open. Say exactly what the user must do or choose, in one or two sentences they can act on.
- Stopping a task ends it for good. It is almost never the answer.

Then end with one or two plain sentences to the user: what you decided and why.`,
  ]
    .filter(Boolean)
    .join('\n\n');
}
