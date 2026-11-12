/**
 * How work moves through a team: a lead briefs, members work, the engine commits and runs the
 * gates, a reviewer who is not the author approves or sends back, the lead integrates, and the
 * result lands where the team may merge, or becomes a decision. Each step that needs a run is a
 * request for the scheduler; each step the engine does itself (git, gates) happens here.
 */
import fs from 'node:fs';
import path from 'node:path';
import { apply, type Tx } from '../db/apply.ts';
import type { Paths } from '../db/dataDir.ts';
import type { Db } from '../db/open.ts';
import * as store from '../db/store.ts';
import { changedFiles, commitAll, diffStat, discardChanges, NestedRepoError, patch } from '../git/commit.ts';
import { branchName, createFolder, publish, removeFolder } from '../git/folder.ts';
import type { GateLimits, GateQueue } from '../git/gates.ts';
import { must, type Identity } from '../git/git.ts';
import { isMerged, landOn, mergeInto } from '../git/merge.ts';
import { outside } from '../git/ownership.ts';
import type { ToolReply } from '../runtime/tools.ts';
import type { Decision, Employee, Finding, Gate, GateResult, Repo, Run, RunOutcome, RunRequest, Task, Team, TeamRepo } from '../shared/types.ts';
import { countsCost } from '../shared/view.ts';
import { TOOL_INPUT } from '../worker/protocol.ts';
import { validateProposal } from './briefing.ts';
import { builtOnFor } from './record.ts';
import * as decisions from './decisions.ts';
import { writtenFiles } from '../api/files.ts';
import { buildDecidingTurn, buildFirstTurn, findingLines, type Part } from './definition.ts';
import { reviewerFor } from './scheduler.ts';
import { canTransition } from './taskState.ts';

const ENGINE: Identity = { name: 'Virtual Startup', email: 'engine@virtual-startup.invalid' };
const PATCH_CAP = 20_000;
/** The chief of staff decides from the card and the reports; the patch is there to check them against, not to review again. */
const DECIDING_PATCH_CAP = 12_000;
const authored = (run: Run): boolean => run.mode === 'work' || run.mode === 'brief' || run.mode === 'integrate';

export type FlowHost = {
  db: Db;
  paths: Paths;
  now(): Date;
  gates: GateQueue;
  /** What a gate may touch when it runs in this folder for this team: the same as the team's own commands. */
  gateLimits(folder: string, team: Team): GateLimits;
  /** How often a run that is waiting for a gate says so. */
  gateHeartbeatMs?: number;
  /** Runs a piece of engine work for a task; while it runs the task is not idle. */
  engineWork(taskId: string, work: () => Promise<void>): void;
  /** How a live run will be recorded when its worker exits. */
  /** `record` is kept with the run when it ends: a review's findings. */
  planRunEnd(runId: string, outcome: RunOutcome, reason: string, record?: Partial<Run>): void;
};

/** A review's verdict as it is written on its run. */
const VERDICT = { approve: 'approved', send_back: 'sent_back', escalate: 'escalated' } as const;

export class Flow {
  private readonly refusedProposals = new Map<string, number>();
  /** Verdicts given by review runs that have not ended yet. An ended run carries its verdict as its reason. */
  private readonly verdicts = new Map<string, string>();
  /** Questions that are with a lead, by task: the words and the offered answers, for the card if the lead passes it on. */
  private readonly questions = new Map<string, { question: string; choices: string[] }>();

  constructor(private readonly host: FlowHost) {}

  private get db(): Db {
    return this.host.db;
  }

  private change(write: (tx: Tx, now: Date) => void): void {
    const now = this.host.now();
    apply(this.db, (tx) => write(tx, now), now);
  }

  private site(task: Task): { repo: Repo; teamRepo: TeamRepo; team: Team; folder: string } | null {
    const team = store.getTeam(this.db, task.teamId);
    const repo = task.repoId ? store.getRepo(this.db, task.repoId) : undefined;
    const teamRepo = team?.repos.find((r) => r.repoId === task.repoId);
    if (!team || !repo || !teamRepo) return null;
    return { repo, teamRepo, team, folder: task.folder ?? path.join(this.host.paths.folders, task.id) };
  }

  /** What a task's branch is measured against: its parent's branch, or the team's base. */
  private baseOf(task: Task, teamRepo: TeamRepo): string {
    const parent = task.parentId ? store.getTask(this.db, task.parentId) : undefined;
    return `origin/${parent?.branch ?? teamRepo.baseBranch}`;
  }

  // ---------- before a run ----------

  /** Makes sure the task has its folder, and for an integration merges the children first. */
  async prepare(task: Task, request: RunRequest): Promise<{ task: Partial<Task>; firstTurn?: string }> {
    if (task.decisionId && !request.firstTurn) return { task: {}, firstTurn: await this.decidingTurn(task) };
    const site = this.site(task);
    if (!site) {
      // No repository, so nothing to merge: an integration is told where each finished part is instead.
      const team = store.getTeam(this.db, task.teamId);
      if (request.mode !== 'integrate' || request.firstTurn || !team) return { task: {} };
      return { task: {}, firstTurn: buildFirstTurn({ task, mode: 'integrate', team, repo: null, teammates: [], remainingUsd: 0, material: { parts: this.partsOf(task) } }) };
    }
    const changes: Partial<Task> = {};
    if (!task.folder || !fs.existsSync(task.folder)) {
      const parent = task.parentId ? store.getTask(this.db, task.parentId) : undefined;
      // A child starts from its parent's branch, so that branch must be in the user's repository first.
      if (parent?.branch && parent.folder && fs.existsSync(parent.folder)) await publish(site.repo.path, parent.folder, parent.branch);
      const dir = path.join(this.host.paths.folders, task.id);
      // A folder nobody recorded is what a start that never finished left there (the engine was stopped in the middle of it). It is made again.
      if (!task.folder && fs.existsSync(dir)) await removeFolder(dir);
      const branch = task.branch ?? branchName(task);
      // A task that was worked before has its branch published: pick up from there.
      await createFolder({ repoPath: site.repo.path, dir, branch, startPoint: task.branch ? branch : (parent?.branch ?? site.teamRepo.baseBranch) }).catch(async (error) => {
        if (!task.branch) throw error;
        await createFolder({ repoPath: site.repo.path, dir, branch, startPoint: parent?.branch ?? site.teamRepo.baseBranch });
      });
      Object.assign(changes, { folder: dir, branch });
      // Where the branch began, for a branch made here and now: what the task changed is measured from it once the branch has been taken in elsewhere.
      if (!task.branch) changes.startedFrom = await must(dir, ['rev-parse', 'HEAD']);
    }
    if (request.mode !== 'integrate' || request.firstTurn) return { task: changes };
    const ready = { ...task, ...changes };
    const mergeState = await this.mergeChildren(ready);
    return { task: changes, firstTurn: buildFirstTurn({ task: ready, mode: 'integrate', team: site.team, repo: site.repo, teammates: [], remainingUsd: 0, material: { mergeState } }) };
  }

