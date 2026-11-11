import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { engineRoot, launchEngine, startCompany } from '../../src/mcp/start.ts';
import { tempDir } from '../helpers.ts';

type Who = 'nobody' | 'engine' | 'other';
/** A port that answers in turn with each of these, and then keeps giving the last. */
const port = (...answers: Who[]) => {
  let asked = 0;
  return async () => answers[Math.min(asked++, answers.length - 1)]!;
};

describe('starting the company from a Claude session', () => {
  it('starts nothing when it is already running', async () => {
    let launched = 0;
    const said = await startCompany({ port: 4317, who: port('engine'), launch: () => void launched++, log: '/tmp/engine.log' });
    expect(said).toMatch(/already running at http:\/\/127\.0\.0\.1:4317\//);
    expect(launched).toBe(0);
  });

  it('starts it when nothing answers, and says so once it does', async () => {
    let launched = 0;
    const said = await startCompany({ port: 4317, who: port('nobody', 'nobody', 'engine'), launch: () => void launched++, log: '/tmp/engine.log', pollMs: 1, waitMs: 1000 });
    expect(launched).toBe(1);
    expect(said).toMatch(/Started\. The company is running at http:\/\/127\.0\.0\.1:4317\//);
  });

  it('will not start on a port another program holds', async () => {
    let launched = 0;
    const said = await startCompany({ port: 4317, who: port('other'), launch: () => void launched++, log: '/tmp/engine.log' });
    expect(launched).toBe(0);
    expect(said).toMatch(/another program/);
  });

  it('says where to look when it was started and never answered', async () => {
    const said = await startCompany({ port: 4317, who: port('nobody'), launch: () => {}, log: '/data/logs/engine.log', pollMs: 1, waitMs: 20 });
    expect(said).toMatch(/has not answered/);
    expect(said).toContain('/data/logs/engine.log');
  });

  it('says in words when the engine could not be launched, and does not take the tools down with it', async () => {
    const said = await startCompany({ port: 4317, who: port('nobody'), launch: () => launchEngine('/nowhere/at/all', `${tempDir()}/engine.log`), log: '/data/logs/engine.log' });
    expect(said).toMatch(/could not be started/);
    expect(said).toContain('/nowhere/at/all');
  });

  it('starts the release that is current, not the one these tools happened to be started from', () => {
    const app = tempDir();
    const old = path.join(app, 'releases', 'aaa');
    const next = path.join(app, 'releases', 'bbb');
    for (const dir of [old, next]) fs.mkdirSync(dir, { recursive: true });
    fs.symlinkSync(next, path.join(app, 'current'));
    expect(engineRoot(old, app)).toBe(next);
    // Tools run from a working folder (npm run mcp) start the engine from that folder.
    expect(engineRoot('/somewhere/else', app)).toBe('/somewhere/else');
    fs.rmSync(path.join(app, 'current'));
    expect(engineRoot(old, app)).toBe(old);
  });
});
