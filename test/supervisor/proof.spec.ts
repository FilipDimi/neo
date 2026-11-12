import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { EventRow } from '../../src/shared/events.ts';
import { commandProof, fileProof, gatesNamedAsPassing } from '../../src/supervisor/proof.ts';
import { checkedLine } from '../../src/shared/view.ts';
import { T0, tempDir } from '../helpers.ts';

let next = 1;
const row = (event: unknown): EventRow => ({ id: next++, at: T0.toISOString(), taskId: 'task1', runId: 'run1', employeeId: 'emp1', teamId: 'team1', event: { kind: 'run_event', runId: 'run1', taskId: 'task1', employeeId: 'emp1', teamId: 'team1', event } as EventRow['event'] });
const call = (id: string, tool: string, input: object) => row({ kind: 'tool_call', id, tool, input });
const result = (id: string, ok: boolean) => row({ kind: 'tool_result', id, ok });

describe('what counts as proof', () => {
  it('finds a gate named as passing in prose, and nothing else', () => {
    const gates = ['rust', 'contract', 'ios-full', 'a+b'];
    expect(gatesNamedAsPassing('The rust gate passes and contract is green.', gates)).toEqual(['rust', 'contract']);
    expect(gatesNamedAsPassing('RUST: OK. ios-full succeeded after two tries.', gates)).toEqual(['rust', 'ios-full']);
    // A name inside a word, a name with no pass word near it, a pass word with no name: none of them.
    expect(gatesNamedAsPassing('I trust it passes. rusty passed. Tests pass.', gates)).toEqual([]);
    expect(gatesNamedAsPassing(`rust ${'x'.repeat(50)} passed`, gates)).toEqual([]);
    expect(gatesNamedAsPassing('I could not run rust.', gates)).toEqual([]);
    // A gate whose name holds a regular-expression character is read as plain text.
    expect(gatesNamedAsPassing('a+b passed', gates)).toEqual(['a+b']);
    expect(gatesNamedAsPassing('aab passed', gates)).toEqual([]);
  });

  it('holds a command this run ran after its last write, and says why when it does not', () => {
    const rows = [call('w1', 'Write', { file_path: 'a.rs' }), result('w1', true), call('c1', 'Bash', { command: 'cargo  test -p jobs' }), result('c1', true), call('c2', 'Bash', { command: 'cd backend && cargo test -p api' }), result('c2', true), call('c3', 'Bash', { command: 'cargo clippy' }), result('c3', false)];
    expect(commandProof(rows, 'cargo test -p jobs')).toEqual({ holds: true });
    expect(commandProof(rows, 'cargo test -p api')).toEqual({ holds: true });
    expect(commandProof(rows, 'cargo clippy')).toEqual({ holds: false, why: 'this run ran `cargo clippy` after its last change, and it failed' });
    expect(commandProof(rows, 'cargo fmt --check')).toEqual({ holds: false, why: 'this run did not run `cargo fmt --check` after its last change' });
    // A change after the command: the command no longer speaks for the work as it is.
    const later = [...rows, call('w2', 'Edit', { file_path: 'b.rs' }), result('w2', true)];
    expect(commandProof(later, 'cargo test -p jobs')).toEqual({ holds: false, why: 'this run did not run `cargo test -p jobs` after its last change' });
    expect(commandProof([], '  ')).toEqual({ holds: false, why: 'a command check names the command it ran' });
  });

  it('holds a file of the work, and a line inside it, and nothing outside the folder', () => {
    const folder = tempDir();
    fs.mkdirSync(path.join(folder, 'src'));
    fs.writeFileSync(path.join(folder, 'src/rate.rs'), 'one\ntwo\nthree\n');
    fs.writeFileSync(path.join(tempDir(), 'outside.txt'), 'x\n');
    expect(fileProof(folder, 'src/rate.rs')).toEqual({ holds: true });
    expect(fileProof(folder, './src/rate.rs', 3)).toEqual({ holds: true });
    expect(fileProof(folder, 'src/rate.rs', 4)).toEqual({ holds: false, why: 'src/rate.rs has 3 lines, so it has no line 4' });
    expect(fileProof(folder, 'src/gone.rs')).toEqual({ holds: false, why: 'there is no src/gone.rs in the work' });
    expect(fileProof(folder, '../outside.txt')).toEqual({ holds: false, why: '../outside.txt is not a file of the work: give its path from the top of the work' });
    expect(fileProof(folder, '/etc/hosts')).toEqual({ holds: false, why: '/etc/hosts is not a file of the work: give its path from the top of the work' });
    expect(fileProof(folder, 'src')).toEqual({ holds: false, why: 'src is a folder, not a file' });
  });

  it('says in one line what was checked, from what the engine verified only', () => {
    const gate = (name: string, exitCode: number) => ({ name, command: 'x', exitCode, output: '', durationMs: 1, at: '2026-11-12T14:02:00.000Z' });
    const files = ['a.rs', 'b.rs', 'c.rs'].map((file) => ({ kind: 'file' as const, what: file, shown: `cites ${file}` }));
    const line = checkedLine({ gateResults: [gate('rust', 0), gate('contract', 1)], checks: [{ kind: 'command', what: 'cargo test -p jobs', shown: 'ran cargo test -p jobs' }, ...files] });
    expect(line).toMatch(/^Checked: rust \(gate, passed \d\d:\d\d\) · contract \(gate, FAILED\) · ran cargo test -p jobs · cites 3 files$/);
    expect(checkedLine({ gateResults: [], checks: files.slice(0, 2) })).toBe('Checked: cites a.rs · cites b.rs');
    expect(checkedLine({ gateResults: [] })).toBeNull();
    expect(checkedLine({ gateResults: [gate('rust', 0), gate('rust', 0)] })).toMatch(/^Checked: rust \(gate, passed \d\d:\d\d\)$/);
  });
});
