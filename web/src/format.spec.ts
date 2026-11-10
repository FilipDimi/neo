import { describe, expect, it } from 'vitest';
import { clock, initials, money } from './format.ts';

describe('format', () => {
  it('formats money, the clock and initials as the artboards do', () => {
    expect(money(14.2)).toBe('$14.20');
    expect(money(0.4)).toBe('$0.40');
    expect(money(40, true)).toBe('$40');
    expect(money(2.5, true)).toBe('$2.50');
    expect(clock(new Date(2026, 10, 9, 18, 40))).toBe('Mon 18:40');
    expect(initials('Ada Lovelace')).toBe('AL');
    expect(initials('MO')).toBe('MO');
    expect(initials('iOS lead')).toBe('IL');
    expect(initials('neo')).toBe('NE');
  });
});
