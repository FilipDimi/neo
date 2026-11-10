import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { availableCapabilities, CAPABILITIES, grantKey, judgeToolCall, sessionShape } from '../../src/supervisor/blastRadius.ts';
import { company, employee, task, team, tempDir } from '../helpers.ts';

const folder = tempDir();
const ctx = (over = {}) => ({ task: task(), team: team(), employee: employee(), mode: 'work' as const, folder, company: company(), grants: [], ...over });
const call = (tool: string, input: unknown) => ({ id: 'toolu-1', tool, input });

describe('capabilities', () => {
  it('maps capabilities to tools, and two of them to no tool at all', () => {
    expect(CAPABILITIES.read_files.tools).toEqual(['Read', 'Glob', 'Grep']);
    expect(CAPABILITIES.run_commands.tools).toEqual(['Bash']);
    expect(CAPABILITIES.write_code.tools).toEqual(['Write', 'Edit']);
    expect(CAPABILITIES.git_push.tools).toEqual([]);
    expect(CAPABILITIES.send_messages.tools).toEqual([]);
  });

  it('offers git_push only on a team that may push, and never send_messages', () => {
    expect(availableCapabilities(team())).toEqual(['read_files', 'run_commands', 'write_code', 'web_search']);
    expect(availableCapabilities(team({ mayPush: true, maySend: true }))).toEqual(['read_files', 'run_commands', 'write_code', 'web_search', 'git_push']);
  });
});

describe('sessionShape', () => {
  const coder = employee({ capabilities: ['read_files', 'run_commands', 'write_code'], skills: ['dataviz'] });

  it('gives a working employee its tools, the Skill tool and a sandbox that fails closed', () => {
    const shape = sessionShape({ ...ctx({ employee: coder, team: team({ sandboxWrite: ['~/Library/Caches'] }) }), envFiles: ['/repo/backend/.env'] });
    expect(shape.tools).toEqual(['Read', 'Glob', 'Grep', 'Bash', 'Write', 'Edit', 'Skill']);
    expect(shape.sandbox).toMatchObject({ enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false });
    expect(shape.sandbox!.filesystem!.allowWrite).toEqual([path.join(os.homedir(), 'Library/Caches')]);
    expect(shape.sandbox!.filesystem!.denyRead).toContain('/repo/backend/.env');
    expect(shape.sandbox!.filesystem!.denyRead).toContain(path.join(os.homedir(), '.ssh'));
    expect(shape.additionalDirectories).toEqual([coder.memoryDir]);
  });

  it('resolves the per-user system folders of the Xcode build profile', () => {
    const shape = sessionShape({ ...ctx({ employee: coder, team: team({ sandboxWrite: ['$DARWIN_USER_TEMP_DIR', '$DARWIN_USER_CACHE_DIR'] }) }), envFiles: [] });
    const [temp, cache] = shape.sandbox!.filesystem!.allowWrite!;
    const expected = execFileSync('getconf', ['DARWIN_USER_TEMP_DIR'], { encoding: 'utf8' }).trim();
    expect(`${temp}/`).toBe(expected);
    expect(cache).toMatch(/^\/.+\/C$/);
  });

  it("keeps commands out of the folder's git directory and away from the engine's own files", () => {
    const shape = sessionShape({ ...ctx({ employee: coder, protect: ['/data/vs/token'] }), envFiles: [] });
    expect(shape.sandbox!.filesystem!.denyWrite).toEqual([path.join(folder, '.git')]);
    expect(shape.sandbox!.filesystem!.denyRead).toContain('/data/vs/token');
    expect(shape.sandbox!.filesystem!.denyRead).toContain(path.join(os.homedir(), '.git-credentials'));
  });

  it('drops write and command tools in review and route modes', () => {
    expect(sessionShape({ ...ctx({ employee: coder, mode: 'review' }), envFiles: [] }).tools).toEqual(['Read', 'Glob', 'Grep', 'Skill']);
    expect(sessionShape({ ...ctx({ employee: coder, mode: 'route' }), envFiles: [] }).tools).toEqual(['Read', 'Glob', 'Grep', 'Skill']);
    expect(sessionShape({ ...ctx({ employee: coder, mode: 'review' }), envFiles: [] }).sandbox).toBeUndefined();
  });
});

