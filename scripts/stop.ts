/**
 * Stops the company: asks every engine that runs from a release to end, the way Ctrl-C would.
 * An engine ends its workers, closes the database and exits; runs that were in flight are picked
 * up at the next start.
 *
 *   npm run stop
 *
 * An engine started with `npm run live` in a terminal can also be stopped there with Ctrl-C. One
 * started from a Claude session (the `start` tool) has no terminal: this is how it is stopped.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { liveEngines } from '../src/release.ts';

const RELEASES = path.join(process.env.VS_APP_DIR ?? path.join(os.homedir(), '.virtual-startup-app'), 'releases');
const releases = fs.existsSync(RELEASES) ? fs.readdirSync(RELEASES).map((name) => path.join(RELEASES, name)) : [];
const running = releases.flatMap((release) => liveEngines(release).map((pid) => ({ release: path.basename(release), pid })));

if (running.length === 0) console.log('No engine is running from a release. (One started with `npm start` in this folder is stopped in its own terminal.)');
for (const { release, pid } of running) {
  process.kill(pid, 'SIGTERM');
  console.log(`Asked the engine from release ${release} (process ${pid}) to stop.`);
}

// An engine finishes the work it is in the middle of before it goes: a commit, a merge, or a gate, which can take as
// long as the gate may. Until it has gone the company is not stopped, and starting it again would only find it running.
const gone = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
};
const began = Date.now();
let said = false;
while (running.some(({ pid }) => !gone(pid))) {
  if (!said && Date.now() - began > 5000) {
    said = true;
    console.log('It is finishing the work it was in the middle of (a gate, a commit or a merge) and stops when that is done. Waiting for it; Ctrl-C stops the waiting, not the engine.');
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
}
if (running.length > 0) console.log('Stopped.');
