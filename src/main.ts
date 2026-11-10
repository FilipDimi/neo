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
import open from 'open';
import { buildServer, DEFAULT_PORT } from './api/server.ts';
import { ensureWebBuilt } from './api/webBuild.ts';
import { dataDir, paths } from './db/dataDir.ts';
import { openDb } from './db/open.ts';
import { Supervisor } from './supervisor/supervisor.ts';

ensureWebBuilt();
const dir = dataDir();
const port = Number(process.env.VS_PORT ?? DEFAULT_PORT);
const db = openDb(paths(dir).db);
const supervisor = new Supervisor({ db, dataDir: dir, apiPort: port, ...(process.env.VS_RUNTIME_MODULE ? { runtimeModule: process.env.VS_RUNTIME_MODULE } : {}) });
const app = await buildServer({ db, dataDir: dir, supervisor, port });
await app.listen({ host: '127.0.0.1', port });
supervisor.start();

const url = `http://127.0.0.1:${port}/`;
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
