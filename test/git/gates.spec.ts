import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { GateQueue, runGate } from '../../src/git/gates.ts';
import type { Gate } from '../../src/shared/types.ts';
import { tempDir } from '../helpers.ts';

const gate = (name: string, command: string, over: Partial<Gate> = {}): Gate => ({ name, command, timeoutMinutes: 1, lock: null, ...over });

describe('a gate is confined like any other command', () => {
  it('writes inside its folder and its own temp folder, and nowhere else', async () => {
    const dir = tempDir();
    const outside = tempDir();
    const inside = await runGate(gate('in', 'echo made > made.txt && echo tmp > "$TMPDIR/scratch" && cat made.txt'), dir);
    expect(inside).toMatchObject({ exitCode: 0, output: expect.stringContaining('made') });
    expect(fs.existsSync(path.join(dir, 'made.txt'))).toBe(true);

    const out = await runGate(gate('out', `echo no > "${outside}/escaped.txt"`), dir);
    expect(out.exitCode).not.toBe(0);
    expect(fs.existsSync(path.join(outside, 'escaped.txt'))).toBe(false);
    const home = await runGate(gate('home', 'echo no > "$HOME/vs-gate-escape-probe.txt"'), dir);
    expect(home.exitCode).not.toBe(0);
    expect(fs.existsSync(path.join(os.homedir(), 'vs-gate-escape-probe.txt'))).toBe(false);
  });

  it('writes to a build folder the team allows', async () => {
    const dir = tempDir();
    const cache = tempDir();
    const result = await runGate(gate('cache', `echo built > "${cache}/artifact"`), dir, { allowWrite: [cache] });
    expect(result.exitCode).toBe(0);
    expect(fs.readFileSync(path.join(cache, 'artifact'), 'utf8')).toBe('built\n');
  });

  it("cannot plant anything in the folder's git directory", async () => {
    const dir = tempDir();
    fs.mkdirSync(path.join(dir, '.git/hooks'), { recursive: true });
    const result = await runGate(gate('hook', 'echo "#!/bin/sh" > .git/hooks/pre-commit || echo REFUSED; echo x > .git/config || echo REFUSED-TOO'), dir, { denyWrite: [path.join(dir, '.git')] });
    expect(result.output).toContain('REFUSED');
    expect(result.output).toContain('REFUSED-TOO');
    expect(fs.existsSync(path.join(dir, '.git/hooks/pre-commit'))).toBe(false);
  });

  it('cannot read what is denied, and reads everything else', async () => {
    const dir = tempDir();
    const secrets = tempDir();
    fs.writeFileSync(path.join(secrets, 'key'), 'THE-SECRET');
    fs.writeFileSync(path.join(dir, '.env'), 'TOKEN=THE-ENV-SECRET');
    const result = await runGate(gate('read', `cat "${secrets}/key"; cat .env; head -c 9 /etc/hosts`), dir, { denyRead: [secrets, path.join(dir, '.env')] });
    expect(result.output).not.toContain('THE-SECRET');
    expect(result.output).not.toContain('THE-ENV-SECRET');
    expect(result.output).toContain('##');
  });

  it('gets a short environment: nothing the engine happened to be started with', async () => {
    process.env.VS_TEST_GATE_SECRET = 'leaked-if-seen';
    process.env.ANTHROPIC_API_KEY_FOR_TEST = 'leaked-too';
    try {
      const result = await runGate(gate('env', 'env'), tempDir());
      expect(result.output).not.toContain('leaked');
      expect(result.output).toMatch(/^PATH=/m);
      expect(result.output).toMatch(/^HOME=/m);
      expect(result.output).toMatch(/^TMPDIR=.*vs-gate-/m);
    } finally {
      delete process.env.VS_TEST_GATE_SECRET;
      delete process.env.ANTHROPIC_API_KEY_FOR_TEST;
    }
  });

  it("reaches a server on this machine, but not the engine's own port and not the network", async () => {
    const serve = (text: string) => new Promise<http.Server>((resolve) => { const server = http.createServer((_q, r) => r.end(text)).listen(0, '127.0.0.1', () => resolve(server)); });
    const engine = await serve('ENGINE-REACHED');
    const other = await serve('test-server-ok');
    const port = (server: http.Server) => (server.address() as { port: number }).port;
    try {
      const result = await runGate(gate('net', `curl -s -m 5 http://127.0.0.1:${port(other)}/; echo; curl -s -m 5 http://127.0.0.1:${port(engine)}/ || echo ENGINE-REFUSED; curl -s -m 5 http://localhost:${port(engine)}/ || echo ENGINE-REFUSED-BY-NAME; curl -s -m 5 https://example.com >/dev/null || echo OUTSIDE-REFUSED`), tempDir(), { blockPorts: [port(engine)] });
      expect(result.output).toContain('test-server-ok');
      expect(result.output).not.toContain('ENGINE-REACHED');
      expect(result.output).toContain('ENGINE-REFUSED');
      expect(result.output).toContain('ENGINE-REFUSED-BY-NAME');
      expect(result.output).toContain('OUTSIDE-REFUSED');
    } finally {
      engine.close();
      other.close();
    }
  });

  it('is not run at all when it cannot be confined', async () => {
    const dir = tempDir();
    const result = await runGate(gate('unconfined', 'echo ran > ran.txt'), dir, { sandboxExec: '/nonexistent/sandbox-exec' });
    expect(result.exitCode).toBe(126);
    expect(result.output).toMatch(/not run/);
    expect(fs.existsSync(path.join(dir, 'ran.txt'))).toBe(false);
  });

  it('leaves no temp folder behind', async () => {
    const result = await runGate(gate('tmp', 'echo "$TMPDIR"'), tempDir());
    const tmp = result.output.trim();
    expect(tmp).toMatch(/vs-gate-/);
    expect(fs.existsSync(tmp)).toBe(false);
  });
});

