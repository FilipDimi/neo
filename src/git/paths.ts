import fs from 'node:fs';
import path from 'node:path';

/**
 * Where a path really leads: every link on the way followed, whether or not anything exists at
 * the end of it. A link to a file that is not there yet is still a way out of a folder, so
 * nothing here asks the file system to follow a link for us. Null for a chain that never ends.
 */
export function leadsTo(file: string): string | null {
  // Nothing is tidied up beforehand: ".." after a link climbs from where the link leads, so each part is taken in turn.
  const parts = (text: string): string[] => text.split(path.sep).filter(Boolean);
  let rest = parts(path.isAbsolute(file) ? file : `${process.cwd()}${path.sep}${file}`);
  let current: string = path.sep;
  let hops = 0;
  while (rest.length > 0) {
    const part = rest.shift()!;
    if (part === '.') continue;
    if (part === '..') {
      current = path.dirname(current);
      continue;
    }
    const next = path.join(current, part);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(next);
    } catch {
      return path.join(next, ...rest); // Nothing is here, so nothing below it can be a link.
    }
    if (!stat.isSymbolicLink()) current = next;
    else {
      if (++hops > 40) return null;
      const target = fs.readlinkSync(next);
      rest = [...(path.isAbsolute(target) ? [] : parts(current)), ...parts(target), ...rest];
      current = path.sep;
    }
  }
  return current;
}
