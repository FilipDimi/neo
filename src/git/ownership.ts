/**
 * Ownership: the files or folders a task may change. Entries are directory prefixes or exact
 * files, relative to the repository. An empty list owns everything.
 */
const tidy = (entry: string): string => entry.replace(/^\.\//, '').replace(/\/+$/, '');
const within = (file: string, owner: string): boolean => file === owner || file.startsWith(`${owner}/`);

export function owns(ownership: string[], file: string): boolean {
  return ownership.length === 0 || ownership.some((owner) => within(tidy(file), tidy(owner)));
}

/** True when one task could change a file the other owns: one entry is a path prefix of the other. */
export function overlaps(a: string[], b: string[]): boolean {
  if (a.length === 0 || b.length === 0) return true;
  return a.some((x) => b.some((y) => within(tidy(x), tidy(y)) || within(tidy(y), tidy(x))));
}

export function outside(files: string[], ownership: string[]): string[] {
  return files.filter((file) => !owns(ownership, file));
}