  /** What the chief of staff is shown to decide a card for the user: the card, the task it is about, and what stands behind the work. */
  private async decidingTurn(deciding: Task): Promise<string> {
    const card = store.getDecision(this.db, deciding.decisionId!)!;
    const about = card.taskId ? store.getTask(this.db, card.taskId) : undefined;
    const team = about ? store.getTeam(this.db, about.teamId) : undefined;
    const site = about ? this.site(about) : null;
    const last = about ? store.runsOf(this.db, about.id).filter(authored).at(-1) : undefined;
    const has = site && about?.folder && fs.existsSync(about.folder);
    const base = site && about ? this.baseOf(about, site.teamRepo) : null;
    // A folder that cannot be read (never made, or cleared away) is no reason not to decide: the card still says what it says.
    const diff = has && base ? await Promise.all([diffStat(site.folder, base), patch(site.folder, base, DECIDING_PATCH_CAP)]).catch(() => null) : null;
    return buildDecidingTurn({
      card,
      about: about ?? null,
      team: team ?? null,
      repo: site?.repo ?? null,
      folder: about ? (about.folder ?? path.join(this.host.paths.folders, about.id)) : null,
      spentUsd: about && countsCost(store.getCompany(this.db)) ? store.spentOn(this.db, about.id) : null,
      author: last ? { name: store.getEmployee(this.db, last.employeeId)?.name ?? 'An employee', summary: last.summary, gateResults: last.gateResults } : null,
      diffStat: diff?.[0].text ?? null,
      patch: diff?.[1] ?? null,
      open: about ? this.openFindings(about.id) : null,
    });
  }

  /** The finished sub-tasks of a task that has no repository: whose they are, where their files are, what was reported. */
  private partsOf(parent: Task): Part[] {
    const children = store.listTasks(this.db, { parentId: parent.id }).filter((child) => child.state === 'done').sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    return children.map((child) => {
      const folder = child.folder ?? path.join(this.host.paths.folders, child.id);
      const last = store.runsOf(this.db, child.id).filter(authored).at(-1);
      const written = writtenFiles(folder);
      return { title: child.title, by: store.getEmployee(this.db, last?.employeeId ?? child.assigneeId ?? '')?.name ?? 'someone', folder, summary: last?.summary ?? null, files: written.files.map((file) => file.path), more: written.more };
    });
  }

  /** Merges each finished child's branch into the parent's, in creation order, stopping at the first conflict. */
  private async mergeChildren(parent: Task): Promise<string> {
    const children = store.listTasks(this.db, { parentId: parent.id }).filter((c) => c.state === 'done' && c.branch).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    const lines: string[] = [];
    for (const [index, child] of children.entries()) {
      if (await isMerged(parent.folder!, child.branch!)) {
        lines.push(`- "${child.title}": merged.`);
        continue;
      }
      const merged = await mergeInto(parent.folder!, child.branch!, ENGINE);
      if (merged.ok) {
        lines.push(`- "${child.title}": merged.`);
        continue;
      }
      lines.push(`- "${child.title}": CONFLICT in ${merged.conflicts.join(', ')}. The conflict markers are in those files; resolve them.`);
      for (const later of children.slice(index + 1)) lines.push(`- "${later.title}": not merged yet; the engine merges it after this conflict is resolved.`);
      break;
    }
    return lines.join('\n') || '- (no finished sub-tasks)';
  }

  // ---------- the engine's tools ----------

