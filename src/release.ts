/**
 * Releases and the engines that run from them. A release is a folder with a RELEASE.json in it
 * (see scripts/release.ts). An engine started from one leaves a file named after its process
 * there, so that making a newer release never removes the code a running company is using.
 */
import fs from 'node:fs';
import path from 'node:path';

const MARKER = 'RELEASE.json';
const RUNNING = '.running';

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (failure) {
    // Not ours to signal, but there: that is a live process too.
    return (failure as NodeJS.ErrnoException).code === 'EPERM';
  }
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
  for (const other of engines(root)) if (!alive(other)) fs.rmSync(path.join(dir, String(other)), { force: true });
  fs.writeFileSync(path.join(dir, String(pid)), '');
}

/** True while an engine that was started from this release is still running. */
export function inUse(release: string): boolean {
  return engines(release).some(alive);
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