describe('judgeToolCall', () => {
  it("allows the engine's own tools always", () => {
    expect(judgeToolCall(ctx({ mode: 'review' }), call('mcp__engine__submit_review', {}))).toEqual({ allow: true });
  });

  it('allows a write inside the folder', () => {
    expect(judgeToolCall(ctx(), call('Write', { file_path: path.join(folder, 'src/a.ts'), content: 'x' }))).toEqual({ allow: true });
    expect(judgeToolCall(ctx(), call('Edit', { file_path: 'src/a.ts', old_string: 'a', new_string: 'b' }))).toEqual({ allow: true });
  });

  it('refuses a write outside the folder with a card, and stops the run', () => {
    const verdict = judgeToolCall(ctx(), call('Write', { file_path: '/etc/hosts', content: 'x' }));
    expect(verdict).toMatchObject({ allow: false, stop: true });
    expect(verdict.card).toContain('/etc/hosts');
    expect(judgeToolCall(ctx(), call('Write', { file_path: path.join(folder, '../escape.txt'), content: 'x' }))).toMatchObject({ allow: false, stop: true });
  });

  it('refuses a write through a link that leads out of the folder', () => {
    const outside = tempDir();
    fs.symlinkSync(outside, path.join(folder, 'way-out'));
    expect(judgeToolCall(ctx(), call('Write', { file_path: path.join(folder, 'way-out/x.txt'), content: 'x' }))).toMatchObject({ allow: false, stop: true });
  });

  it('refuses a write through a link to a file that does not exist yet, however long the chain', () => {
    const outside = tempDir();
    fs.symlinkSync(path.join(outside, 'new.plist'), path.join(folder, 'notes.plist'));
    fs.symlinkSync(path.join(folder, 'notes.plist'), path.join(folder, 'again.plist'));
    fs.symlinkSync('../'.repeat(12) + 'etc/new-file', path.join(folder, 'relative.txt'));
    for (const file of ['notes.plist', 'again.plist', 'relative.txt']) {
      const verdict = judgeToolCall(ctx(), call('Write', { file_path: path.join(folder, file), content: 'x' }));
      expect(verdict, file).toMatchObject({ allow: false, stop: true });
    }
    expect(fs.existsSync(path.join(outside, 'new.plist'))).toBe(false);
    // A link that stays inside the folder is an ordinary file.
    fs.mkdirSync(path.join(folder, 'src'), { recursive: true });
    fs.symlinkSync(path.join(folder, 'src/real.ts'), path.join(folder, 'alias.ts'));
    expect(judgeToolCall(ctx(), call('Write', { file_path: path.join(folder, 'alias.ts'), content: 'x' }))).toEqual({ allow: true });
  });

  it('refuses a link that leads round in a circle', () => {
    fs.symlinkSync(path.join(folder, 'loop-b'), path.join(folder, 'loop-a'));
    fs.symlinkSync(path.join(folder, 'loop-a'), path.join(folder, 'loop-b'));
    expect(judgeToolCall(ctx(), call('Write', { file_path: path.join(folder, 'loop-a/x'), content: 'x' }))).toMatchObject({ allow: false, stop: true });
  });

  it("refuses a write into a git directory: git's hooks and settings are the engine's", () => {
    for (const file of ['.git/config', '.git/hooks/pre-commit', '.git/commondir', '.GIT/config', '.git', 'vendor/lib/.git/config']) {
      const verdict = judgeToolCall(ctx(), call('Write', { file_path: path.join(folder, file), content: 'x' }));
      expect(verdict, file).toMatchObject({ allow: false, stop: true });
      expect(verdict.card, file).toMatch(/git/);
    }
    for (const file of ['.gitignore', '.github/workflows/ci.yml', 'docs/git.md']) expect(judgeToolCall(ctx(), call('Edit', { file_path: path.join(folder, file), old_string: 'a', new_string: 'b' })), file).toEqual({ allow: true });
  });

  it("refuses a write outside the task's ownership with a card", () => {
    const owned = ctx({ task: task({ ownership: ['src/api'] }) });
    expect(judgeToolCall(owned, call('Write', { file_path: path.join(folder, 'src/api/routes.ts'), content: 'x' }))).toEqual({ allow: true });
    const verdict = judgeToolCall(owned, call('Write', { file_path: path.join(folder, 'src/ui/page.ts'), content: 'x' }));
    expect(verdict).toMatchObject({ allow: false, stop: true });
    expect(verdict.card).toContain('src/ui/page.ts');
  });

  it('refuses reading a secret without stopping the run', () => {
    const home = os.homedir();
    for (const file of [path.join(home, '.ssh/id_ed25519'), '/Users/x/project/.env', path.join(folder, 'backend/.env.local'), path.join(home, '.claude.json')]) {
      const verdict = judgeToolCall(ctx(), call('Read', { file_path: file }));
      expect(verdict, file).toMatchObject({ allow: false });
      expect(verdict.stop, file).toBeUndefined();
      expect(verdict.card, file).toBeUndefined();
    }
    expect(judgeToolCall(ctx({ company: company({ denyRead: ['/srv/private'] }) }), call('Grep', { pattern: 'x', path: '/srv/private/notes' }))).toMatchObject({ allow: false });
  });

  it('refuses reading a secret however its path is spelled', () => {
    const secret = tempDir();
    fs.writeFileSync(path.join(secret, 'key'), 'k');
    fs.symlinkSync(secret, path.join(folder, 'docs-link'));
    fs.symlinkSync(path.join(secret, 'key'), path.join(folder, 'README.link'));
    const guarded = ctx({ company: company({ denyRead: [secret] }) });
    const spellings = [path.join(secret, 'key'), `${secret.toUpperCase()}/key`, path.join(folder, 'docs-link/key'), path.join(folder, 'README.link'), `/System/Volumes/Data${secret}/key`, `${secret}/../${path.basename(secret)}/key`];
    for (const file of spellings) expect(judgeToolCall(guarded, call('Read', { file_path: file })), file).toMatchObject({ allow: false });
    for (const file of ['.ENV', 'backend/.Env.local', '.env.PRODUCTION']) expect(judgeToolCall(ctx(), call('Read', { file_path: path.join(folder, file) })), file).toMatchObject({ allow: false });
  });

  it("never reads the engine's own token and database, or the usual credential files", () => {
    const home = os.homedir();
    const engine = ctx({ protect: ['/data/vs/token', '/data/vs/company.db', '/data/vs/company.db-wal'] });
    for (const file of ['/data/vs/token', '/data/vs/company.db', '/data/vs/company.db-wal', path.join(home, '.git-credentials'), path.join(home, '.npmrc'), path.join(home, '.config/gh/hosts.yml'), path.join(home, '.cargo/credentials.toml'), path.join(home, 'Library/Keychains/login.keychain-db')]) {
      const verdict = judgeToolCall(engine, call('Read', { file_path: file }));
      expect(verdict, file).toMatchObject({ allow: false });
      expect(verdict.stop, file).toBeUndefined();
    }
  });

  it('searches only inside the task folder and the memory folder', () => {
    const worker = employee({ memoryDir: tempDir() });
    const here = ctx({ employee: worker });
    for (const input of [{ pattern: 'TODO' }, { pattern: 'TODO', path: path.join(folder, 'src') }, { pattern: 'TODO', path: 'src' }, { pattern: 'note', path: worker.memoryDir }]) expect(judgeToolCall(here, call('Grep', input)), JSON.stringify(input)).toEqual({ allow: true });
    for (const input of [{ pattern: '**/*.ts' }, { pattern: 'src/**/*.ts', path: folder }]) expect(judgeToolCall(here, call('Glob', input)), JSON.stringify(input)).toEqual({ allow: true });

    const outside = tempDir();
    fs.symlinkSync(outside, path.join(folder, 'way-out-search'));
    const refused = [
      ['Grep', { pattern: 'KEY', path: os.homedir() }],
      ['Grep', { pattern: 'KEY', path: '/' }],
      ['Grep', { pattern: 'KEY', path: path.dirname(folder) }],
      ['Grep', { pattern: 'KEY', path: path.join(folder, 'way-out-search') }],
      ['Glob', { pattern: '**/.env*', path: os.homedir() }],
      ['Glob', { pattern: `${os.homedir()}/**/.env` }],
      ['Glob', { pattern: '../../**/*' }],
    ] as const;
    for (const [tool, input] of refused) {
      const verdict = judgeToolCall(here, call(tool, input));
      expect(verdict, JSON.stringify(input)).toMatchObject({ allow: false });
      expect(verdict.stop, JSON.stringify(input)).toBeUndefined();
    }
  });

  it('allows ordinary reads, inside the folder and out, and an example env file', () => {
    expect(judgeToolCall(ctx(), call('Read', { file_path: path.join(folder, 'README.md') }))).toEqual({ allow: true });
    expect(judgeToolCall(ctx(), call('Read', { file_path: '/usr/include/stdio.h' }))).toEqual({ allow: true });
    expect(judgeToolCall(ctx(), call('Read', { file_path: path.join(folder, '.env.example') }))).toEqual({ allow: true });
    expect(judgeToolCall(ctx(), call('Glob', { pattern: '**/*.ts' }))).toEqual({ allow: true });
  });

  it('allows a command without judging its text: the sandbox confines it', () => {
    expect(judgeToolCall(ctx(), call('Bash', { command: 'git push --force origin main' }))).toEqual({ allow: true });
  });

  it('refuses a tool the engine does not know, with a card', () => {
    expect(judgeToolCall(ctx(), call('SendEmail', { to: 'x' }))).toMatchObject({ allow: false, stop: true, card: expect.stringContaining('SendEmail') });
  });

  it('uses a grant once, for exactly the refused target', () => {
    const target = call('Write', { file_path: '/etc/hosts', content: 'first try' });
    const grant = { id: 'g1', taskId: 'task1', tool: 'Write', inputHash: grantKey(target, folder), used: false };
    expect(judgeToolCall(ctx({ grants: [grant] }), call('Write', { file_path: '/etc/hosts', content: 'second try' }))).toEqual({ allow: true, useGrant: 'g1' });
    expect(judgeToolCall(ctx({ grants: [{ ...grant, used: true }] }), target)).toMatchObject({ allow: false });
    expect(judgeToolCall(ctx({ grants: [grant] }), call('Write', { file_path: '/etc/passwd', content: 'x' }))).toMatchObject({ allow: false });
  });
});