describe('gates', () => {
  it('runs a command in the folder and keeps its real exit code and output', async () => {
    const dir = tempDir();
    const passed = await runGate(gate('pwd', 'pwd && echo to-stderr >&2'), dir);
    expect(passed).toMatchObject({ name: 'pwd', command: 'pwd && echo to-stderr >&2', exitCode: 0 });
    expect(passed.output).toContain(dir);
    expect(passed.output).toContain('to-stderr');
    expect(passed.durationMs).toBeGreaterThanOrEqual(0);
    expect(await runGate(gate('fails', 'echo boom; exit 7'), dir)).toMatchObject({ exitCode: 7, output: expect.stringContaining('boom') });
  });

  it('keeps the end of a long output, capped', async () => {
    const result = await runGate(gate('long', 'for i in $(seq 1 5000); do echo "line $i"; done; echo THE-END'), tempDir());
    expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(8192 + 64);
    expect(result.output).toContain('THE-END');
    expect(result.output).not.toContain('line 1\n');
  });

  it('ends a gate at its timeout with a non-zero result', async () => {
    const result = await runGate(gate('slow', 'sleep 30', { timeoutMinutes: 0.005 }), tempDir());
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain('timed out');
    expect(result.durationMs).toBeLessThan(5000);
  });

  it('runs gates in order and stops at the first failure', async () => {
    const seen: string[] = [];
    const results = await new GateQueue().run([gate('one', 'true'), gate('two', 'false'), gate('three', 'true')], tempDir(), { onStart: (g) => seen.push(`start ${g.name}`), onFinish: (r) => seen.push(`${r.name} ${r.exitCode}`) });
    expect(results.map((r) => [r.name, r.exitCode])).toEqual([['one', 0], ['two', 1]]);
    expect(seen).toEqual(['start one', 'one 0', 'start two', 'two 1']);
  });

  it('runs two gates that share a lock one after the other, and unlocked ones side by side', async () => {
    const queue = new GateQueue();
    const dir = tempDir();
    const stamp = 'date +%s%N >> order.txt; sleep 0.3; date +%s%N >> order.txt';
    const overlap = async (lock: string | null) => {
      const started = Date.now();
      await Promise.all([queue.run([gate('a', stamp, { lock })], dir), queue.run([gate('b', stamp, { lock })], dir)]);
      return Date.now() - started;
    };
    expect(await overlap('xcode')).toBeGreaterThanOrEqual(580);
    expect(await overlap(null)).toBeLessThan(580);
  });
});
