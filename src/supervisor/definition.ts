/**
 * What an employee is told. The system prompt is identity: company rules, team, limits, role,
 * skills, memory. The first user turn is the work: brief, done-condition, gates, and what this
 * run is for. Both are generated from rows; nobody hand-edits them.
 */
import type { Company, Employee, GateResult, Repo, RunMode, Task, Team } from '../shared/types.ts';

const usd = (amount: number): string => `$${amount.toFixed(2)}`;

export function buildSystemPrompt(input: { company: Company; team: Team; employee: Employee; teammates: Employee[]; memoryIndex: string }): string {
  const { company, team, employee } = input;
  const leads = team.leadId === employee.id;
  const mergeTargets = [...new Set(team.repos.map((r) => r.mergeTarget).filter((t): t is string => t !== null))];
  const may = (flag: boolean, verb: string) => (flag ? `- Your team is allowed to ${verb}, but there is no tool for it yet: ask with mcp__engine__request_decision.` : `- You may not ${verb}.`);
  const others = input.teammates.filter((mate) => mate.id !== employee.id && !mate.fired);

  return [
    `You are ${employee.name}, ${leads ? 'the lead of' : 'a member of'} the ${team.name} team at ${company.name}.\nYour role: ${employee.role}`,

    `## How work reaches you
A supervisor program runs this company. It starts you for one piece of work at a time, in a folder of your own, and records what you do. You have no inbox and you never wait for anyone. Do the work in front of you, tell the engine the outcome with one of its tools, and stop. If you need something you may not decide or do yourself, ask with mcp__engine__request_decision and stop: you will be resumed with the answer.
Say what you are doing with mcp__engine__set_status when you start and when your focus changes, in a few plain words.`,

    `## Company rules\n${company.rules.trim() || 'None written yet.'}`,

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

    employee.skills.length > 0 ? `## Skills\nBefore anything else, load these with the Skill tool: ${employee.skills.join(', ')}.` : '',

    `## What you remember\n${input.memoryIndex.trim() || 'Nothing yet. This is your first run.'}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

export type Material = { summary?: string | null; diffStat?: string; patch?: string; gateResults?: GateResult[]; notes?: string; mergeState?: string };
export type TeamView = { team: Team; lead: Employee | null; members: Employee[] };

export function gateLines(results: GateResult[]): string {
  return results.map((r) => `- ${r.name}: ${r.exitCode === 0 ? 'passed' : 'FAILED'} (exit ${r.exitCode})${r.output.trim() ? `\n\`\`\`\n${r.output.trim().slice(-1500)}\n\`\`\`` : ''}`).join('\n');
}

export function buildFirstTurn(input: { task: Task; mode: RunMode; team: Team; repo: Repo | null; teammates: Employee[]; remainingUsd: number; material?: Material; teams?: TeamView[] }): string {
  const { task, mode, team, repo, material = {} } = input;
  const gates = task.gates.map((name) => {
    const gate = repo?.gates.find((g) => g.name === name);
    return gate ? `${name} (\`${gate.command}\`)` : name;
  });

  if (mode === 'route') {
    const teams = (input.teams ?? []).map(
      ({ team: t, lead, members }) =>
        `- ${t.name} (teamId: ${t.id}; ${t.selfManaged ? 'self-managed, a task needs an assignee' : `led by ${lead?.name ?? 'nobody yet'}, leave the assignee out`}): ${t.purpose}\n${members.map((m) => `    - ${m.name} (id: ${m.id}): ${m.role}`).join('\n')}`,
    );
    return `The user wrote to you in the company chat:

${task.brief}

Turn this into work. For each separate piece, call mcp__engine__create_task on the team it belongs to, with a brief that stands on its own and a done-condition someone can check. Do not do the work yourself and do not invent work the message does not ask for. If the message is a question, answer it instead.

The teams:
${teams.join('\n') || '- (no teams yet)'}

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

You are briefing this task. Choose one:

1. Split it. Call mcp__engine__propose_subtasks with one sub-task per piece of work. Each needs an assignee from the list below, a brief that stands on its own, the files or folders it owns, a done-condition and its gates. No two sub-tasks may own the same file or folder. The caps together may not exceed ${usd(input.remainingUsd)}, which is what this task has left.${gateNames.length > 0 ? ` Gates you can name: ${gateNames.join(', ')}.` : ''}
2. Do it yourself, but only when the brief does not ask you to split or assign it, and it is small enough that splitting would cost more than doing. Then do the work and call mcp__engine__report_done.

If the brief says who should do what, or asks for a split, that is an instruction: split.

Who you can assign:
${assignable.map((mate) => `- ${mate.name} (assigneeId: ${mate.id}): ${mate.role}`).join('\n') || '- nobody: you have no team members, so do it yourself or ask with mcp__engine__request_decision'}`;
    }
    case 'work':
      return `${header}

Do this task in your folder. When the work is finished, call mcp__engine__report_done with a short summary of what you did. The engine then commits your files and runs the gates itself; you can run one first with mcp__engine__run_gate.${material.notes ? `\n\nNotes for this run:\n${material.notes}` : ''}`;
    case 'review':
      return `${header}

You are reviewing this work, not doing it. The changed files are in your folder; read them.

What the author reported:
${material.summary?.trim() || '(no summary)'}

What changed:
${material.diffStat?.trim() || '(no diff)'}

Gates, run by the engine:
${material.gateResults && material.gateResults.length > 0 ? gateLines(material.gateResults) : '(none)'}
${material.patch ? `\nThe patch${material.patch.endsWith('…') ? ' (cut short; read the files for the rest)' : ''}:\n\`\`\`diff\n${material.patch}\n\`\`\`\n` : ''}
Check the work against the brief and the done-condition. Then call mcp__engine__submit_review with "approve", or "send_back" with notes the author can act on, or "escalate" if a person has to decide.`;
    case 'integrate':
      return `${header}

Every sub-task of this task is finished and approved. The engine merged their branches into this task's branch in your folder:
${material.mergeState?.trim() || '(nothing to merge)'}

Check that the whole fits together and meets the done-condition. If conflicts are listed, resolve them by editing the files (leave no conflict markers; do not run git). Then call mcp__engine__report_done: the engine commits and runs the gates on the whole.`;
  }
}
