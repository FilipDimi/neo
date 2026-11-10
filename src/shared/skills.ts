/**
 * Skills come in sets. A plugin installs a dozen at once, and a family such as `gsd` is sixty
 * skills that only make sense together. Nobody picks those one by one, and no employee loads
 * sixty skills before it starts. So skills that share a name are a set: chosen with one tick,
 * shown as one line, and offered to the employee to draw on rather than loaded whole.
 */
export type SkillSet = { name: string; ids: string[] };

/** How many skills must share a name before they are a set. Two that happen to start alike are not one. */
export const SET_SIZE = 3;

/**
 * The name a skill shares with its relatives: the plugin it came with (`superpowers:brainstorming`
 * is in `superpowers`), or else the first word of its own name (`user:gsd-add-phase` is in `gsd`).
 */
export function setNameOf(id: string): string {
  const [source, ...rest] = id.split(':');
  const own = rest.length > 0 && source !== 'user' && source !== 'company';
  return own ? source! : (rest.length > 0 ? rest.join(':') : source!).split('-')[0]!;
}

/** Splits a list of skills into its sets and the skills that stand alone, each in the order first met. */
export function skillSets(ids: string[]): { sets: SkillSet[]; singles: string[] } {
  const byName = new Map<string, string[]>();
  for (const id of ids) byName.set(setNameOf(id), [...(byName.get(setNameOf(id)) ?? []), id]);
  const sets = [...byName].filter(([, members]) => members.length >= SET_SIZE).map(([name, members]) => ({ name, ids: members }));
  const inSet = new Set(sets.flatMap((set) => set.ids));
  return { sets, singles: ids.filter((id) => !inSet.has(id)) };
}

/** A list of skills in a few words: each set once with its size, then the ones that stand alone. */
export function skillsInBrief(ids: string[]): string {
  const { sets, singles } = skillSets(ids);
  return [...sets.map((set) => `${set.name} (${set.ids.length})`), ...singles].join(', ');
}
