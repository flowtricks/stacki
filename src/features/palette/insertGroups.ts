import { assert } from '../../../shared/core/assert';
import type { RenderTag } from '../../../shared/properties/projectScan';

// Sections or blocks: the two kinds of component the insert grid separates.
//
// A section is a component that renders a <section> as its root, either directly or through
// the component it opens with (`<Section class="hero">` in a file whose Section opens with
// `<section>`). Everything else is a block: a button, a tag, a form field. The scan gives each
// component its root tag and, when the root is another component, that component's name; this
// file follows the names. It is pure, so a project with hundreds of components classifies in
// one pass and the result is testable without a palette.

export const INSERT_GROUPS = ['sections', 'blocks'] as const;
export type InsertGroup = (typeof INSERT_GROUPS)[number];

/**
 * How many components a chain of root components may pass through before the answer is "block".
 * Wrappers nest a few deep (Section, Container, Layout); a chain beyond this is a cycle or a
 * file nobody would call a section. A bound is the cheaper way to survive both.
 */
export const rootChainDepthMax = 8;

export interface GroupSource {
  readonly name: string;
  readonly renderTag?: RenderTag | undefined;
  readonly rootComponent?: string | undefined;
}

/** Components by name. Names repeat across folders; the first listed wins, as an import cannot be told here. */
export function indexByName<T extends GroupSource>(components: readonly T[]): ReadonlyMap<string, T> {
  const byName = new Map<string, T>();
  for (const component of components) {
    if (!byName.has(component.name)) {
      byName.set(component.name, component);
    }
  }
  return byName;
}

export function insertGroupOf(component: GroupSource, byName: ReadonlyMap<string, GroupSource>): InsertGroup {
  assert(rootChainDepthMax > 0, 'The root chain needs room for at least the component itself');
  const seen = new Set<GroupSource>();
  let current: GroupSource = component;
  for (let depth = 0; depth <= rootChainDepthMax; depth++) {
    if (current.renderTag?.tag === 'section') {
      return 'sections';
    }
    seen.add(current);
    const next = current.rootComponent === undefined ? undefined : byName.get(current.rootComponent);
    if (next === undefined) {
      return 'blocks';
    }
    if (seen.has(next)) {
      // A cycle never reaches a <section>.
      return 'blocks';
    }
    current = next;
  }
  return 'blocks';
}