  onProposal(run: Run, input: unknown): ToolReply {
    const { subtasks } = TOOL_INPUT.propose_subtasks.parse(input);
    const parent = store.getTask(this.db, run.taskId)!;
    const team = store.getTeam(this.db, parent.teamId)!;
    const repo = (parent.repoId && store.getRepo(this.db, parent.repoId)) || null;
    const checked = validateProposal({ parent, team, employees: store.allEmployees(this.db), repo, remainingUsd: countsCost(store.getCompany(this.db)) ? parent.capUsd - store.spentOn(this.db, parent.id) : Infinity, subtasks });
    if (!checked.ok) {
      const refusals = (this.refusedProposals.get(run.id) ?? 0) + 1;
      this.refusedProposals.set(run.id, refusals);
      const why = checked.reasons.map((r) => `- ${r.text}`).join('\n');
      if (refusals < 2) return { ok: false, text: `The proposal was refused:\n${why}\nFix these and propose again.` };
      // An invalid briefing is sent back once, then it is the user's to decide.
      const lead = store.getEmployee(this.db, run.employeeId)?.name ?? 'The lead';
      this.change((tx, now) =>
        decisions.raise(tx, this.db, now, { taskId: parent.id, runId: run.id, employeeId: run.employeeId, kind: 'briefing', text: `${lead}'s split of "${parent.title}" was refused twice:\n${why}`, freeText: true, options: decisions.optionsFor('briefing') }),
      );
      this.host.planRunEnd(run.id, 'stopped', 'briefing');
      return { ok: true, text: 'The proposal was refused a second time, so the user has been asked. End your turn now.' };
    }
    // What each part is built on: the decisions the lead named for it, with the whole's own. A number nobody recorded is said now.
    let built: Task['builtOn'][];
    try {
      built = subtasks.map((sub) => builtOnFor(this.db, { decisions: sub.decisions, parent, repoId: parent.repoId }));
    } catch (failure) {
      return { ok: false, text: `${failure instanceof Error ? failure.message : String(failure)} Propose again.` };
    }
    this.change((tx, now) => {
      for (const [index, { decisions: _cited, ...sub }] of subtasks.entries()) {
        // Created a millisecond apart, so that creation order is the order they were proposed in.
        const child = store.newTask({ ...sub, teamId: parent.teamId, parentId: parent.id, repoId: parent.repoId, createdBy: run.employeeId, ...(built[index] ? { builtOn: built[index] } : {}) }, new Date(now.getTime() + index));
        tx.emit({ kind: 'task_changed', task: child, cause: 'created' });
        tx.emit({ kind: 'run_requested', request: store.newRequest({ taskId: child.id, mode: 'work', employeeId: sub.assigneeId, reason: 'new' }, new Date(now.getTime() + index)) });
      }
      decisions.move(tx, store.getTask(this.db, parent.id)!, 'subtasks_created', now);
    });
    return { ok: true, text: `Accepted: ${subtasks.length} sub-task${subtasks.length === 1 ? '' : 's'} created and queued. End your turn now.` };
  }

  /**
   * A member of a led team stopped with a question. Its lead is asked first: most questions are about what a brief
   * means, and the lead wrote it. The user is asked only what the lead says it cannot settle.
   */
  askLead(run: Run, task: Task, lead: Employee, question: string, choices: string[]): void {
    const team = store.getTeam(this.db, task.teamId)!;
    const from = store.getEmployee(this.db, run.employeeId)?.name ?? 'An employee';
    this.questions.set(task.id, { question, choices });
    const firstTurn = buildFirstTurn({ task, mode: 'review', team, repo: this.site(task)?.repo ?? null, teammates: [], remainingUsd: 0, material: { question: { from, text: question, choices } } });
    this.change((tx, now) => tx.emit({ kind: 'run_requested', request: store.newRequest({ taskId: task.id, mode: 'review', employeeId: lead.id, reason: 'review', firstTurn }, now) }));
  }

  /** The run that stopped with a question, when that is the last piece of work on the task: a review run after it is the lead's answer. */
  private asked(taskId: string): Run | undefined {
    const last = store.runsOf(this.db, taskId).filter(authored).at(-1);
    return last?.outcome === 'stopped' && last.reason === 'question' ? last : undefined;
  }

  /** The lead's word on a member's question: an answer, which goes to the member, or that the user must decide. */
  private onAnswer(run: Run, task: Task, asker: Run, verdict: 'approve' | 'send_back' | 'escalate', notes: string): ToolReply {
    if (verdict === 'approve') return { ok: false, text: 'Nothing is finished yet: this run is about a question. Answer it with "send_back" and your answer in the notes, or use "escalate" if only the user can decide.' };
    if (!notes.trim()) return { ok: false, text: verdict === 'send_back' ? 'The notes are your answer, and they are empty. Write the answer there.' : 'The notes are empty. Say there what the user must decide.' };
    const lead = store.getEmployee(this.db, run.employeeId)?.name ?? 'The lead';
    const from = store.getEmployee(this.db, asker.employeeId)?.name ?? 'An employee';
    const kept = this.questions.get(task.id);
    this.questions.delete(task.id);
    this.host.planRunEnd(run.id, 'done', verdict === 'send_back' ? 'answered' : VERDICT.escalate);
    this.change((tx, now) => {
      if (verdict === 'send_back') {
        // The member picks up where it stopped, in the same session, with the lead's words. Not a round of review: no work was judged.
        const firstTurn = `Your lead, ${lead}, answers your question:\n\n${notes.trim()}\n\nCarry on with the task from there.`;
        return void tx.emit({ kind: 'run_requested', request: store.newRequest({ taskId: task.id, mode: asker.mode, employeeId: asker.employeeId, reason: 'resume', resumeSessionId: asker.sessionId, firstTurn }, now) });
      }
      // The card is the member's question, with what the lead said about it. Its answer goes back to the member.
      decisions.raise(tx, this.db, now, {
        taskId: task.id,
        runId: asker.id,
        employeeId: asker.employeeId,
        kind: 'question',
        text: `${from} asks about "${task.title}"${kept ? `: ${kept.question}` : '.'}\n${lead}, who leads the team, could not settle it: ${notes.trim()}`,
        freeText: true,
        options: decisions.optionsFor('question', { choices: kept?.choices ?? [] }),
      });
    });
    return { ok: true, text: verdict === 'send_back' ? `Recorded: ${from} carries on with your answer. End your turn now.` : 'Recorded: the user has been asked. End your turn now.' };
  }

