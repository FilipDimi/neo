/**
 * Claims that carry proof. A report or a review says what was checked; the engine counts only what holds
 * against its own record. A gate is proved by the engine running it. A command, by the run having run it
 * after its last change, and it having succeeded. A file, by being a file of the work with that line in it.
 * Nothing here believes words: the prose is read for one thing only, the name of a gate said to pass.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { EventRow } from '../shared/events.ts';
import type { VerifiedCheck } from '../shared/types.ts';
import type { Check } from '../worker/protocol.ts';

export type Proof = { holds: true } | { holds: false; why: string };

const PASSING = /\b(pass|passed|passes|passing|green|clean|succeed|succeeds|succeeded|success|successful|ok)\b/i;
/** A sentence that says a thing does not pass, or will only later, claims nothing: "fails", "not green", "will pass once…". */
const DOUBT = /\b(not|no|never|cannot|fail|fails|failed|failing|until|once|will|yet)\b|n't\b/i;
/** How far from a gate's name a word that says it passed may be, in characters, either side, inside one sentence. */
const WINDOW = 40;
const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The gates of a repository that a text says passed: a gate's name, as a word of its own (not part of a word or of a
 * path), in a sentence that says it passed and does not doubt it.
 */
export function gatesNamedAsPassing(text: string, gates: string[]): string[] {
  const sentences = text.split(/(?<=[.!?;])\s+|\n+/);
  return gates.filter((gate) => {
    const named = new RegExp(`(?<![\\w./-])${escape(gate)}(?![\\w/-]|\\.\\w)`, 'gi');
    return sentences.some((sentence) => {
      if (DOUBT.test(sentence)) return false;
      for (const found of sentence.matchAll(named)) {
        const near = sentence.slice(Math.max(0, found.index - WINDOW), found.index + gate.length + WINDOW);
        if (PASSING.test(near)) return true;
      }
      return false;
    });
  });
}

const tidy = (command: string): string => command.replace(/\s+/g, ' ').trim();
type Inner = { kind: string; id?: string; tool?: string; input?: unknown; ok?: boolean };
const inner = (row: EventRow): Inner | null => (row.event.kind === 'run_event' ? (row.event.event as Inner) : null);

/** A call that succeeds whatever the command in it does: its success says nothing. */
const HIDES_FAILURE = /\|\|\s*(true|:)\b|;\s*(true|:|exit 0)\s*$|&\s*$|^\s*echo\b/;

/**
 * A command the run ran: the last call that holds it, after the run's last Write or Edit, ran with the Bash tool and
 * did not come back as an error. What is shown is that call as it was made, not the words the claim used.
 */
export function commandProof(rows: EventRow[], command: string): { holds: true; ran: string } | { holds: false; why: string } {
  const wanted = tidy(command);
  if (!wanted) return { holds: false, why: 'a command check names the command it ran' };
  const events = rows.flatMap((row) => inner(row) ?? []);
  const lastChange = events.findLastIndex((event) => event.kind === 'tool_call' && (event.tool === 'Write' || event.tool === 'Edit'));
  const results = new Map(events.filter((event) => event.kind === 'tool_result').map((event) => [event.id, event.ok === true]));
  const commandOf = (event: Inner) => tidy(String((event.input as { command?: unknown } | undefined)?.command ?? ''));
  const last = events.slice(lastChange + 1).findLast((event) => event.kind === 'tool_call' && event.tool === 'Bash' && commandOf(event).includes(wanted));
  if (!last) return { holds: false, why: `this run did not run \`${wanted}\` after its last change` };
  const ran = commandOf(last);
  if (HIDES_FAILURE.test(ran)) return { holds: false, why: `this run ran \`${ran}\`, which succeeds whatever the command does` };
  if (!results.has(last.id)) return { holds: false, why: `this run ran \`${wanted}\` and its result is not in yet` };
  return results.get(last.id) ? { holds: true, ran } : { holds: false, why: `this run ran \`${wanted}\` after its last change, and it failed` };
}

/** A file the work has, and a line in it: inside the work's folder, never outside it. */
export function fileProof(folder: string, file: string, line?: number): Proof {
  const relative = file.trim().replace(/^\.\//, '');
  const target = path.resolve(folder, relative);
  if (path.isAbsolute(relative) || !target.startsWith(`${path.resolve(folder)}${path.sep}`)) return { holds: false, why: `${file.trim()} is not a file of the work: give its path from the top of the work` };
  let stat: fs.Stats;
  try {
    stat = fs.statSync(target);
  } catch {
    return { holds: false, why: `there is no ${relative} in the work` };
  }
  if (stat.isDirectory()) return { holds: false, why: `${relative} is a folder, not a file` };
  if (line !== undefined) {
    const lines = fs.readFileSync(target, 'utf8').replace(/\n$/, '').split('\n').length;
    if (line > lines) return { holds: false, why: `${relative} has ${lines} line${lines === 1 ? '' : 's'}, so it has no line ${line}` };
  }
  return { holds: true };
}

/** `fromProse`: the gates among `gates` that were not listed, only named as passing in the prose. */
/** True when a folder holds a file, git's own aside: something a check could cite. */
export function hasFiles(folder: string): boolean {
  try {
    return (fs.readdirSync(folder, { recursive: true }) as string[]).some((name) => !name.split(path.sep).includes('.git') && fs.statSync(path.join(folder, name)).isFile());
  } catch {
    return false;
  }
}

export type Claims = { checks: VerifiedCheck[]; gates: string[]; fromProse: string[] };

/**
 * A report's or a review's checks, verified: what holds is returned, with the gates claimed in the list or named as
 * passing in its prose. The first command or file that does not hold, or a gate the repository does not have, is
 * returned as the reason to refuse it.
 */
export function verifyClaims(input: { checks: Check[]; prose: string; repoGates: string[]; folder: string; rows: EventRow[] }): Claims | { refused: string } {
  const checks: VerifiedCheck[] = [];
  const gates = new Set<string>();
  for (const check of input.checks) {
    if ('gate' in check) {
      const gate = check.gate.trim();
      if (!input.repoGates.includes(gate)) return { refused: `There is no gate "${gate}" here (the gates are: ${input.repoGates.join(', ') || 'none'}). List a gate by its name, or the command you ran.` };
      gates.add(gate);
    } else if ('command' in check) {
      const proof = commandProof(input.rows, check.command);
      if (!proof.holds) return { refused: `Your checks list \`${tidy(check.command)}\`, but ${proof.why}. List only what you ran after your last change and what succeeded, or run it now.` };
      checks.push({ kind: 'command', what: proof.ran, shown: `ran ${proof.ran.length > 120 ? `${proof.ran.slice(0, 119)}…` : proof.ran}` });
    } else {
      const proof = fileProof(input.folder, check.file, check.line);
      const where = `${check.file.trim().replace(/^\.\//, '')}${check.line ? `:${check.line}` : ''}`;
      if (!proof.holds) return { refused: `Your checks list ${where}, but ${proof.why}.` };
      checks.push({ kind: 'file', what: check.file.trim().replace(/^\.\//, ''), ...(check.line ? { line: check.line } : {}), shown: `cites ${where}` });
    }
  }
  const listed = new Set(gates);
  for (const gate of gatesNamedAsPassing(input.prose, input.repoGates)) gates.add(gate);
  return { checks, gates: [...gates], fromProse: [...gates].filter((gate) => !listed.has(gate)) };
}
