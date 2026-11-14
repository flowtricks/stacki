// How custom property names are sectioned by a shared leading part: the one rule the Variables
// panel (electron/project/cssVarModel.ts) and the variable picker both use, so the picker shows
// the panel's groups, in the panel's order, and they cannot disagree. Pure: names in, sections out.

// Names sharing a leading part, where that part is not itself a variable:
// `--selection-background` and `--selection-text` belong to the selection,
// while `--background` and `--background-2` do not belong to a background —
// there is one, and it is a variable in its own right.
//
// The longest shared start wins, so `--button-2-*` is its own thing rather than
// six more rows of `--button-*`.
export function prefixSections(names: readonly string[]): {
  loose: string[];
  sections: Map<string, string[]>;
} {
  const nameSet = new Set(names);
  const counts = new Map<string, number>();
  for (const name of names) {
    const body = name.replace(/^--/, '');
    const parts = body.split('-');
    for (let at = 1; at < parts.length; at++) {
      const prefix = parts.slice(0, at).join('-');
      if (nameSet.has(`--${prefix}`)) {
        continue;
      }
      counts.set(prefix, (counts.get(prefix) || 0) + 1);
    }
  }

  const qualifies = (prefix: string): boolean => (counts.get(prefix) || 0) >= 2;
  const assigned = new Map<string, string[]>(); // prefix -> [names]
  const loose: string[] = [];
  for (const name of names) {
    const body = name.replace(/^--/, '');
    const parts = body.split('-');
    let chosen: string | undefined = undefined;
    for (let at = 1; at < parts.length; at++) {
      const prefix = parts.slice(0, at).join('-');
      if (qualifies(prefix)) {
        chosen = prefix;
      }
    }
    if (!chosen) {
      loose.push(name);
      continue;
    }
    const group = assigned.get(chosen);
    if (group) {
      group.push(name);
    } else {
      assigned.set(chosen, [name]);
    }
  }

  // A section of one is not a section — those names go back in the main list,
  // in the place they were declared.
  const sections = new Map<string, string[]>();
  const orphans = new Set<string>();
  for (const [prefix, group] of assigned) {
    if (group.length >= 2) {
      sections.set(prefix, group);
    } else {
      group.forEach((name) => orphans.add(name));
    }
  }
  const mainList = names.filter((name) => loose.includes(name) || orphans.has(name));
  return { loose: mainList, sections };
}

/** A variable's name under its group: `--button-text` under `button` is `text`. */
export const shortLabel = (name: string, prefix?: string): string => {
  const body = name.replace(/^--/, '');
  return prefix && body.startsWith(`${prefix}-`) ? body.slice(prefix.length + 1) : body;
};

/** One run of rows under a heading (or none, for the ungrouped run), in the panel's order. */
export interface NameBlock {
  readonly title: string | undefined;
  readonly names: readonly string[];
}

/**
 * The blocks the panel draws for a scope's `names` (source order, with `--`): the ungrouped run
 * first, then each prefix section. `shown` narrows the rows (a search, a validity filter) without
 * changing the grouping: a block with no row left is dropped, a row keeps its section. When no
 * name forms a section the result is one untitled block holding `shown` names in the order given,
 * so a scope the panel does not group is listed as before.
 */
export function arrangeNames(names: readonly string[], shown: ReadonlySet<string>): readonly NameBlock[] {
  const { loose, sections } = prefixSections(names);
  if (sections.size === 0) {
    return [{ title: undefined, names: names.filter((name) => shown.has(name)) }].filter((block) => block.names.length > 0);
  }
  const blocks: NameBlock[] = [{ title: undefined, names: loose.filter((name) => shown.has(name)) }];
  for (const [prefix, members] of sections) {
    blocks.push({ title: prefix, names: members.filter((name) => shown.has(name)) });
  }
  return blocks.filter((block) => block.names.length > 0);
}
