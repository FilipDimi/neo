import { describe, expect, it } from 'vitest';
import { setNameOf, skillSets, skillsInBrief } from '../../src/shared/skills.ts';

const gsd = ['user:gsd-add-backlog', 'user:gsd-add-phase', 'user:gsd-add-tests', 'user:gsd-plan-phase'];
const superpowers = ['superpowers:brainstorming', 'superpowers:executing-plans', 'superpowers:writing-plans'];

describe('skills that share a name are a set', () => {
  it('names a skill after its plugin, or after the first word of its own name', () => {
    expect(setNameOf('superpowers:brainstorming')).toBe('superpowers');
    expect(setNameOf('apple-skills:app-store')).toBe('apple-skills');
    expect(setNameOf('user:gsd-add-phase')).toBe('gsd');
    expect(setNameOf('company:privacy-rules')).toBe('privacy');
    expect(setNameOf('dataviz')).toBe('dataviz');
    expect(setNameOf('code-review')).toBe('code');
  });

  it('makes a set of three or more, and leaves the rest standing alone, in the order they came', () => {
    const { sets, singles } = skillSets(['user:rust-skills', ...gsd, 'dataviz', ...superpowers, 'user:supabase', 'user:supabase-postgres-best-practices']);
    expect(sets).toEqual([
      { name: 'gsd', ids: gsd },
      { name: 'superpowers', ids: superpowers },
    ]);
    // Two that start alike are not a set.
    expect(singles).toEqual(['user:rust-skills', 'dataviz', 'user:supabase', 'user:supabase-postgres-best-practices']);
  });

  it('says a long list in a few words', () => {
    expect(skillsInBrief(['user:rust-skills', ...gsd, 'dataviz'])).toBe('gsd (4), user:rust-skills, dataviz');
    expect(skillsInBrief([])).toBe('');
  });
});
