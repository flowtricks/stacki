// Which of a component's props hold a list's settings: a component whose loop
// reads `"filter": propFilters` takes its filters from its `filters` prop, so
// a page using it sets them there. The page's props panel draws such a prop
// with the loop's own Filters or Sort editor, over the component's collection,
// instead of as a field of code (ListPropField.tsx).
//
// Read from the component file's frontmatter, imports included: each top-level
// declaration that is an options call (optionsQuery.ts) names the collection
// and, for each setting a prop holds, that prop.

import { assert } from '../../shared/core/assert';
import type { LoopSource } from './loopQuery';
import { parseFrontmatter, parseModule } from './loopSyntax';
import { LOOP_SETTINGS, readOptionsQuery, type LoopSetting } from './optionsQuery';

export interface ListProp {
  readonly setting: LoopSetting;
  /** The collection the list reads, whose fields the editor offers. */
  readonly source: LoopSource;
  /** The component's own default, shown while a page passes nothing. */
  readonly defaultCode: string;
}

/** The props holding list settings, by prop name. */
export function listPropsOf(componentFrontmatter: string): ReadonlyMap<string, ListProp> {
  const module = parseModule(componentFrontmatter);
  const frontmatter = parseFrontmatter(componentFrontmatter);
  const importedFrom = (local: string, spec: string): string | undefined =>
    module.imports.find((entry) => entry.name === local && entry.path === spec)?.imported;
  const found = new Map<string, ListProp>();
  for (const declaration of frontmatter.declarations.values()) {
    const read =
      declaration.init === undefined
        ? undefined
        : readOptionsQuery(declaration.init, { frontmatter, importedFrom });
    if (read === undefined) {
      continue;
    }
    for (const setting of LOOP_SETTINGS) {
      const home = read.home.settings[setting];
      // The first list to read a prop decides what it is; a second reading
      // the same prop for another setting would be a component bug, not ours.
      if (home.kind === 'prop' && !found.has(home.key)) {
        const defaultCode = componentFrontmatter.slice(home.literal.from, home.literal.to);
        assert(defaultCode.length > 0, 'A list prop has a default');
        found.set(home.key, { setting, source: read.query.source, defaultCode });
      }
    }
  }
  assert(
    found.size <= LOOP_SETTINGS.length * frontmatter.declarations.size,
    'List props are bounded by the lists',
  );
  return found;
}
