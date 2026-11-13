export { ago } from '../../src/shared/view.ts';

/** Money as the engine reports it: dollars at list prices. `short` drops ".00" for round caps ("of $40"). */
export function money(usd: number, short = false): string {
  return short && Number.isInteger(usd) ? `$${usd}` : `$${usd.toFixed(2)}`;
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function clock(now: Date): string {
  return `${DAYS[now.getDay()]} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
}

/** When something ends: the time, with the day when that is not today. "Until 09:00" for a Friday three days off would read as this morning. */
export function untilWhen(until: string, now: Date): string {
  const at = new Date(until);
  const time = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
  return at.toDateString() === now.toDateString() ? time : `${DAYS[at.getDay()]} ${time}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** When something happened: the time, with the weekday when it was in the last six days, and the date alone when it is older. */
export function whenPast(at: string, now: Date): string {
  const then = new Date(at);
  const day = (date: Date): number => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const daysAgo = Math.round((day(now) - day(then)) / 86_400_000);
  if (daysAgo > 6) return `${then.getDate()} ${MONTHS[then.getMonth()]}${then.getFullYear() === now.getFullYear() ? '' : ` ${then.getFullYear()}`}`;
  return untilWhen(at, now);
}

/** Two letters for a name tag: the initials of two words, or the first two letters of one. */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/);
  const letters = words.length > 1 ? `${words[0]![0]}${words[1]![0]}` : name.trim().slice(0, 2);
  return letters.toUpperCase();
}
