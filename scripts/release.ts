/**
 * Makes a release: a copy of the committed code in a folder of its own, with its own
 * dependencies and its own built screen. The live company runs from a release, never from this
 * working folder, so editing the code here and running its tests cannot touch a company at work.
 *
 *   npm run release        copies the last commit, installs, builds, tests, and makes it current
 *   npm run live           starts the company from the current release
 *
 * A release is a folder named after its commit under ~/.virtual-startup-app/releases, and
 * `current` is a link to one of them. An engine that is already running keeps the release it
 * started from; it picks up a new one the next time it is started. The two newest are kept.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..');
const HOME = path.join(process.env.VS_APP_DIR ?? path.join(os.homedir(), '.virtual-startup-app'));
const RELEASES = path.join(HOME, 'releases');
const CURRENT = path.join(HOME, 'current');
const KEPT = 2;

const sh = (command: string, args: string[], cwd: string, input?: Buffer): Buffer => execFileSync(command, args, { cwd, input, stdio: [input ? 'pipe' : 'ignore', 'pipe', 'inherit'], maxBuffer: 1024 * 1024 * 1024 });
const step = (text: string): void => console.log(`· ${text}`);

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
  step('installing its dependencies');
  sh('npm', ['ci', '--no-audit', '--no-fund'], dir);
  step('building its screen');
  sh(process.execPath, [path.join(dir, 'node_modules/vite/bin/vite.js'), 'build', '--config', path.join(dir, 'web/vite.config.ts'), '--logLevel', 'warn'], dir);
  if (!process.argv.includes('--skip-tests')) {
    step('running its tests');
    sh('npm', ['test', '--silent'], dir);
  }
  fs.writeFileSync(marker, `${JSON.stringify({ commit: sha, builtAt: new Date().toISOString() }, null, 2)}\n`);
}

// Point `current` at it in one step: a link made beside it, then renamed over it.
const previous = fs.existsSync(CURRENT) ? fs.realpathSync(CURRENT) : null;
const next = `${CURRENT}.next`;
fs.rmSync(next, { force: true });
fs.symlinkSync(dir, next);
fs.renameSync(next, CURRENT);
step(`current is ${sha.slice(0, 12)}`);

// Keep the two newest releases: the current one, and the one before it to go back to.
const built = fs
  .readdirSync(RELEASES)
  .map((name) => path.join(RELEASES, name))
  .filter((release) => fs.existsSync(path.join(release, 'RELEASE.json')))
  .sort((a, b) => fs.statSync(path.join(b, 'RELEASE.json')).mtimeMs - fs.statSync(path.join(a, 'RELEASE.json')).mtimeMs);
const keep = new Set([fs.realpathSync(dir), ...(previous ? [previous] : []), ...built.slice(0, KEPT).map((release) => fs.realpathSync(release))]);
for (const release of built) {
  if (keep.has(fs.realpathSync(release))) continue;
  step(`removing the old release ${path.basename(release)}`);
  fs.rmSync(release, { recursive: true, force: true });
}

console.log(previous && previous !== fs.realpathSync(dir) ? '\nA company that is running now is still on the release before this one. Stop it and start it again (npm run live) to use this one.' : '\nStart the company with: npm run live');
