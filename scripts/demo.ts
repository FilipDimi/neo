/**
 * The whole product with no model: a throwaway company (the cast of the design's artboards), a
 * throwaway repository, real worker processes, and a scripted runtime in place of the SDK.
 *
 *   npm run demo            then open http://127.0.0.1:4318/
 *   VS_PORT=…               another port (the default is 4318: 4317 is the real company's)
 *   VS_DEMO_DELAY_MS=400    makes the employees quicker
 *   VS_DEMO_EMPTY=1         starts with no company, to see first setup
 *
 * A word in a task's brief changes what its employee does: HANG, OUTSIDE, ASK, NEEDTOOL, REDO, LIMIT
 * (see test/fixtures/demoRuntime.ts).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildServer } from '../src/api/server.ts';
import { ensureWebBuilt } from '../src/api/webBuild.ts';
import { whoAnswers } from '../src/api/whoAnswers.ts';
import { paths } from '../src/db/dataDir.ts';
import { openDb } from '../src/db/open.ts';
import { Supervisor } from '../src/supervisor/supervisor.ts';
import { healthyProbes, seedDemoCompany } from './seed-demo.ts';

const port = Number(process.env.VS_PORT ?? 4318);
if ((await whoAnswers(port)) !== 'nobody') {
  console.error(`Port ${port} on this machine is taken, so the demo cannot start there.\nStop what is running there (an earlier demo, perhaps), or start on another port: VS_PORT=4320 npm run demo`);
  process.exit(1);
}

ensureWebBuilt();
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vs-demo-')));
const dataDir = path.join(root, 'data');
const db = openDb(paths(dataDir).db);
const runtimeModule = path.resolve(import.meta.dirname, '../test/fixtures/demoRuntime.ts');

if (!process.env.VS_DEMO_EMPTY) seedDemoCompany({ db, dataDir, repoPath: path.join(root, 'repo'), now: new Date(), leaseMinutes: 1 });

const supervisor = new Supervisor({ db, dataDir, runtimeModule, probes: healthyProbes, tickMs: 500, apiPort: port });
const app = await buildServer({ db, dataDir, supervisor, port });
await app.listen({ host: '127.0.0.1', port });
supervisor.start();
console.log(`Demo company running at http://127.0.0.1:${port}/  (no model is used; throwaway data in ${root})`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    await app.close();
    await supervisor.stop();
    // The company was a throwaway: take it, and what its employees remembered between runs, off the disk.
    fs.rmSync(root, { recursive: true, force: true });
    for (const name of fs.readdirSync(os.tmpdir())) if (name.startsWith(`vs-demo-once-${process.pid}-`)) fs.rmSync(path.join(os.tmpdir(), name), { force: true });
    process.exit(0);
  });
}