  onReview(run: Run, input: unknown): ToolReply {
    const { verdict, notes, findings = [] } = TOOL_INPUT.submit_review.parse(input);
    const task = store.getTask(this.db, run.taskId)!;
    const asker = this.asked(task.id);
    if (asker) return this.onAnswer(run, task, asker, verdict, notes);
    const reviewer = store.getEmployee(this.db, run.employeeId)?.name ?? 'The reviewer';
    // One review, one verdict: a second call in the same run would send the work back twice, or land it twice.
    if (this.verdicts.has(run.id)) return { ok: false, text: 'You have already given your verdict on this work, and it stands. End your turn now.' };
    // A verdict has to agree with what was found: nothing lands with something blocking in it, and nothing goes back with nothing to fix.
    const blocking = findings.filter((finding) => finding.severity === 'blocking');
    if (verdict === 'approve' && blocking.length > 0) return { ok: false, text: `You approved, and listed ${blocking.length === 1 ? 'a finding' : `${blocking.length} findings`} as blocking. If it must be fixed before this lands, send the work back. If it need not be, mark it minor.` };
    if (verdict === 'send_back' && blocking.length === 0 && findings.length > 0) return { ok: false, text: 'You sent this back with nothing blocking in it. If one of your findings must be fixed before this lands, mark it blocking. If none must, approve.' };
    if (verdict === 'send_back' && findings.length === 0 && !notes.trim()) return { ok: false, text: 'You sent this back without saying what to fix. Give each thing as a finding: its file, what is wrong, why it matters and what would fix it.' };
    // The verdict stays with the run: what a merge card says about the work is read from it, never from the fact that a review happened.
    this.verdicts.set(run.id, VERDICT[verdict]);
    this.host.planRunEnd(run.id, 'done', VERDICT[verdict], { findings });
    if (verdict === 'approve') this.host.engineWork(task.id, () => this.finish(task.id));
    else if (verdict === 'send_back')
      this.sendBack(
        task,
        `Your work was reviewed by ${reviewer} and sent back:\n\n${notes.trim() || '(no notes)'}${
          findings.length > 0 ? `\n\nWhat ${reviewer} found:\n${findingLines(findings)}\n\nWork through them in order. Fix each one; if you are sure one is wrong, leave it and say why. In your report, answer each by its number: what you changed, or why you left it. The next review checks every one.` : ''
        }\n\nFix it, then call mcp__engine__report_done again.`,
        `${reviewer} has sent "${task.title}" back`,
      );
    else
      this.change((tx, now) =>
        decisions.raise(tx, this.db, now, { taskId: task.id, runId: run.id, employeeId: run.employeeId, kind: 'review', text: `${reviewer} could not decide on "${task.title}": ${notes.trim() || '(no notes)'}${findings.length > 0 ? `\n\nWhat ${reviewer} found:\n${findingLines(findings)}` : ''}`, freeText: true, options: decisions.optionsFor('review') }),
      );
    return { ok: true, text: 'Recorded. End your turn now.' };
  }

  async runGateTool(run: Run, input: unknown): Promise<ToolReply> {
    const { name } = TOOL_INPUT.run_gate.parse(input);
    const task = store.getTask(this.db, run.taskId)!;
    const site = this.site(task);
    const gate = site?.repo.gates.find((g) => g.name === name);
    if (!site || !gate) return { ok: false, text: `There is no gate named "${name}" for this task. The gates are: ${site?.repo.gates.map((g) => g.name).join(', ') || 'none'}.` };
    // A gate may take longer than the lease, or wait its turn behind a lock. The run is not silent: it is waiting for the engine, and says so.
    const waiting = () => {
      if (store.getRun(this.db, run.id)?.outcome === 'running') this.change((tx) => tx.emit({ kind: 'run_activity', runId: run.id, taskId: task.id, employeeId: run.employeeId, text: `running the gate "${name}"` }));
    };
    waiting();
    const beat = setInterval(waiting, this.host.gateHeartbeatMs ?? 60_000);
    try {
      const [result] = await this.host.gates.run([gate], site.folder, { limits: this.host.gateLimits(site.folder, site.team) });
      return { ok: true, text: `${name}: ${result!.exitCode === 0 ? 'passed' : 'FAILED'} (exit ${result!.exitCode})\n${result!.output.slice(-3000)}` };
    } finally {
      clearInterval(beat);
    }
  }

  // ---------- after a run ----------

  async onRunDone(run: Run, task: Task): Promise<void> {
    this.refusedProposals.delete(run.id);
    switch (run.mode) {
      case 'route':
        return this.complete(task.id);
      case 'review':
        return; // The verdict was acted on when it was given.
      case 'brief':
        // Split: the children carry it from here. If they are all through already (this brief was a second try), it is time to integrate.
        if (store.listTasks(this.db, { parentId: task.id }).length > 0) return this.checkParent(task.id);
      // Otherwise the lead did the task itself: it is work like any other.
      // falls through
      case 'work': {
        if (this.site(task)) {
          if (!(await this.committed(run, task))) return;
          if (!this.ownershipHolds(run, await this.changed(task), task)) return;
          if (!(await this.gatesPass(run.id, task))) return;
        }
        return this.workAccepted(store.getRun(this.db, run.id)!, store.getTask(this.db, task.id)!);
      }
      case 'integrate': {
        // A team with no repository has nothing to merge: the lead has put the parts together, and that is the task done.
        if (!this.site(task)) return this.finish(task.id);
        if (!(await this.committed(run, task))) return;
        return this.integrated(run, task, true);
      }
    }
  }

  /** The parts are together: every sub-task's branch is in, nothing was changed that the task does not own, and the gates pass. */
  private async integrated(run: Run, task: Task, checkOwnership: boolean): Promise<void> {
    const site = this.site(task)!;
    // A conflict stopped the merging part-way: merge the rest in another integration run.
    for (const child of store.listTasks(this.db, { parentId: task.id }).filter((c) => c.state === 'done' && c.branch)) {
      if (!(await isMerged(site.folder, child.branch!))) return this.change((tx, now) => tx.emit({ kind: 'run_requested', request: store.newRequest({ taskId: task.id, mode: 'integrate', employeeId: run.employeeId, reason: 'integrate' }, now) }));
    }
    // A split is not a way around what the task owns: what the parts changed between them, and what the lead changed putting them together, is held to it.
    if (checkOwnership && !this.ownershipHolds(run, await this.changed(task), task, true)) return;
    if (!(await this.gatesPass(run.id, task))) return;
    // Each part was reviewed on its own; how they were put together was not. That is reviewed too before anything lands.
    return this.workAccepted(store.getRun(this.db, run.id)!, store.getTask(this.db, task.id)!);
  }

