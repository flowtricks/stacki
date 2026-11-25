import { assert } from '../../../../shared/core/assert';
import type { NameBlock } from '../../../../shared/properties/variableGroups';
import type { VariablesSnapshot } from '../../../ipc/variablesBridge';
import { declarationTextBefore } from './codeVariableScope';
import type { ProjectVariable } from './webflow';

// The variable chooser's list where a custom property's value is being written (`--x: |`): every
// variable of the project, as the Variables panel shows them. A custom property takes any value, so
// nothing is filtered by type or by what reaches an element; the list is the panel's own, read from
// the panel's snapshot (variablesBridge.ts, already grouped and ordered by the panel's model,
// electron/project/cssVarModel.ts): its files in order, each rule group in order, each heading's
// block in order, each row's variables in the panel's column order. The picker then draws exactly
// those blocks (VariablePicker.tsx, `panel`), and leaves out the names hidden in the panel.
//
// The variable being declared is left out too: `--x: var(--x)` is a cycle, never a choice.

/** The most variables one listing holds; past it the rest of the project is not offered. */
export const PANEL_LISTING_MAX = 4_096;

/** The panel's variables in its order, and its blocks for each file's rule group. */
export interface PanelListing {
  readonly variables: readonly ProjectVariable[];
  /** Keyed by `panelBlockKey(collection, group)`: the headings and names in the panel's order. */
  readonly blocks: ReadonlyMap<string, readonly NameBlock[]>;
}

/** The key of one file's rule group in `PanelListing.blocks`. */
export function panelBlockKey(collection: string, group: string): string {
  return `${collection}\u0000${group}`;
}

/**
 * The listing for `snapshot`, leaving out `self` (the custom property being declared, with `--`).
 * `known` lends each variable the type the picker already inferred for it (its glyph and swatch); a
 * name it does not know is a colour when the panel drew a swatch for it, else a size.
 */
export function panelListing(
  snapshot: VariablesSnapshot,
  options: { readonly self: string | undefined; readonly known: readonly ProjectVariable[] },
): PanelListing {
  const typeOf = new Map(options.known.map((variable): [string, string] => [`--${variable.name}`, variable.type]));
  const variables: ProjectVariable[] = [];
  const blocks = new Map<string, NameBlock[]>();
  const seen = new Set<string>();
  // Every loop walks an array the snapshot's parser bounded (VARIABLES_LIMITS), and the listing stops at its own bound.
  for (const file of snapshot.files) {
    if (file.error !== undefined) {
      continue;
    }
    for (const group of file.groups) {
      const key = panelBlockKey(file.name, group.label);
      const held = blocks.get(key) ?? [];
      blocks.set(key, held);
      for (const block of group.blocks) {
        const names: string[] = [];
        for (const row of block.rows) {
          for (const cell of row.cells) {
            if (cell === undefined || cell.name === options.self || variables.length >= PANEL_LISTING_MAX) {
              continue;
            }
            const unique = `${key}\u0000${cell.name}`;
            if (seen.has(unique)) {
              continue;
            }
            seen.add(unique);
            names.push(cell.name);
            variables.push({
              collection: file.name,
              group: group.label,
              name: cell.name.replace(/^--/, ''),
              value: cell.value,
              binding: `var(${cell.name})`,
              type: typeOf.get(cell.name) ?? (cell.color === undefined ? 'Size' : 'Color'),
              file: file.rel,
            });
          }
        }
        if (names.length > 0) {
          held.push({ title: block.title, names });
        }
      }
    }
  }
  assert(variables.length <= PANEL_LISTING_MAX, 'panelListing: the listing is bounded');
  assert(
    options.self === undefined || variables.every((variable) => variable.binding !== `var(${options.self})`),
    'panelListing: the declared variable is never offered to itself',
  );
  return { variables, blocks };
}

/** The custom property declared at `offset` in `text` (`--x` for `--x: |`), or undefined in any other declaration. */
export function declaredPropertyAt(text: string, offset: number): string | undefined {
  assert(offset >= 0, 'declaredPropertyAt: the offset is in the text');
  assert(offset <= text.length, 'declaredPropertyAt: the offset ends in the text');
  // How far back a declaration's start is looked for: a hand-written declaration is shorter.
  const before = text.slice(Math.max(0, offset - 4_096), offset);
  const declaration = declarationTextBefore(before);
  const colon = declaration.indexOf(':');
  if (colon < 0) {
    return undefined;
  }
  const property = declaration.slice(0, colon).trim();
  return /^--[A-Za-z0-9_-]+$/.test(property) ? property : undefined;
}
