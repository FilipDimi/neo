import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { inUse, markRunning, removable } from '../src/release.ts';
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
