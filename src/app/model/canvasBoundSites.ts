// Which texts a page prints from data, and the string literal each one comes from.
// Pure: the canvas offers them for typing (canvasBoundText.ts), and Studio's server
// reads the same answer to tell a text edit of the frontmatter from any other
// (studio/src/features/roles/editorContent.ts).

import type { CanvasSourceNode } from '../../features/preview/canvasTextSource';
import { assert } from '../../../shared/core/assert';
import { LIMITS } from '../../../shared/core/limits';
import {
  BOUND_TEXT_LIMITS,
  boundLoopOf,
  expressionInLoops,
  parseBoundPath,
  resolveBoundList,
  resolveBoundText,
  type BoundTextBlock,
  type BoundTextEnvironment,
  type BoundTextLoop,
  type BoundTextSite,
} from '../../editor/boundText';

/** Candidate expressions read per page, and the targets all of them yield. */
const CANDIDATES_MAX = 200;
export const TARGETS_MAX = 400;

export interface Candidate {
  readonly node: CanvasSourceNode;
  readonly parent: CanvasSourceNode;
  readonly expression: string;
  readonly loops: readonly { readonly item: string; readonly list: string }[];
}

export interface Resolved {
  readonly candidate: Candidate;
  /** The loop item's key suffix: `~2` or `~1~0`; empty outside a loop. */
  readonly suffix: string;
  /** What the source holds for this text, as a path: `cards[2].title`. */
  readonly path: string;
  readonly outcome: { readonly ok: true; readonly site: BoundTextSite } | { readonly ok: false; readonly block: BoundTextBlock };
}

const NO_LOOPS: Candidate['loops'] = [];

// Expression nodes that print one path, each with the loops around it. A text
// inside a loop whose head is code the walk cannot read is left alone.
export function candidatesOf(source: string, nodes: readonly CanvasSourceNode[]): Candidate[] {
  const found: Candidate[] = [];
  const stack: { readonly node: CanvasSourceNode; readonly parent: CanvasSourceNode | undefined; readonly loops: Candidate['loops'] | undefined }[] = nodes
    .map((node) => ({ node, parent: undefined, loops: NO_LOOPS }))
    .reverse();
  for (let visited = 0; stack.length > 0 && visited < 20_000; visited++) {
    const entry = stack.pop();
    assert(entry !== undefined, 'The candidate walk has an entry');
    const { node, parent, loops } = entry;
    const own = node.kind === 'map' ? boundLoopOf(node.head ?? '') : undefined;
    const inside = loops === undefined || (node.kind === 'map' && own === undefined) ? undefined : own === undefined ? loops : [...loops, own];
    if (node.kind === 'expr' && loops !== undefined && parent !== undefined && (parent.kind === 'element' || parent.kind === 'component')) {
      const expression = node.start === undefined || node.end === undefined ? '' : source.slice(node.start + 1, node.end - 1).trim();
      if (parseBoundPath(expression) !== undefined) {
        found.push({ node, parent, expression, loops });
      }
    }
    for (const child of [...(node.children ?? [])].reverse()) {
      stack.push({ node: child, parent: node, loops: inside });
    }
  }
  return found;
}

export async function resolveCandidate(environment: BoundTextEnvironment, candidate: Candidate, budget: number): Promise<Resolved[]> {
  const parsed = parseBoundPath(candidate.expression);
  const usesLoop = parsed !== undefined && candidate.loops.some((loop) => loop.item === parsed.root);
  if (candidate.loops.length > 0 && !usesLoop) {
    // The same words in every pass: the canvas could not say which copy was meant.
    return [refused(candidate, { reason: 'duplicate', file: '', detail: 'Every pass of the loop prints the same words.' })];
  }
  const combinations: BoundTextLoop[][] = [];
  const failures: { readonly block: BoundTextBlock | undefined }[] = [];
  await enumerate(environment, candidate.loops, [], combinations, Math.min(budget, BOUND_TEXT_LIMITS.itemsMax), failures);
  const results: Resolved[] = [];
  for (const combination of combinations) {
    const path = expressionInLoops(candidate.expression, combination);
    const suffix = combination.map((loop) => `~${loop.index}`).join('');
    results.push({ candidate, suffix, path, outcome: await resolveBoundText(environment, path) });
  }
  const editable = results.filter((entry) => entry.outcome.ok);
  const first = results.find((entry) => !entry.outcome.ok)?.outcome;
  // Every text that is not editable says why when it is double-clicked, one refusal per text however many items fail.
  const block = first !== undefined && !first.ok ? first.block : failures[0]?.block;
  return [...editable, ...(block === undefined || (editable.length > 0 && results.length === editable.length) ? [] : [refused(candidate, block)])];
}

export function refused(candidate: Candidate, block: BoundTextBlock): Resolved {
  return { candidate, suffix: '', path: candidate.expression, outcome: { ok: false, block } };
}

// The index combinations of the loops around a text, outermost first, in the order the page renders them. A list that cannot be counted says why in `failure`.
async function enumerate(
  environment: BoundTextEnvironment,
  loops: Candidate['loops'],
  chosen: readonly BoundTextLoop[],
  into: BoundTextLoop[][],
  budget: number,
  failure: { readonly block: BoundTextBlock | undefined }[],
): Promise<void> {
  const depth = chosen.length;
  assert(depth <= LIMITS.treeDepthMax, 'Loops nest within the tree depth bound');
  const loop = loops[depth];
  if (loop === undefined) {
    into.push([...chosen]);
    return;
  }
  const counted = await resolveBoundList(environment, expressionInLoops(loop.list, chosen));
  if (!counted.ok) {
    failure.push({ block: counted.block });
    return;
  }
  for (let index = 0; index < counted.count && into.length < budget; index++) {
    await enumerate(environment, loops, [...chosen, { item: loop.item, list: loop.list, index }], into, budget, failure);
  }
}

/** Every text of the page traced to its source, within the canvas's own bounds. */
export async function resolvePageTexts(environment: BoundTextEnvironment, nodes: readonly CanvasSourceNode[]): Promise<Resolved[]> {
  const resolved: Resolved[] = [];
  for (const candidate of candidatesOf(environment.page.text, nodes).slice(0, CANDIDATES_MAX)) {
    resolved.push(...(await resolveCandidate(environment, candidate, TARGETS_MAX - resolved.length)));
    if (resolved.length >= TARGETS_MAX) {
      break;
    }
  }
  return resolved;
}
