export { ago } from '../../src/shared/view.ts';

/** Money as the engine reports it: dollars at list prices. `short` drops ".00" for round caps ("of $40"). */
export function money(usd: number, short = false): string {
  return short && Number.isInteger(usd) ? `$${usd}` : `$${usd.toFixed(2)}`;
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function clock(now: Date): string {
  return `${DAYS[now.getDay()]} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
}

/** Two letters for a name tag: the initials of two words, or the first two letters of one. */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/);
  const letters = words.length > 1 ? `${words[0]![0]}${words[1]![0]}` : name.trim().slice(0, 2);
  return letters.toUpperCase();
}
