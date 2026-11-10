/**
 * Releases and the engines that run from them. A release is a folder with a RELEASE.json in it
 * (see scripts/release.ts). An engine started from one leaves a file named after its process
 * there, so that making a newer release never removes the code a running company is using.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const MARKER = 'RELEASE.json';
const RUNNING = '.running';
/** How far the two readings of one process's start may be apart: `ps` counts in whole seconds. */
const SLACK_MS = 5000;

/**
 * How long a process has been running, in seconds; null when there is none with that number.
 * Asked as a length of time, never as a date: a date is printed in the language and the time zone
 * of whoever asks, and the engine and the release are not always started from the same place.
 */
function runningFor(pid: number): number | null {
  let text: string;
  try {
    text = execFileSync('ps', ['-o', 'etime=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
  // [[days-]hours:]minutes:seconds
  const match = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/.exec(text);
  if (!match) return null;
  const [days, hours, minutes, seconds] = match.slice(1).map((part) => Number(part ?? 0));
  return ((days! * 24 + hours!) * 60 + minutes!) * 60 + seconds!;
}

/** The moment a process started, in milliseconds since 1970; null when there is no such process. */
function startedAt(pid: number): number | null {
  if (pid === process.pid) return Math.round(Date.now() - process.uptime() * 1000);
  const seconds = runningFor(pid);
  return seconds === null ? null : Date.now() - seconds * 1000;
}

/**
 * True while the engine that left this file is still running. A number alone proves nothing: after a restart of the
 * machine another process may have it. The file says when its engine started, and that has to match.
 */
function alive(release: string, pid: number): boolean {
  const started = startedAt(pid);
  if (started === null) return false;
  let recorded = '';
  try {
    recorded = fs.readFileSync(path.join(release, RUNNING, String(pid)), 'utf8').trim();
  } catch {
    return false;
  }
  // No start time to compare (an older engine wrote none, or wrote a date as text): a live process with that number
  // counts. That errs on the side of keeping a release, never of removing one that is in use.
  if (!/^\d+$/.test(recorded)) return true;
  return Math.abs(started - Number(recorded)) <= SLACK_MS;
}

function engines(release: string): number[] {
  try {
    return fs
      .readdirSync(path.join(release, RUNNING))
      .map(Number)
      .filter((pid) => Number.isInteger(pid) && pid > 0);
  } catch {
    return [];
  }
}

/** Called by an engine as it starts. Does nothing when the folder it runs from is not a release. */
export function markRunning(root: string, pid: number = process.pid): void {
  if (!fs.existsSync(path.join(root, MARKER))) return;
  const dir = path.join(root, RUNNING);
  fs.mkdirSync(dir, { recursive: true });
  for (const other of engines(root)) if (!alive(root, other)) fs.rmSync(path.join(dir, String(other)), { force: true });
  const started = startedAt(pid);
  fs.writeFileSync(path.join(dir, String(pid)), started === null ? '' : String(started));
}

/** True while an engine that was started from this release is still running. */
export function inUse(release: string): boolean {
  return engines(release).some((pid) => alive(release, pid));
}

/** The finished releases that may be removed: not among the newest `kept`, not named in `keep`, and not in use. */
export function removable(releasesDir: string, keep: string[], kept: number): string[] {
  const real = (file: string): string => {
    try {
      return fs.realpathSync(file);
    } catch {
      return file;
    }
  };
  const built = fs
    .readdirSync(releasesDir)
    .map((name) => path.join(releasesDir, name))
    .filter((release) => fs.existsSync(path.join(release, MARKER)))
    .sort((a, b) => fs.statSync(path.join(b, MARKER)).mtimeMs - fs.statSync(path.join(a, MARKER)).mtimeMs);
  const staying = new Set([...keep, ...built.slice(0, kept)].map(real));
  return built.filter((release) => !staying.has(real(release)) && !inUse(release));
}