  /** Commits the run's work. False when it could not be committed as it is and has gone back to its author. */
  private async committed(run: Run, task: Task): Promise<boolean> {
    try {
      await this.commitWork(run, task);
      return true;
    } catch (error) {
      if (!(error instanceof NestedRepoError)) throw error;
      // A tool made a repository inside the folder (cargo new and git init do). Its author can undo that in one command; nobody else needs to be asked.
      const where = error.dirs.map((dir) => `${dir}/.git`).join(', ');
      this.sendBack(
        task,
        `The engine could not commit your work: ${error.message}. A tool such as cargo new or git init leaves one behind. Remove ${where} (keep the files beside it), then call mcp__engine__report_done again.`,
        `"${task.title}" cannot be committed, because ${error.message}`,
        false,
      );
      return false;
    }
  }

  /** Commits what the run left in the folder, publishes the branch, and records the commit and the size of the diff. */
  private async commitWork(run: Run, task: Task): Promise<void> {
    const site = this.site(task)!;
    const employee = store.getEmployee(this.db, run.employeeId);
    const author: Identity = { name: employee?.name ?? 'Employee', email: `${run.employeeId}@virtual-startup.invalid` };
    const commit = await commitAll(site.folder, author, `${task.title}${run.summary ? `\n\n${run.summary}` : ''}`, task.branch ?? undefined);
    await publish(site.repo.path, site.folder, task.branch!);
    const stat = await diffStat(site.folder, this.baseOf(task, site.teamRepo));
    this.change((tx) => tx.emit({ kind: 'run_ended', run: { ...store.getRun(this.db, run.id)!, commit, diffLines: stat.lines }, teamId: site.team.id }));
  }

  /**
   * The files this task changed. Measured against where it started; and where the team lands on another branch than
   * it starts from, against that one too, because landing merges it in and everything it carries would otherwise
   * count as this task's doing. A file is the task's own change only if it differs both ways.
   */
  private async changed(task: Task): Promise<string[]> {
    const site = this.site(task)!;
    const base = this.baseOf(task, site.teamRepo);
    const files = await changedFiles(site.folder, base);
    const target = task.parentId ? null : site.teamRepo.mergeTarget;
    if (!target || `origin/${target}` === base) return files;
    const overTarget = await changedFiles(site.folder, `origin/${target}`).catch(() => null); // the folder may never have seen that branch
    return overTarget ? files.filter((file) => overTarget.includes(file)) : files;
  }

  /** Ownership is checked after the work as well as before it: a command can change a file no tool call named. */
  private ownershipHolds(run: Run, files: string[], task: Task, whole = false): boolean {
    // What the user has accepted on this task or on one of its parts stays accepted: it is not asked about a second time.
    const mine = new Set([task.id, ...store.listTasks(this.db, { parentId: task.id }).map((child) => child.id)]);
    const accepted = new Set(
      store
        .allDecisions(this.db)
        .filter((card) => card.kind === 'ownership' && card.taskId !== null && mine.has(card.taskId) && card.answer?.optionId === 'accept')
        .flatMap((card) => (Array.isArray(card.subject?.files) ? card.subject.files : [])),
    );
    const strays = outside(files, task.ownership).filter((file) => !accepted.has(file));
    if (strays.length === 0) return true;
    const name = store.getEmployee(this.db, run.employeeId)?.name ?? 'An employee';
    this.change((tx, now) =>
      decisions.raise(tx, this.db, now, {
        taskId: task.id,
        runId: run.id,
        employeeId: run.employeeId,
        kind: 'ownership',
        text: `${whole ? `Put together by ${name}, "${task.title}" changes files outside what it owns` : `${name} changed files outside what "${task.title}" owns`} (${task.ownership.join(', ')}): ${strays.slice(0, 8).join(', ')}${strays.length > 8 ? ` and ${strays.length - 8} more` : ''}.`,
        freeText: true,
        options: decisions.optionsFor('ownership'),
        subject: { files: strays },
      }),
    );
    return false;
  }

  /**
   * The gates a task names, in its own order. A gate it names that its repository no longer has is not passed over:
   * work that was to be checked would land unchecked. It stops here, and the card says which gate is missing.
   */
  private gatesOf(task: Task, repo: Repo): Gate[] {
    const missing = task.gates.filter((name) => !repo.gates.some((gate) => gate.name === name));
    if (missing.length > 0) throw new Error(`the gate ${missing.map((name) => `"${name}"`).join(', ')} that this task names is no longer among the gates of ${repo.path} (${repo.gates.map((gate) => gate.name).join(', ') || 'it has none'}). Put it back under that name, then retry`);
    return repo.gates.filter((gate) => task.gates.includes(gate.name)).sort((a, b) => task.gates.indexOf(a.name) - task.gates.indexOf(b.name));
  }

  /** Runs the task's gates in its folder and stores the real results with the run. A failure sends the work back. */
  private async gatesPass(runId: string, task: Task): Promise<boolean> {
    const site = this.site(task);
    const gates = site ? this.gatesOf(task, site.repo) : [];
    if (!site || gates.length === 0) return true;
    const results = await this.host.gates.run(gates, site.folder, {
      onStart: (gate) => this.change((tx) => tx.emit({ kind: 'gate_started', runId, taskId: task.id, name: gate.name })),
      onFinish: (result) => this.change((tx) => tx.emit({ kind: 'gate_finished', runId, taskId: task.id, result })),
      limits: this.host.gateLimits(site.folder, site.team),
    });
    await discardChanges(site.folder);
    const failed = results.find((r) => r.exitCode !== 0);
    if (!failed) return true;
    const current = store.getTask(this.db, task.id)!;
    // A sub-task's gates are its lead's choice, and a gate may need more than this one part (each half given the test
    // suite of the whole). The author is sent back once, to fix what is its own. If the same gate still fails, another
    // send-back would only repeat it: the lead who chose the gate judges it in review, with the failure in front of it.
    // The gates of the whole task are the user's, and those hold: they are run when the parts are put together.
    if (current.parentId && this.failedLastTime(current.id, runId, failed.name) && this.hasReviewer(current, runId)) return true;
    this.sendBackForGate(current, failed);
    return false;
  }

