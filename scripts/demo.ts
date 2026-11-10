/**
 * The whole product with no model: a throwaway company (the cast of the design's artboards), a
 * throwaway repository, real worker processes, and a scripted runtime in place of the SDK.
 *
 *   npm run demo            then open http://127.0.0.1:4317/
 *   VS_DEMO_DELAY_MS=400    makes the employees quicker
 *   VS_DEMO_EMPTY=1         starts with no company, to see first setup
 *
 * A word in a task's brief changes what its employee does: HANG, OUTSIDE, ASK, REDO, LIMIT
 * (see test/fixtures/demoRuntime.ts).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildServer, DEFAULT_PORT } from '../src/api/server.ts';
import { ensureWebBuilt } from '../src/api/webBuild.ts';
import { paths } from '../src/db/dataDir.ts';
import { openDb } from '../src/db/open.ts';
import { Supervisor } from '../src/supervisor/supervisor.ts';
import { healthyProbes, seedDemoCompany } from './seed-demo.ts';

ensureWebBuilt();
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vs-demo-')));
const dataDir = path.join(root, 'data');
const port = Number(process.env.VS_PORT ?? DEFAULT_PORT);
const db = openDb(paths(dataDir).db);
const runtimeModule = path.resolve(import.meta.dirname, '../test/fixtures/demoRuntime.ts');

if (!process.env.VS_DEMO_EMPTY) seedDemoCompany({ db, dataDir, repoPath: path.join(root, 'repo'), now: new Date(), leaseMinutes: 1 });

const supervisor = new Supervisor({ db, dataDir, runtimeModule, probes: healthyProbes, tickMs: 500 });
const app = await buildServer({ db, dataDir, supervisor, port });
await app.listen({ host: '127.0.0.1', port });
supervisor.start();
console.log(`Demo company running at http://127.0.0.1:${port}/  (no model is used; throwaway data in ${root})`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    await app.close();
    await supervisor.stop();
    process.exit(0);
  });
}
