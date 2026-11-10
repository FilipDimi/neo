import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { inUse, liveEngines, markRunning, removable } from '../src/release.ts';
import { tempDir } from './helpers.ts';

/** A releases folder with these releases in it, oldest first. */
function releases(names: string[]): { dir: string; at: (name: string) => string } {
  const dir = tempDir();
  names.forEach((name, index) => {
    fs.mkdirSync(path.join(dir, name));
    const marker = path.join(dir, name, 'RELEASE.json');
    fs.writeFileSync(marker, '{}');
    const when = new Date(Date.UTC(2026, 0, 1 + index));
    fs.utimesSync(marker, when, when);
  });
  return { dir, at: (name) => path.join(dir, name) };
}

/** The pid of a process that has just ended. */
const endedPid = (): number => spawnSync(process.execPath, ['-e', '0']).pid;

describe('a release an engine runs from', () => {
  it('is in use while the engine that marked it is alive, and not after', () => {
    const { at } = releases(['a']);
    expect(inUse(at('a'))).toBe(false);
    markRunning(at('a'), endedPid());
    expect(inUse(at('a'))).toBe(false);
    markRunning(at('a'));
    expect(inUse(at('a'))).toBe(true);
  });

  it('is not in use when the number of its engine has since gone to another process', () => {
    const { at } = releases(['a']);
    // This process is alive, but it did not start when the file says its engine did.
    fs.mkdirSync(path.join(at('a'), '.running'));
    fs.writeFileSync(path.join(at('a'), '.running', String(process.pid)), String(Date.now() - 24 * 3600_000));
    expect(inUse(at('a'))).toBe(false);
    // A file with no start time in it (an engine from before they were written, or one that wrote a date as text)
    // has nothing to compare: a live process with that number counts, which errs on the side of keeping the release.
    for (const older of ['', 'Tue Nov 10 15:57:21 2026', 'Di 10 Nov 15:57:21 2026']) {
      fs.writeFileSync(path.join(at('a'), '.running', String(process.pid)), older);
      expect(inUse(at('a')), JSON.stringify(older)).toBe(true);
    }
  });

  it('gives the same answer whatever language and time zone the asking terminal is set to', () => {
    // The engine is started in one place (an app, a login item) and the release is made in another (a terminal).
    const { at } = releases(['a']);
    markRunning(at('a'));
    expect(fs.readFileSync(path.join(at('a'), '.running', String(process.pid)), 'utf8')).toMatch(/^\d{13}$/);
    const before = { LANG: process.env.LANG, LC_ALL: process.env.LC_ALL, TZ: process.env.TZ };
    try {
      for (const [LANG, TZ] of [['de_DE.UTF-8', 'Asia/Tokyo'], ['en_GB.UTF-8', 'America/Los_Angeles'], ['C', 'UTC']] as const) {
        Object.assign(process.env, { LANG, LC_ALL: LANG, TZ });
        expect(inUse(at('a')), `${LANG} ${TZ}`).toBe(true);
      }
    } finally {
      for (const [name, value] of Object.entries(before)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });

  it('names the engines that are running from it, and none that have ended', () => {
    const { at } = releases(['a']);
    markRunning(at('a'), endedPid());
    expect(liveEngines(at('a'))).toEqual([]);
    markRunning(at('a'));
    expect(liveEngines(at('a'))).toEqual([process.pid]);
  });

  it('is not marked when the engine runs from a folder that is not a release', () => {
    const dir = tempDir();
    markRunning(dir);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('forgets the engines that have ended when a new one starts', () => {
    const { at } = releases(['a']);
    const ended = endedPid();
    markRunning(at('a'), ended);
    markRunning(at('a'));
    expect(fs.readdirSync(path.join(at('a'), '.running')).sort()).toEqual([String(process.pid)]);
  });
});

describe('removing old releases', () => {
  it('keeps the newest two and the ones named, and removes the rest', () => {
    const { dir, at } = releases(['one', 'two', 'three', 'four', 'five']);
    expect(removable(dir, [at('two')], 2).map((release) => path.basename(release)).sort()).toEqual(['one', 'three']);
  });

  it('never removes a release a running engine was started from, however old', () => {
    const { dir, at } = releases(['one', 'two', 'three', 'four']);
    markRunning(at('one'));
    markRunning(at('two'), endedPid());
    expect(removable(dir, [], 2).map((release) => path.basename(release))).toEqual(['two']);
  });

  it('leaves alone a folder that is not a finished release', () => {
    const { dir } = releases(['one', 'two', 'three']);
    fs.mkdirSync(path.join(dir, 'half-built'));
    expect(removable(dir, [], 2).map((release) => path.basename(release))).toEqual(['one']);
  });
});
