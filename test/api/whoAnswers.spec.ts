import { once } from 'node:events';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { buildServer } from '../../src/api/server.ts';
import { whoAnswers } from '../../src/api/whoAnswers.ts';
import { scripted } from '../fixtures/scriptedLink.ts';
import { tempDir, world } from '../helpers.ts';

describe('who answers on a port of this machine', () => {
  it('tells an engine of ours from another program, and from nobody', async () => {
    const w = world(scripted().spawn);
    const app = await buildServer({ db: w.db, dataDir: w.dir, supervisor: w.sup, port: 0, webDir: tempDir() });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const engine = (app.server.address() as AddressInfo).port;
    const other = http.createServer((_request, response) => response.end('hello')).listen(0, '127.0.0.1');
    await once(other, 'listening');
    try {
      expect(await whoAnswers(engine)).toBe('engine');
      expect(await whoAnswers((other.address() as AddressInfo).port)).toBe('other');
      await app.close();
      expect(await whoAnswers(engine)).toBe('nobody');
    } finally {
      other.close();
      await app.close().catch(() => {});
      await w.sup.stop();
    }
  });

  it('calls a port that is held but never answers another program, not nobody', async () => {
    // Something has the port and says nothing: starting an engine there would still fail.
    const silent = http.createServer(() => {}).listen(0, '127.0.0.1');
    await once(silent, 'listening');
    try {
      expect(await whoAnswers((silent.address() as AddressInfo).port, 200)).toBe('other');
    } finally {
      silent.closeAllConnections();
      silent.close();
    }
  });
});
