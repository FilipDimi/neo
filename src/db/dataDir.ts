import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Where a company lives: the database, the token, task folders, memory, mounted skills, logs.
 * Outside the product's repository and outside the user's repositories. One company per directory.
 */
export function dataDir(env: Record<string, string | undefined> = process.env, create = true): string {
  const dir = env.VS_DATA_DIR ?? path.join(env.HOME ?? os.homedir(), '.virtual-startup');
  if (create) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
  }
  return dir;
}

export type Paths = ReturnType<typeof paths>;

export function paths(dir: string) {
  return {
    db: path.join(dir, 'company.db'),
    token: path.join(dir, 'token'),
    folders: path.join(dir, 'folders'),
    memory: path.join(dir, 'memory'),
    mounts: path.join(dir, 'mounts'),
    skills: path.join(dir, 'skills'),
    logs: path.join(dir, 'logs'),
  };
}
