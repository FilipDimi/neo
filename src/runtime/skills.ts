/**
 * Skills. A session loads none of the user's settings, so the skills chosen for an employee are
 * mounted for each run as local plugins: a user skill reaches the session as `user:<name>`, a
 * company skill as `company:<name>`, a plugin's skill under the plugin's own name, and a skill
 * bundled with Claude Code under its bare name. (Checked live: docs/spike, section 5.)
 */
import fs from 'node:fs';
import path from 'node:path';

export type SkillRef = { id: string; label: string; description: string; source: 'bundled' | 'user' | 'plugin' | 'company'; path: string | null };
export type SkillDirs = { userSkills: string; pluginCache: string; companySkills: string };

/** Skills that ship inside Claude Code and suit an employee. They need no mounting. */
const BUNDLED: [string, string][] = [
  ['dataviz', 'Charts and data visualisation that read as one system.'],
  ['deep-research', 'Research across many sources, written up as a report.'],
  ['code-review', 'Reviews a diff for correctness bugs.'],
  ['simplify', 'Reviews changed code for reuse and simplification, then applies the fixes.'],
  ['debug', 'Systematic debugging.'],
  ['verify', 'Verifies that a change really works before calling it done.'],
  ['claude-api', 'Reference for the Claude API and the Agent SDK.'],
];

function frontMatter(file: string): { name?: string; description?: string } {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8').slice(0, 4000);
  } catch {
    return {};
  }
  const block = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? '';
  const field = (key: string) => new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(block)?.[1]?.trim().replace(/^["']|["']$/g, '');
  return { name: field('name'), description: field('description') };
}

const dirsIn = (dir: string): string[] => {
  try {
    return fs.readdirSync(dir).filter((name) => !name.startsWith('.') && fs.statSync(path.join(dir, name)).isDirectory());
  } catch {
    return [];
  }
};

function skillsIn(dir: string, prefix: string, source: SkillRef['source'], mountPath?: string): SkillRef[] {
  return dirsIn(dir).flatMap((name) => {
    const file = path.join(dir, name, 'SKILL.md');
    if (!fs.existsSync(file)) return [];
    const front = frontMatter(file);
    // Claude Code names a plugin's skill by its front matter; a mounted folder is named by the folder.
    const label = source === 'plugin' ? (front.name ?? name) : name;
    return [{ id: `${prefix}:${label}`, label, description: front.description ?? '', source, path: mountPath ?? path.join(dir, name) }];
  });
}

/** Every skill an employee could be given: bundled, the user's own, installed plugins', and the company's folder. */
export function listSkills(dirs: SkillDirs): SkillRef[] {
  const bundled = BUNDLED.map(([id, description]): SkillRef => ({ id, label: id, description, source: 'bundled', path: null }));
  const plugins = dirsIn(dirs.pluginCache).flatMap((marketplace) =>
    dirsIn(path.join(dirs.pluginCache, marketplace)).flatMap((plugin) => {
      const base = path.join(dirs.pluginCache, marketplace, plugin);
      // Several versions may be cached; the one last installed is the one in use.
      const versions = dirsIn(base).filter((version) => fs.existsSync(path.join(base, version, 'skills')));
      const newest = versions.sort((a, b) => fs.statSync(path.join(base, b)).mtimeMs - fs.statSync(path.join(base, a)).mtimeMs)[0];
      return newest ? skillsIn(path.join(base, newest, 'skills'), plugin, 'plugin', path.join(base, newest)) : [];
    }),
  );
  return [...bundled, ...skillsIn(dirs.userSkills, 'user', 'user'), ...plugins, ...skillsIn(dirs.companySkills, 'company', 'company')];
}

/** Builds the mounts for one employee's chosen skills and returns the session's `plugins` and `skills`. */
export function mountSkills(refs: SkillRef[], mountDir: string): { plugins: string[]; skills: string[] } {
  const plugins: string[] = [];
  for (const source of ['user', 'company'] as const) {
    const dir = path.join(mountDir, source);
    fs.rmSync(dir, { recursive: true, force: true });
    const chosen = refs.filter((ref) => ref.source === source && ref.path);
    if (chosen.length === 0) continue;
    fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: source, version: '1.0.0', description: `Skills from the ${source === 'user' ? "user's" : "company's"} folder, mounted for one employee.` }));
    fs.mkdirSync(path.join(dir, 'skills'));
    for (const ref of chosen) fs.symlinkSync(ref.path!, path.join(dir, 'skills', ref.label));
    plugins.push(dir);
  }
  for (const ref of refs) if (ref.source === 'plugin' && ref.path && !plugins.includes(ref.path)) plugins.push(ref.path);
  return { plugins, skills: refs.map((ref) => ref.id) };
}
