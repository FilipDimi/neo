import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { listSkills, mountSkills } from '../../src/runtime/skills.ts';
import { tempDir } from '../helpers.ts';

function skill(dir: string, name: string, description: string, frontName = name): void {
  fs.mkdirSync(path.join(dir, name), { recursive: true });
  fs.writeFileSync(path.join(dir, name, 'SKILL.md'), `---\nname: ${frontName}\ndescription: ${description}\n---\n\nBody.\n`);
}

function installed() {
  const root = tempDir();
  const dirs = { userSkills: path.join(root, 'user-skills'), pluginCache: path.join(root, 'plugin-cache'), companySkills: path.join(root, 'company-skills') };
  skill(dirs.userSkills, 'postgresql', 'PostgreSQL documentation and SQL help.');
  skill(dirs.userSkills, 'rust-skills', 'Rust coding guidelines.');
  fs.mkdirSync(path.join(dirs.userSkills, 'not-a-skill'), { recursive: true });
  skill(dirs.companySkills, 'privacy-rules', 'Keeps the seven answers off every log line.');
  const old = path.join(dirs.pluginCache, 'indie-apple-stack', 'apple-skills', '111111');
  const current = path.join(dirs.pluginCache, 'indie-apple-stack', 'apple-skills', '222222');
  skill(path.join(old, 'skills'), 'swiftui', 'Old SwiftUI skill.');
  skill(path.join(current, 'skills'), 'swiftui', 'SwiftUI framework skills.');
  skill(path.join(current, 'skills'), 'ios-development', 'iOS development guidance.', 'ios');
  fs.utimesSync(old, new Date(2026, 0, 1), new Date(2026, 0, 1));
  return { root, dirs, current };
}

describe('listSkills', () => {
  it('leaves out an installed skill that only a person may start', () => {
    const mine = tempDir();
    const empty = tempDir();
    skill(mine, 'rust-skills', 'Rust rules.');
    fs.mkdirSync(path.join(mine, 'ship-it'), { recursive: true });
    fs.writeFileSync(path.join(mine, 'ship-it', 'SKILL.md'), '---\nname: ship-it\ndescription: Deploys.\ndisable-model-invocation: true\n---\n\nBody.\n');
    const offered = listSkills({ userSkills: mine, pluginCache: empty, companySkills: empty }).map((s) => s.id);
    expect(offered).toContain('user:rust-skills');
    expect(offered).not.toContain('user:ship-it');
  });

  it('still lists the skills beside a link that leads nowhere, and reads a description from a file with Windows line ends', () => {
    const mine = tempDir();
    const empty = tempDir();
    fs.mkdirSync(path.join(mine, 'notes'));
    fs.writeFileSync(path.join(mine, 'notes', 'SKILL.md'), '---\r\nname: notes\r\ndescription: Keeps notes.\r\n---\r\nBody\r\n');
    fs.symlinkSync(path.join(mine, 'gone-away'), path.join(mine, 'broken'));
    const offered = listSkills({ userSkills: mine, pluginCache: empty, companySkills: empty });
    expect(offered.find((skill) => skill.id.endsWith('notes'))).toMatchObject({ description: 'Keeps notes.' });
  });

  it('does not offer deep-research: only a person can start that skill, so an employee given it can only stop', () => {
    const empty = tempDir();
    const offered = listSkills({ userSkills: empty, pluginCache: empty, companySkills: empty }).map((skill) => skill.id);
    expect(offered).not.toContain('deep-research');
    // Checked with a live session on 2026-11-10: these two are refused to a model as well.
    expect(offered).not.toContain('debug');
    expect(offered).not.toContain('verify');
    expect(offered).toEqual(['dataviz', 'code-review', 'simplify', 'claude-api']);
  });

  it('lists bundled, user, plugin and company skills with stable ids and their descriptions', () => {
    const { dirs, current } = installed();
    const skills = listSkills(dirs);
    const byId = Object.fromEntries(skills.map((s) => [s.id, s]));
    expect(byId['dataviz']).toMatchObject({ source: 'bundled', path: null });
    expect(byId['user:postgresql']).toMatchObject({ source: 'user', label: 'postgresql', description: 'PostgreSQL documentation and SQL help.', path: path.join(dirs.userSkills, 'postgresql') });
    expect(byId['company:privacy-rules']).toMatchObject({ source: 'company', description: 'Keeps the seven answers off every log line.' });
    expect(byId['apple-skills:swiftui']).toMatchObject({ source: 'plugin', description: 'SwiftUI framework skills.', path: current });
    expect(byId['apple-skills:ios']).toMatchObject({ source: 'plugin' }); // named by its front matter, as Claude Code names it
    expect(byId['user:not-a-skill']).toBeUndefined();
    expect(skills.filter((s) => s.id === 'apple-skills:swiftui')).toHaveLength(1);
  });

  it('lists only the bundled skills on a machine with nothing installed', () => {
    const root = tempDir();
    const skills = listSkills({ userSkills: path.join(root, 'a'), pluginCache: path.join(root, 'b'), companySkills: path.join(root, 'c') });
    expect(skills.length).toBeGreaterThan(0);
    expect(skills.every((s) => s.source === 'bundled')).toBe(true);
  });
});

describe('mountSkills', () => {
  it('mounts chosen user and company skills as local plugins and returns their session names', () => {
    const { root, dirs } = installed();
    const all = listSkills(dirs);
    const mountDir = path.join(root, 'mounts', 'emp1');
    const mounted = mountSkills(all.filter((s) => ['user:postgresql', 'company:privacy-rules', 'dataviz'].includes(s.id)), mountDir);
    expect(mounted.skills.sort()).toEqual(['company:privacy-rules', 'dataviz', 'user:postgresql']);
    expect(mounted.plugins.sort()).toEqual([path.join(mountDir, 'company'), path.join(mountDir, 'user')]);
    expect(JSON.parse(fs.readFileSync(path.join(mountDir, 'user', '.claude-plugin', 'plugin.json'), 'utf8'))).toMatchObject({ name: 'user' });
    expect(fs.readFileSync(path.join(mountDir, 'user', 'skills', 'postgresql', 'SKILL.md'), 'utf8')).toContain('PostgreSQL');
    expect(fs.existsSync(path.join(mountDir, 'user', 'skills', 'rust-skills'))).toBe(false);
  });

  it("adds a chosen plugin's folder, and lists only its chosen skills", () => {
    const { root, dirs, current } = installed();
    const mounted = mountSkills(listSkills(dirs).filter((s) => s.id === 'apple-skills:swiftui'), path.join(root, 'mounts', 'emp1'));
    expect(mounted).toEqual({ plugins: [current], skills: ['apple-skills:swiftui'] });
  });

  it('rebuilds the mount each time, so a dropped skill disappears', () => {
    const { root, dirs } = installed();
    const all = listSkills(dirs);
    const mountDir = path.join(root, 'mounts', 'emp1');
    mountSkills(all.filter((s) => s.source === 'user'), mountDir);
    const again = mountSkills(all.filter((s) => s.id === 'user:rust-skills'), mountDir);
    expect(fs.readdirSync(path.join(mountDir, 'user', 'skills'))).toEqual(['rust-skills']);
    expect(again.skills).toEqual(['user:rust-skills']);
  });

  it('mounts nothing for an employee with no skills', () => {
    expect(mountSkills([], path.join(tempDir(), 'mounts', 'emp1'))).toEqual({ plugins: [], skills: [] });
  });
});
