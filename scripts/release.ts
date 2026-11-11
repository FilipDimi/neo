/**
 * Makes a release: a copy of the committed code in a folder of its own, with its own
 * dependencies and its own built screen. The live company runs from a release, never from this
 * working folder, so editing the code here and running its tests cannot touch a company at work.
 *
 *   npm run release        copies the last commit, installs, builds, tests, and makes it current
 *   npm run release -- --skip-tests   the same without the tests
 *   npm run live           starts the company from the current release
 *
 * A release is a folder named after its commit under ~/.virtual-startup-app/releases, and
 * `current` is a link to one of them. An engine that is already running keeps the release it
 * started from; it picks up a new one the next time it is started. The two newest are kept, and
 * so is any release an engine is running from.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { removable } from '../src/release.ts';

const REPO = path.resolve(import.meta.dirname, '..');
const HOME = path.join(process.env.VS_APP_DIR ?? path.join(os.homedir(), '.virtual-startup-app'));
const RELEASES = path.join(HOME, 'releases');
const CURRENT = path.join(HOME, 'current');
const KEPT = 2;

const sh = (command: string, args: string[], cwd: string, input?: Buffer): Buffer => execFileSync(command, args, { cwd, input, stdio: [input ? 'pipe' : 'ignore', 'pipe', 'inherit'], maxBuffer: 1024 * 1024 * 1024 });
const step = (text: string): void => console.log(`· ${text}`);

/**
 * One step of building a release. It is quiet while it goes well. When it fails, what it printed is the explanation,
 * so that is shown, and the release is not made: the company stays on the release it has.
 */
function build(what: string, command: string, args: string[], cwd: string, hint = ''): void {
  step(what);
  try {
    execFileSync(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1024 * 1024 * 1024 });
  } catch (failure) {
    const { stdout, stderr, message } = failure as { stdout?: Buffer; stderr?: Buffer; message: string };
    if (stdout?.length) process.stdout.write(stdout);
    if (stderr?.length) process.stderr.write(stderr);
    if (!stdout?.length && !stderr?.length) console.error(message);
    console.error(`\nNo release was made: ${what} failed, as shown above. Nothing that is running was touched.${hint}`);
    process.exit(1);
  }
}

const sha = sh('git', ['rev-parse', 'HEAD'], REPO).toString().trim();
const dirty = sh('git', ['status', '--porcelain'], REPO).toString().trim();
if (dirty) console.log(`Note: this folder has changes that are not committed. They are not in the release:\n${dirty}\n`);

const dir = path.join(RELEASES, sha.slice(0, 12));
const marker = path.join(dir, 'RELEASE.json');

if (fs.existsSync(marker)) step(`release ${sha.slice(0, 12)} is already built`);
else {
  // A folder left by a release that did not finish is started again from nothing.
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  step(`copying commit ${sha.slice(0, 12)} to ${dir}`);
  sh('tar', ['-x', '-C', dir], REPO, sh('git', ['archive', '--format=tar', sha], REPO));
  build('installing its dependencies', 'npm', ['ci', '--no-audit', '--no-fund'], dir);
  build('building its screen', process.execPath, [path.join(dir, 'node_modules/vite/bin/vite.js'), 'build', '--config', path.join(dir, 'web/vite.config.ts'), '--logLevel', 'warn'], dir);
  if (!process.argv.includes('--skip-tests')) build('running its tests', 'npm', ['test', '--silent'], dir, '\nTo make the release without running them: npm run release -- --skip-tests');
  fs.writeFileSync(marker, `${JSON.stringify({ commit: sha, builtAt: new Date().toISOString() }, null, 2)}\n`);
}

// Point `current` at it in one step: a link made beside it, then renamed over it.
const previous = fs.existsSync(CURRENT) ? fs.realpathSync(CURRENT) : null;
const next = `${CURRENT}.next`;
fs.rmSync(next, { force: true });
fs.symlinkSync(dir, next);
fs.renameSync(next, CURRENT);
step(`current is ${sha.slice(0, 12)}`);

// Keep the two newest releases, the one before this to go back to, and any that an engine is running from right now.
for (const release of removable(RELEASES, [dir, ...(previous ? [previous] : [])], KEPT)) {
  step(`removing the old release ${path.basename(release)}`);
  fs.rmSync(release, { recursive: true, force: true });
}

console.log(previous && previous !== fs.realpathSync(dir) ? '\nA company that is running now is still on the release before this one. Stop it and start it again (npm run live) to use this one.' : '\nStart the company with: npm run live');
