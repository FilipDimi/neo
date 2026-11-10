import { describe, expect, it } from 'vitest';
import { outside, overlaps, owns } from '../../src/git/ownership.ts';

describe('ownership', () => {
  it('treats src/api and src/api/routes.ts as overlapping, and src/api and src/apiary as separate', () => {
    expect(overlaps(['src/api'], ['src/api/routes.ts'])).toBe(true);
    expect(overlaps(['src/api/routes.ts'], ['src/api/'])).toBe(true);
    expect(overlaps(['src/api'], ['src/apiary'])).toBe(false);
    expect(overlaps(['docs', 'src/a.ts'], ['src/b.ts', 'test'])).toBe(false);
    expect(overlaps(['src/a.ts'], ['./src/a.ts'])).toBe(true);
  });

  it('an empty ownership owns everything, so it overlaps anything', () => {
    expect(overlaps([], ['src'])).toBe(true);
    expect(owns([], 'anything/at/all.ts')).toBe(true);
  });

  it("lists the changed files outside a task's ownership", () => {
    expect(outside(['src/api/routes.ts', 'src/apiary/x.ts', 'README.md', 'docs/a/b.md'], ['src/api', 'docs/'])).toEqual(['src/apiary/x.ts', 'README.md']);
    expect(outside(['a.ts'], [])).toEqual([]);
  });
});
