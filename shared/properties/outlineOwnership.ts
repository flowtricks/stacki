// Who owns what an outline is drawn around, and so which colour it takes (docs/canvas-closed-component-text.md).
//
// The rule, in one place: content is page-owned (blue, an `element`) only when the page author wrote it: a node of the open
// file's own tree, or an element rendered from children the page passed into a slot of a component instance. Everything else
// inside a component instance is the component's own (green, a `component`): its root, its own markup, text it renders from a
// prop, any element of a closed component's DOM that carries a component file's path (`File.astro|0.1`). A closed component has
// no way to produce a blue outline for anything it renders itself.
//
// Every outline producer (node hover and selection, picked and hovered words, pseudo-elements) asks `outlineKind` and passes
// what it knows of the subject; none of them chooses a colour class. `ownershipOf` reads the owner off an element's canvas
// paths, so a producer never has to guess it. The type is the guard: `OutlineSubject` has no field that names a colour, and
// `outlineKind` asserts that nothing inside a component without a slot ancestor leaves blue.
import { assert } from '../core/assert';

/** The class an outline is drawn with: the component green, the loop and data purple, or the plain element blue. */
export type OutlineKind = 'component' | 'map' | 'element';

/** What the outline's subject is, as far as the person's page is concerned. */
export interface OutlineSubject {
  /** Whether the subject is part of a component instance's DOM that the open file does not own (a closed component's markup). */
  readonly insideComponent: boolean;
  /** Whether it is rendered from children the page passed into a slot of that instance. Meaningful only inside a component. */
  readonly insideSlot: boolean;
  /** What the subject is as a node of the tree: a component instance, a loop, or any other element. */
  readonly nodeKind: OutlineKind;
}

/** Who wrote an element a component renders, by its canvas paths. */
export type Ownership = 'slot' | 'component';

/**
 * The owner of an element inside an instance, from the canvas paths it carries. A path with a `|` is a component file's own node
 * (`src/components/Button.astro|0.1`): the element is the component's, whatever else tags it. An element with only page paths
 * was written by the page, so it can only have reached the instance's DOM through a slot.
 */
export function ownershipOf(paths: readonly string[]): Ownership {
  assert(paths.length <= 64, 'ownershipOf: an element carries a bounded number of paths');
  return paths.length > 0 && paths.every((path) => !path.includes('|')) ? 'slot' : 'component';
}

/** The kind an outline takes. Nothing inside a component, outside a slot, is ever the plain element kind. */
export function outlineKind(subject: OutlineSubject): OutlineKind {
  const owned = subject.insideComponent && !subject.insideSlot;
  const kind: OutlineKind = owned ? 'component' : subject.nodeKind;
  assert(!owned || kind === 'component', "outlineKind: an element inside a component with no slot ancestor is the component's, never plain");
  assert(subject.insideComponent || !subject.insideSlot, 'outlineKind: a slot ancestor needs a component around it');
  return kind;
}
