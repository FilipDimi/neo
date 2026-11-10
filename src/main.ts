/**
 * One command starts everything: the screen (built when it is missing or out of date), the data
 * directory, recovery, the supervisor, the health checks, the API, and the browser.
 *
 *   npm start
 *   VS_DATA_DIR=…        where the company lives (default ~/.virtual-startup)
 *   VS_PORT=…            default 4317
 *   VS_NO_OPEN=1         do not open the browser
 *   VS_RUNTIME_MODULE=…  a module exporting startSession, to run without a model (demos, tests)
 */
import path from 'node:path';
import open from 'open';
import { buildServer, DEFAULT_PORT } from './api/server.ts';
import { ensureWebBuilt } from './api/webBuild.ts';
import { whoAnswers } from './api/whoAnswers.ts';
import { dataDir, paths } from './db/dataDir.ts';
import { openDb } from './db/open.ts';
import { markRunning } from './release.ts';
import { Supervisor } from './supervisor/supervisor.ts';

const port = Number(process.env.VS_PORT ?? DEFAULT_PORT);
const url = `http://127.0.0.1:${port}/`;

// One engine per port. A second start says so and touches nothing: not the database, not the runs of the first.
const there = await whoAnswers(port);
if (there === 'engine') {
  console.log(`The company is already running at ${url}\nNothing was started. Use that one${process.env.VS_NO_OPEN ? '' : '; opening it now'}. To start it afresh, stop the one that is running first.`);
  if (!process.env.VS_NO_OPEN) await open(url);
  process.exit(0);
}
if (there === 'other') {
  console.error(`Port ${port} on this machine is taken by another program, so the company cannot start there.\nStop that program, or start on another port: VS_PORT=4320 npm start`);
  process.exit(1);
}

ensureWebBuilt();
const dir = dataDir();
const db = openDb(paths(dir).db);
const supervisor = new Supervisor({ db, dataDir: dir, apiPort: port, ...(process.env.VS_RUNTIME_MODULE ? { runtimeModule: process.env.VS_RUNTIME_MODULE } : {}) });
const app = await buildServer({ db, dataDir: dir, supervisor, port });
await app.listen({ host: '127.0.0.1', port });
supervisor.start();
// When this is a release, say that an engine runs from it, so that making a newer release leaves it in place.
markRunning(path.resolve(import.meta.dirname, '..'));

console.log(`The company in ${dir} is running at ${url}`);
if (!process.env.VS_NO_OPEN) await open(url);

let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    await app.close();
    await supervisor.stop();
    db.close();
    process.exit(0);
  });
}