  /** True when the piece of work before this one, on the same task, failed the same gate. */
  private failedLastTime(taskId: string, runId: string, gate: string): boolean {
    const work = store.runsOf(this.db, taskId).filter(authored);
    // The last time the gates ran: a run in between that ended before they did (a question, a crash, a restart) says nothing about them.
    const before = work.slice(0, Math.max(0, work.findIndex((run) => run.id === runId))).findLast((run) => run.gateResults.length > 0);
    return before?.gateResults.some((result) => result.name === gate && result.exitCode !== 0) ?? false;
  }

  private hasReviewer(task: Task, runId: string): boolean {
    const run = store.getRun(this.db, runId);
    const team = store.getTeam(this.db, task.teamId);
    const reviewerId = run && team ? reviewerFor(task, team, run.employeeId, store.allEmployees(this.db)) : null;
    const reviewer = reviewerId ? store.getEmployee(this.db, reviewerId) : undefined;
    return reviewer !== undefined && !reviewer.fired;
  }

  private sendBackForGate(task: Task, failed: GateResult): void {
    this.sendBack(
      task,
      `The engine ran the gates on your work and "${failed.name}" failed (exit ${failed.exitCode}):\n\`\`\`\n${failed.output.trim().slice(-3000) || '(no output)'}\n\`\`\`\nFix it, then call mcp__engine__report_done again.${
        task.parentId
          ? `\nIf it fails only because of files this sub-task does not own (it owns ${task.ownership.join(', ') || 'everything in its folder'}), do not touch those files and do not ask about it: call mcp__engine__report_done again and say in your summary what the gate needs that is not yours. Your lead decides from there.`
          : ''
      }`,
      `"${task.title}" failed its gate "${failed.name}"`,
    );
  }

  /** Sends work back to its author: the same session resumes with the notes. Bounded: past the team's rounds it is a card. */
  private sendBack(task: Task, firstTurn: string, what: string, acceptable = true): void {
    const team = store.getTeam(this.db, task.teamId)!;
    const author = store.runsOf(this.db, task.id).filter(authored).at(-1);
    const rounds = task.reviewRounds + 1;
    this.change((tx, now) => {
      if (!author || rounds > team.maxReviewRounds) {
        return void decisions.raise(tx, this.db, now, {
          taskId: task.id,
          runId: author?.id ?? null,
          employeeId: author?.employeeId ?? null,
          kind: 'review',
          // Work the engine could not commit is not on the branch: accepting it would land the branch without it and clear the folder away.
          text: `${what}, and it has already been sent back ${task.reviewRounds} time${task.reviewRounds === 1 ? '' : 's'}. ${acceptable ? 'Send it back once more, accept it as it is, or stop?' : 'Send it back once more, or stop? It cannot be accepted as it is: the work is not committed, so accepting would lose it.'}`,
          freeText: true,
          options: decisions.optionsFor(acceptable ? 'review' : 'briefing'),
          // What the author was to be told. "Send back" on this card sends it, whatever words go with the button.
          subject: { firstTurn },
        });
      }
      const counted: Task = { ...task, reviewRounds: rounds };
      if (canTransition(counted, 'sent_back')) decisions.move(tx, counted, 'sent_back', now);
      else tx.emit({ kind: 'task_changed', task: { ...counted, updatedAt: now.toISOString() }, cause: 'edited' });
      tx.emit({ kind: 'run_requested', request: store.newRequest({ taskId: task.id, mode: author.mode === 'integrate' ? 'integrate' : 'work', employeeId: author.employeeId, reason: 'send_back', resumeSessionId: author.sessionId, firstTurn }, now) });
    });
  }

  /** The work is committed, owned and green. Someone other than its author reviews it; if there is nobody, the gates have decided. */
  private async workAccepted(run: Run, task: Task): Promise<void> {
    const team = store.getTeam(this.db, task.teamId)!;
    const reviewerId = reviewerFor(task, team, run.employeeId, store.allEmployees(this.db));
    const reviewer = reviewerId ? store.getEmployee(this.db, reviewerId) : undefined;
    if (!reviewer || reviewer.fired) return this.finish(task.id);
    const site = this.site(task);
    const base = site ? this.baseOf(task, site.teamRepo) : null;
    // What the last review of this work found: this one checks each of those, not only the work as it now is.
    // Only the review just before this one: findings an older review made were settled by the one after it.
    const lastVerdict = store.runsOf(this.db, task.id).findLast((earlier) => earlier.mode === 'review' && (earlier.reason === VERDICT.send_back || earlier.reason === VERDICT.approve));
    const before = lastVerdict?.reason === VERDICT.send_back && (lastVerdict.findings?.length ?? 0) > 0 ? lastVerdict : undefined;
    const parts = store.listTasks(this.db, { parentId: task.id }).filter((child) => child.state === 'done');
    const nameOf = (id: string | null | undefined): string => (id && store.getEmployee(this.db, id)?.name) || 'someone';
    const material = {
      summary: run.summary,
      gateResults: run.gateResults,
      ...(site && base ? { diffStat: (await diffStat(site.folder, base)).text, patch: await patch(site.folder, base, PATCH_CAP) } : {}),
      ...(before ? { previous: { by: nameOf(before.employeeId), findings: before.findings! } } : {}),
      ...(parts.length > 0 ? { whole: { by: nameOf(run.employeeId), parts: parts.map((child) => ({ title: child.title, by: nameOf(store.runsOf(this.db, child.id).findLast(authored)?.employeeId ?? child.assigneeId) })) } } : {}),
    };
    const firstTurn = buildFirstTurn({ task, mode: 'review', team, repo: site?.repo ?? null, teammates: [], remainingUsd: 0, material });
    this.change((tx, now) => {
      const current = store.getTask(this.db, task.id)!;
      if (canTransition(current, 'reported_done')) decisions.move(tx, current, 'reported_done', now);
      tx.emit({ kind: 'run_requested', request: store.newRequest({ taskId: task.id, mode: 'review', employeeId: reviewer.id, reason: 'review', firstTurn }, now) });
    });
  }

