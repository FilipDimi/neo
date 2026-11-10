import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { apply } from '../../src/db/apply.ts';
import { loadToken } from '../../src/api/security.ts';
import { buildServer } from '../../src/api/server.ts';
import { scripted } from '../fixtures/scriptedLink.ts';
import { task, team, world, type World } from '../helpers.ts';

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

async function listening() {
  const w: World = world(scripted().spawn);
  const app = await buildServer({ db: w.db, dataDir: w.dir, supervisor: w.sup, port: 0, replayCap: 5 });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const port = (app.server.address() as { port: number }).port;
  const sockets: WebSocket[] = [];
  cleanup = async () => {
    for (const socket of sockets) socket.terminate();
    await app.close();
    await w.sup.stop();
  };
  const token = loadToken(path.join(w.dir, 'token'));
  /** Connects, sends a first message, and collects what comes back. */
  const connect = (first: unknown, origin = `http://127.0.0.1:${port}`) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/events`, { headers: { origin } });
    sockets.push(socket);
    const received: any[] = [];
    const closed = new Promise<number>((resolve) => {
      socket.on('close', (code) => resolve(code));
      socket.on('error', () => resolve(-1));
      socket.on('unexpected-response', (_request, response) => resolve(response.statusCode ?? -1));
    });
    socket.on('message', (data) => received.push(JSON.parse(String(data))));
    socket.on('open', () => first !== undefined && socket.send(JSON.stringify(first)));
    const next = async (count: number) => {
      for (let i = 0; i < 200 && received.length < count; i++) await new Promise((resolve) => setTimeout(resolve, 10));
      return received;
    };
    return { socket, received, closed, next };
  };
  return { w, token, connect, port };
}

const emitTask = (w: World, id: string) => apply(w.db, (tx) => tx.emit({ kind: 'task_changed', task: task({ id }), cause: 'created' }));

describe('the event stream', () => {
  it('replays events after since, then streams new ones as they are committed', async () => {
    const { w, token, connect } = await listening();
    const [first] = emitTask(w, 'old');
    emitTask(w, 'kept');
    const client = connect({ token, since: first!.id });
    expect((await client.next(1)).map((row) => row.event.task.id)).toEqual(['kept']);
    emitTask(w, 'live');
    const rows = await client.next(2);
    expect(rows.map((row) => row.event.task.id)).toEqual(['kept', 'live']);
    expect(rows[1]).toMatchObject({ id: expect.any(Number), at: expect.any(String), taskId: 'live', event: { kind: 'task_changed' } });
  });

  it('streams only one task when asked', async () => {
    const { w, token, connect } = await listening();
    const client = connect({ token, since: 0, taskId: 'mine' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    emitTask(w, 'other');
    emitTask(w, 'mine');
    apply(w.db, (tx) => tx.emit({ kind: 'team_changed', team: team({ id: 'extra' }) }));
    expect((await client.next(1)).map((row) => row.taskId)).toEqual(['mine']);
  });

  it('refuses a socket whose first message lacks the token', async () => {
    const { w, connect } = await listening();
    emitTask(w, 'secret');
    const client = connect({ token: 'wrong', since: 0 });
    expect(await client.closed).toBe(4401);
    expect(client.received.filter((m) => m.event)).toEqual([]);
  });

  it('refuses a socket from a foreign origin before it opens', async () => {
    const { token, connect } = await listening();
    const client = connect({ token, since: 0 }, 'https://evil.example');
    expect(await client.closed).toBe(403);
    expect(client.received).toEqual([]);
  });

  it('asks for a resync instead of replaying more than the cap', async () => {
    const { w, token, connect } = await listening();
    for (let i = 0; i < 12; i++) emitTask(w, `t${i}`);
    const client = connect({ token, since: 0 });
    expect(await client.next(1)).toEqual([{ resync: true }]);
    expect(await client.closed).toBe(4409);
  });

  it('closes a socket that says nothing', async () => {
    const { connect } = await listening();
    const client = connect(undefined);
    expect(await client.closed).toBe(4401);
  }, 10_000);
});
