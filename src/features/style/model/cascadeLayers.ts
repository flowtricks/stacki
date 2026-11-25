// Cascade layers as the style panel reads them: `@layer` blocks, `@layer a, b;` statements and
// `@import url() layer(x)`, numbered in the order the browser fixes them.
//
// A layer's place is decided by where its name FIRST appears in the document (a statement
// or a block, whichever comes first), so the registry numbers names as they are met and a
// later statement never moves one. A nested layer (`a.b`, or `@layer b` inside `@layer a`)
// is numbered among its parent's children. A layer's position is the path of those numbers:
// `[0, 2]` is the third child of the first top-level layer. Why a path and not one number:
// sub-layers sort inside their parent, and an unrelated layer declared later must not
// interleave with them (CSS Cascade 5, section 6.4).

import { assert } from '../../../../shared/core/assert';

/** The most layers one page may declare: a stylesheet is untrusted input, so the count is bounded. */
export const LAYERS_MAX = 1024;

/** A layer's position in the cascade-layer order tree, or undefined for unlayered styles. */
export type LayerPosition = readonly number[];

type LayerNode = { readonly index: number; readonly children: Map<string, LayerNode> };

export class LayerRegistry {
  readonly #roots = new Map<string, LayerNode>();
  #count = 0;

  /** The position of the layer named by `path` (outermost name first), registering it when new. */
  positionOf(path: readonly string[]): LayerPosition {
    assert(path.length > 0, 'LayerRegistry.positionOf: a layer has at least one name');
    const position: number[] = [];
    let level = this.#roots;
    for (const name of path) {
      let node = level.get(name);
      if (node === undefined) {
        assert(this.#count < LAYERS_MAX, 'LayerRegistry: the layer count is bounded');
        node = { index: level.size, children: new Map() };
        level.set(name, node);
        this.#count += 1;
      }
      position.push(node.index);
      level = node.children;
    }
    return position;
  }
}

/** The layer names an `@layer` prelude lists: `a, b.c` is two layers, `b.c` being `c` inside `b`. */
export function layerNamesOf(params: string): ReadonlyArray<readonly string[]> {
  return params
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0)
    .map((name) => name.split('.').map((part) => part.trim()));
}

/**
 * Compare two layered positions: positive when `left` is the LATER layer, which wins a normal
 * declaration. A rule written directly in a layer comes after that layer's sub-layers, so the
 * shorter path (the parent) outranks the longer one it prefixes.
 */
export function compareLayerPositions(left: LayerPosition, right: LayerPosition): number {
  const shared = Math.min(left.length, right.length);
  for (let index = 0; index < shared; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return right.length - left.length;
}