  // ---------- finishing ----------

  /** A top-level task with a repository lands before it is done. Everything else is simply done. */
  async finish(taskId: string): Promise<void> {
    const task = store.getTask(this.db, taskId);
    if (!task || task.state === 'done' || task.state === 'failed') return;
    if (this.site(task) && task.parentId === null) return this.land(task);
    return this.complete(taskId);
  }

  /** The verdict of the review that came after a task's last piece of work, and who gave it. Null when there was none. */
  private lastReview(taskId: string): { verdict: string | null; by: string } | null {
    const runs = store.runsOf(this.db, taskId);
    const review = runs.slice(runs.findLastIndex(authored) + 1).findLast((run) => run.mode === 'review');
    if (!review) return null;
    // Its run may still be closing (the approval is what brought us here), so the verdict is not on it yet.
    const verdict = this.verdicts.get(review.id) ?? (review.outcome === 'done' ? review.reason : null);
    return { verdict, by: store.getEmployee(this.db, review.employeeId)?.name ?? 'the reviewer' };
  }

  /** What the last review of this work found and marked blocking, when that review did not approve: these are still open. */
  openFindings(taskId: string): { by: string; findings: Finding[] } | null {
    // The last review that approved or found something. Work done since does not clear what it found: only a review does.
    const review = store.runsOf(this.db, taskId).findLast((run) => run.mode === 'review' && (run.reason === VERDICT.approve || (run.findings?.length ?? 0) > 0));
    const blocking = review && review.reason !== VERDICT.approve ? (review.findings ?? []).filter((finding) => finding.severity === 'blocking') : [];
    return review && blocking.length > 0 ? { by: store.getEmployee(this.db, review.employeeId)?.name ?? 'the reviewer', findings: blocking } : null;
  }

  /** In words for a merge card: who approved this work, or that nobody did. Only an approval counts as one. */
  private standing(task: Task, green: string, gateCount: number): string {
    const parts = store.listTasks(this.db, { parentId: task.id }).filter((child) => child.state === 'done');
    if (parts.length > 0) {
      const approved = parts.filter((child) => this.lastReview(child.id)?.verdict === VERDICT.approve).length;
      const each = approved < parts.length ? `${approved} of its ${parts.length} sub-tasks were approved by a reviewer` : parts.length === 1 ? 'its one sub-task was approved by a reviewer' : `its ${parts.length} sub-tasks were each approved by a reviewer`;
      const whole = this.lastReview(task.id);
      if (whole?.verdict === VERDICT.approve) return `${each} and the whole by ${whole.by}, ${green}`;
      if (whole) return `${each}, ${whole.by} ${whole.verdict === VERDICT.send_back ? 'sent the whole back' : 'could not decide on the whole'} and it was accepted as it is, ${green}`;
      return `${each}, nobody reviewed how they were put together, ${green}`;
    }
    const review = this.lastReview(task.id);
    if (review?.verdict === VERDICT.approve) return `approved by ${review.by}, ${green}`;
    if (review?.verdict === VERDICT.send_back) return `${review.by} sent it back and it was accepted as it is, ${green}`;
    if (review?.verdict === VERDICT.escalate) return `${review.by} could not decide and it was accepted as it is, ${green}`;
    return gateCount === 0 ? 'nobody reviewed it and no gate checked it' : `nobody reviewed it, ${green}`;
  }

  /** A merge card over a branch that changes nothing asks about nothing: it is closed and its task is done. */
  async settleEmptyMerge(card: Decision): Promise<void> {
    const task = card.taskId ? store.getTask(this.db, card.taskId) : undefined;
    if (!task || task.state !== 'blocked' || !this.site(task) || !task.folder || !fs.existsSync(task.folder)) return;
    const changed = await this.changed(task).catch(() => null); // a folder that cannot be read is left for the user
    if (changed === null || changed.length > 0) return;
    this.change((tx, now) => {
      decisions.close(tx, card, now);
      const current = store.getTask(this.db, task.id)!;
      if (canTransition(current, 'unblock')) decisions.move(tx, current, 'unblock', now);
    });
    await this.complete(task.id);
  }

