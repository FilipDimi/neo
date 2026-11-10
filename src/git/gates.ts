/**
 * Gates: named commands that must pass, registered per repository and run by the engine.
 * The result an employee could report is never used: the engine keeps the real exit code and output.
 *
 * A gate runs what an employee wrote (the tests, the build script), so it is confined exactly as
 * an employee's own commands are: it writes to the task folder, a temp folder of its own and the
 * team's build folders; it cannot read a secret; it reaches this machine but not the network,
 * and not the engine's own port. A gate that cannot be confined is not run.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { plainEnv } from '../runtime/env.ts';
import type { Gate, GateResult } from '../shared/types.ts';
import { leadsTo } from './paths.ts';

export const GATE_OUTPUT_CAP = 8192;
const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

export type GateLimits = {
  /** Folders besides the task folder that the gate may write to: the team's build folders. */
  allowWrite?: string[];
  /** Places inside those that stay closed: the folder's git directory. */
  denyWrite?: string[];
  denyRead?: string[];
  /** Ports on this machine the gate must not reach: the engine's own. */
  blockPorts?: number[];
  env?: Record<string, string>;
  sandboxExec?: string;
};

const quoted = (file: string): string => `"${file.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const real = (file: string): string => leadsTo(file) ?? file;
const under = (files: string[]): string => files.map((file) => `(subpath ${quoted(real(file))})`).join(' ');

/** The macOS sandbox profile for one gate. In this language the last rule that matches decides. */
export function gateProfile(cwd: string, tmp: string, limits: GateLimits): string {
  return [
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    `(allow file-write* ${under([cwd, tmp, ...(limits.allowWrite ?? [])])} (literal "/dev/null") (literal "/dev/zero") (literal "/dev/tty") (literal "/dev/dtracehelper") (regex #"^/dev/ttys[0-9]+$") (regex #"^/dev/fd/"))`,
    // The folder itself stays where it is: moved away, nothing below would protect its git directory, and it could be moved back changed.
    `(deny file-write-unlink (literal ${quoted(real(cwd))}))`,
    ...(limits.denyWrite?.length ? [`(deny file-write* ${under(limits.denyWrite)})`] : []),
    ...(limits.denyRead?.length ? [`(deny file-read* ${under(limits.denyRead)})`] : []),
    // This machine only, and no socket files: the Docker daemon and the key agent listen on those, and the name service
    // would carry whatever is put in a name out to the network. `localhost` resolves without it.
    '(deny network-outbound)',
    '(allow network-outbound (remote ip "localhost:*") (literal "/private/var/run/syslog"))',
    ...(limits.blockPorts ?? []).map((port) => `(deny network-outbound (remote ip "localhost:${port}"))`),
    // Nothing reaches other programs: no signal to a process that is not the gate's own, no change to any program's
    // preferences, no Apple Event, and no launching an application (each is a way to have something run outside).
    '(deny signal)',
    '(allow signal (target same-sandbox))',
    '(deny user-preference-write)',
    // The preferences service writes on a caller's behalf, wherever the file is. Without it a program reads the files itself, and cannot write them.
    '(deny mach-lookup (global-name "com.apple.cfprefsd.daemon") (global-name "com.apple.cfprefsd.agent"))',
    '(deny appleevent-send)',
    '(deny lsopen)',
  ].join('\n');
}

export function runGate(gate: Gate, cwd: string, limits: GateLimits = {}): Promise<GateResult> {
  const started = Date.now();
  const sandboxExec = limits.sandboxExec ?? SANDBOX_EXEC;
  const result = (exitCode: number, output: string): GateResult => ({ name: gate.name, command: gate.command, exitCode, output, durationMs: Date.now() - started });
  if (!fs.existsSync(sandboxExec)) return Promise.resolve(result(126, `The gate was not run: this machine cannot confine it (${sandboxExec} is missing), and a gate runs code an employee wrote.`));

  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vs-gate-')));
  return new Promise((resolve) => {
    // Its own process group, so a timeout ends everything the gate started.
    const child = spawn(sandboxExec, ['-p', gateProfile(cwd, tmp, limits), '/bin/bash', '-c', gate.command], {
      cwd,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...(limits.env ?? plainEnv(process.env)), TMPDIR: tmp },
    });
    let output = '';
    let timedOut = false;
    const keep = (chunk: Buffer) => {
      output = `${output}${chunk.toString('utf8')}`;
      if (output.length > GATE_OUTPUT_CAP * 2) output = output.slice(-GATE_OUTPUT_CAP); // the end is what explains a failure
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }, gate.timeoutMinutes * 60_000);
    const finish = (code: number) => {
      clearTimeout(timer);
      fs.rmSync(tmp, { recursive: true, force: true });
      const tail = Buffer.from(output).subarray(-GATE_OUTPUT_CAP).toString('utf8');
      resolve(result(timedOut ? 124 : code, timedOut ? `${tail}\n(timed out after ${gate.timeoutMinutes} min)` : tail));
    };
    child.on('error', (error) => {
      output += String(error);
      finish(127);
    });
    child.on('close', (code) => finish(code ?? 1));
  });
}

export type GateOptions = { onStart?: (gate: Gate) => void; onFinish?: (result: GateResult) => void; limits?: GateLimits };

/** Runs a task's gates in order, stopping at the first failure. Gates that share a lock never run side by side. */
export class GateQueue {
  private readonly tails = new Map<string, Promise<unknown>>();

  async run(gates: Gate[], cwd: string, options: GateOptions = {}): Promise<GateResult[]> {
    const results: GateResult[] = [];
    for (const gate of gates) {
      const once = async () => {
        options.onStart?.(gate);
        const result = await runGate(gate, cwd, options.limits);
        options.onFinish?.(result);
        return result;
      };
      const result = gate.lock ? await this.locked(gate.lock, once) : await once();
      results.push(result);
      if (result.exitCode !== 0) break;
    }
    return results;
  }

  private locked<T>(lock: string, work: () => Promise<T>): Promise<T> {
    const next = (this.tails.get(lock) ?? Promise.resolve()).then(work, work);
    this.tails.set(
      lock,
      next.catch(() => {}),
    );
    return next;
  }
}
