import fs from 'node:fs';
import path from 'node:path';

/**
 * Where a path really leads: every link on the way followed, whether or not anything exists at
 * the end of it. A link to a file that is not there yet is still a way out of a folder, so
 * nothing here asks the file system to follow a link for us. Null for a chain that never ends.
 */
export function leadsTo(file: string): string | null {
  let rest = path.resolve(file).split(path.sep).filter(Boolean);
  let current: string = path.sep;
  let hops = 0;
  while (rest.length > 0) {
    const next = path.join(current, rest.shift()!);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(next);
    } catch {
      return path.join(next, ...rest); // Nothing is here, so nothing below it can be a link.
    }
    if (!stat.isSymbolicLink()) current = next;
    else {
      if (++hops > 40) return null;
      rest = [...path.resolve(current, fs.readlinkSync(next)).split(path.sep).filter(Boolean), ...rest];
      current = path.sep;
    }
  }
  return current;
}
