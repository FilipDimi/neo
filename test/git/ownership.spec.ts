import { describe, expect, it } from 'vitest';
import { outside, overlaps, owns, unusable } from '../../src/git/ownership.ts';

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

  it('reads a folder written as a pattern as that folder', () => {
    expect(owns(['src/api/**'], 'src/api/routes.ts')).toBe(true);
    expect(owns(['src/api/*', './web/'], 'web/index.html')).toBe(true);
    expect(owns(['src/api/**'], 'src/apix/routes.ts')).toBe(false);
    expect(overlaps(['src/api/**'], ['src/api/routes.ts'])).toBe(true);
  });

  it('says which entries name no file or folder it can hold anyone to', () => {
    expect(unusable(['src/api', 'README.md', 'src/api/**', './docs/'])).toEqual([]);
    expect(unusable(['src/*.ts', '/etc/hosts', '../other', '.', '', 'src/**/test'])).toEqual(['src/*.ts', '/etc/hosts', '../other', '.', '', 'src/**/test']);
  });
});
