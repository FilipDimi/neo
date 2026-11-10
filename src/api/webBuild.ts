/**
 * The web app is built into web/dist, and the engine serves it from there. `npm start` builds it
 * when there is no build or the source has changed since, so one command is always enough.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '../..');
export const WEB_ROOT = path.join(REPO, 'web');
export const WEB_DIST = path.join(WEB_ROOT, 'dist');

const NOT_IN_THE_BUILD = /\.spec\.tsx?$|^testing\.tsx$|^setup\.ts$/;

function newest(dir: string): number {
  let latest = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) latest = entry.name === 'fixtures' ? latest : Math.max(latest, newest(path.join(dir, entry.name)));
    else if (!NOT_IN_THE_BUILD.test(entry.name)) latest = Math.max(latest, fs.statSync(path.join(dir, entry.name)).mtimeMs);
  }
  return latest;
}

/** True when there is no build, or something that goes into it is newer than it. */
/** A name for the screen the engine serves right now. It changes when the built app does, so a page can tell that it is an older one. */
export function screenId(webDir: string = WEB_DIST): string {
  const index = path.join(webDir, 'index.html');
  return fs.existsSync(index) ? createHash('sha256').update(fs.readFileSync(index)).digest('hex').slice(0, 12) : 'plain';
}

export function webIsStale(webRoot = WEB_ROOT): boolean {
  const built = path.join(webRoot, 'dist/index.html');
  if (!fs.existsSync(built)) return true;
  const source = Math.max(fs.existsSync(path.join(webRoot, 'src')) ? newest(path.join(webRoot, 'src')) : 0, fs.existsSync(path.join(webRoot, 'index.html')) ? fs.statSync(path.join(webRoot, 'index.html')).mtimeMs : 0);
  return source > fs.statSync(built).mtimeMs;
}

/** Builds the app if it needs it. A failed build is reported and the engine carries on with its plain page. */
export function ensureWebBuilt(log: (line: string) => void = console.log): boolean {
  if (!webIsStale()) return true;
  log('Building the screen…');
  const vite = path.join(REPO, 'node_modules/vite/bin/vite.js');
  const built = spawnSync(process.execPath, [vite, 'build', '--config', path.join(WEB_ROOT, 'vite.config.ts'), '--logLevel', 'warn'], { cwd: REPO, stdio: 'inherit' });
  if (built.status === 0) return true;
  log('The screen could not be built. The engine is running with its plain page; `npm run build:web` shows why.');
  return false;
}
