/**
 * Ownership: the files or folders a task may change. Entries are directory prefixes or exact
 * files, relative to the repository. An empty list owns everything.
 */
// A folder is often written the way a pattern for it would be: "src/api/**" and "src/api/*" mean src/api.
const tidy = (entry: string): string =>
  entry
    .trim()
    .replace(/^\.\//, '')
    .replace(/\/\*{1,2}$/, '')
    .replace(/\/+$/, '');
const within = (file: string, owner: string): boolean => file === owner || file.startsWith(`${owner}/`);

export function owns(ownership: string[], file: string): boolean {
  return ownership.length === 0 || ownership.some((owner) => within(tidy(file), tidy(owner)));
}

/** True when one task could change a file the other owns: one entry is a path prefix of the other. */
export function overlaps(a: string[], b: string[]): boolean {
  if (a.length === 0 || b.length === 0) return true;
  return a.some((x) => b.some((y) => within(tidy(x), tidy(y)) || within(tidy(y), tidy(x))));
}

/**
 * The entries that name nothing a task can be held to: a pattern (only a file or a folder is understood), a path that
 * starts at the root of the disk or climbs out of the repository, or nothing at all. Such an entry would own no file,
 * and every write of the task would be refused.
 */
export function unusable(ownership: string[]): string[] {
  return ownership.filter((entry) => {
    const plain = tidy(entry);
    return plain === '' || plain === '.' || plain.startsWith('/') || /[*?[\]]/.test(plain) || plain.split('/').includes('..');
  });
}

export function outside(files: string[], ownership: string[]): string[] {
  return files.filter((file) => !owns(ownership, file));
}