  /** Lands the task's branch on a target, or asks. Without a merge target every merge is the user's decision. */
  async land(task: Task, onto?: string): Promise<void> {
    const site = this.site(task)!;
    // Nothing to land: the task changed no file (a question answered, a look that found nothing to change). It is
    // done, and what was reported is its result. Nobody is asked to merge nothing.
    if ((await this.changed(task)).length === 0) return this.complete(task.id);
    const target = onto ?? site.teamRepo.mergeTarget;
    const lastRun = store.runsOf(this.db, task.id).filter(authored).at(-1);
    const ask = (text: string, to: string) =>
      this.change((tx, now) => decisions.raise(tx, this.db, now, { taskId: task.id, runId: lastRun?.id ?? null, employeeId: lastRun?.employeeId ?? null, kind: 'merge', text, options: decisions.optionsFor('merge'), subject: { target: to } }));
    if (!target) {
      const gates = lastRun?.gateResults ?? [];
      const green = gates.length === 0 ? 'no gates' : gates.every((g) => g.exitCode === 0) ? `gates green (${gates.map((g) => g.name).join(', ')})` : 'gates NOT green';
      // The card says how much stands behind the work, so Merge is never pressed on something nobody looked at without knowing it.
      const checked = this.standing(task, green, gates.length);
      return ask(`Merge "${task.title}" into ${site.teamRepo.baseBranch}? ${checked[0]!.toUpperCase()}${checked.slice(1)}; the diff is ${lastRun?.diffLines ?? 0} lines. Merging there is outside the team's limits.`, site.teamRepo.baseBranch);
    }
    let failedGate: GateResult | undefined;
    const recheck = async () => {
      const results = await this.host.gates.run(this.gatesOf(task, site.repo), site.folder, { limits: this.host.gateLimits(site.folder, site.team) });
      await discardChanges(site.folder);
      failedGate = results.find((r) => r.exitCode !== 0);
      return failedGate === undefined;
    };
    for (let attempt = 0; attempt < 3; attempt++) {
      const landing = await landOn(site.repo.path, site.folder, task.branch!, target, ENGINE, recheck);
      switch (landing.result) {
        case 'landed':
          this.change((tx, now) => tx.emit({ kind: 'task_changed', task: { ...store.getTask(this.db, task.id)!, mergedInto: target, landed: { over: landing.over, tip: landing.tip }, updatedAt: now.toISOString() }, cause: 'edited' }));
          return this.complete(task.id);
        case 'checkout_dirty':
          return ask(`"${task.title}" is ready to merge into ${target}, but your checkout at ${landing.where} has uncommitted changes on that branch, so the engine did not touch it. Merge once it is clean, or keep the branch.`, target);
        case 'gates_failed':
          return this.sendBackForGate(store.getTask(this.db, task.id)!, failedGate!);
        case 'conflict': {
          // The target moved and conflicts with this work. The merge is left in the folder for the author to resolve.
          const firstTurn = buildFirstTurn({ task, mode: 'integrate', team: site.team, repo: site.repo, teammates: [], remainingUsd: 0, material: { mergeState: `- ${target} moved while this task was worked on. The engine merged it into your branch: CONFLICT in ${landing.conflicts.join(', ')}. The conflict markers are in those files; resolve them.` } });
          const who = lastRun?.employeeId ?? site.team.leadId;
          if (!who) return ask(`"${task.title}" conflicts with ${target} in ${landing.conflicts.join(', ')}, and there is nobody to resolve it.`, target);
          return this.change((tx, now) => {
            const current = store.getTask(this.db, task.id)!;
            if (canTransition(current, 'sent_back')) decisions.move(tx, current, 'sent_back', now);
            tx.emit({ kind: 'run_requested', request: store.newRequest({ taskId: task.id, mode: 'integrate', employeeId: who, reason: 'integrate', firstTurn }, now) });
          });
        }
        case 'target_moved':
          continue; // Someone else landed first: take their work in and try again.
      }
    }
    throw new Error(`${target} kept moving while "${task.title}" tried to land on it`);
  }

  /** Marks the task done, clears its folder, and tells its parent. */
  async complete(taskId: string): Promise<void> {
    const task = store.getTask(this.db, taskId);
    if (!task || task.state === 'done' || task.state === 'failed') return;
    const event = canTransition(task, 'approved') ? 'approved' : 'complete';
    if (!canTransition(task, event)) return;
    const site = this.site(task);
    // A repository task's work lives on in its published branch. A task without one keeps its folder: that is its result.
    if (site && task.folder) await removeFolder(task.folder);
    this.change((tx, now) => void decisions.move(tx, store.getTask(this.db, taskId)!, event, now, site ? { folder: null } : {}));
    if (task.parentId) this.checkParent(task.parentId);
  }

  /** When the last child of a task is finished, its lead integrates. If one was stopped, the user decides. */
  checkParent(parentId: string): void {
    const parent = store.getTask(this.db, parentId);
    if (!parent || parent.state !== 'running') return;
    const children = store.listTasks(this.db, { parentId });
    if (children.length === 0 || children.some((c) => c.state !== 'done' && c.state !== 'failed')) return;
    if (store.requestsOf(this.db, parentId).length > 0 || store.liveRuns(this.db).some((r) => r.taskId === parentId)) return;
    const team = store.getTeam(this.db, parent.teamId)!;
    const leadId = team.leadId ?? store.runsOf(this.db, parentId).find((r) => r.mode === 'brief')?.employeeId;
    const failed = children.filter((c) => c.state === 'failed');
    this.change((tx, now) => {
      if (!leadId) return void decisions.raise(tx, this.db, now, { taskId: parentId, kind: 'staffing', text: decisions.staffingText(parent, 'no_lead'), options: decisions.optionsFor('staffing') });
      if (failed.length === 0) return void tx.emit({ kind: 'run_requested', request: store.newRequest({ taskId: parentId, mode: 'integrate', employeeId: leadId, reason: 'integrate' }, now) });
      decisions.raise(tx, this.db, now, {
        taskId: parentId,
        kind: 'question',
        text: `${failed.length} of the ${children.length} sub-tasks of "${parent.title}" did not finish: ${failed.map((c) => `"${c.title}"`).join(', ')}. Integrate what was finished, or stop the whole task?`,
        options: [{ id: 'integrate', label: 'Integrate the rest', effect: 'recheck', params: { mode: 'integrate', employeeId: leadId } }, { id: 'stop', label: 'Stop it', effect: 'stop_task' }],
      });
    });
  }

  // ---------- after the user answers a card ----------

  afterAnswer(answered: decisions.Answered): void {
    const { decision, effect } = answered;
    const task = decision.taskId ? store.getTask(this.db, decision.taskId) : undefined;
    if (!task) return;
    switch (effect) {
      case 'merge':
        return this.host.engineWork(task.id, () => this.land(task, typeof decision.subject?.target === 'string' ? decision.subject.target : undefined));
      case 'complete': // Keep the branch: done, unmerged.
        return this.host.engineWork(task.id, () => this.complete(task.id));
      case 'accept':
        if (decision.kind !== 'ownership') return this.host.engineWork(task.id, () => this.finish(task.id));
        // The stray files are accepted: carry on from where the check stopped.
        return this.host.engineWork(task.id, async () => {
          const run = decision.runId ? store.getRun(this.db, decision.runId) : undefined;
          if (!run) return;
          if (run.mode === 'integrate') return this.integrated(run, task, false);
          if (!(await this.gatesPass(run.id, task))) return;
          return this.workAccepted(store.getRun(this.db, run.id)!, store.getTask(this.db, task.id)!);
        });
      case 'stop_task':
        if (task.parentId) this.checkParent(task.parentId);
        return;
      default:
        return;
    }
  }
}
