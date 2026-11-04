// The ::before or ::after under the pointer, for hover and click.
//
// Thin DOM glue around pseudoHit.ts: it picks the few elements under the
// pointer that can answer, measures only those of them the last page pass
// found drawing a pseudo-element (frameReports drawsPseudoAt), and lets the
// pure rule decide. Measuring a pseudo-element means inserting a stand-in and
// reading its box (framePseudo.ts), which is not free on every mousemove, so
// the boxes are kept, relative to their host, while the pointer stays over the
// same elements; a click measures afresh (see forgetPseudoBoxes).

import { assert } from '../../shared/core/assert';
import { type PseudoLayer } from '../../shared/page/pseudoPath';
import { isElement, type Box } from './frameBasics';
import { PATH_ATTR, elementsWithPath, inFocus, inScope, pathsOf, runsOf } from './frameRegions';
import { measurePseudo } from './framePseudo';
import { drawsPseudoAt } from './frameReports';
import { PSEUDO_CANDIDATES_MAX, boxAt, pseudoAt, type PseudoBoxes } from './pseudoHit';

/** A pseudo-element the pointer is on: the node that draws it and which one. */
export interface PseudoTarget {
  readonly path: string;
  readonly pseudo: PseudoLayer;
}

interface Candidate {
  readonly path: string;
  readonly host: Element;
}

// One host's pseudo boxes as measured, relative to the host's top-left corner,
// so a scroll moves them with it without a new measurement.
interface MeasuredHost {
  readonly path: string;
  readonly host: Element;
  readonly before: Box | undefined;
  readonly after: Box | undefined;
}

let measured: readonly MeasuredHost[] = [];

/** Drops the kept boxes, so the next question measures again (a click must see the page as it is). */
export function forgetPseudoBoxes(): void {
  measured = [];
}

/**
 * The pseudo-element under (x, y), of the node `nodePath` the pointer resolved
 * to or of the tagged element the browser hit (whose pseudo-element can hang
 * outside its own box, where the node resolution hands the point to a
 * parent). Undefined when the point is on the elements themselves.
 */
export function pseudoTargetAt(nodePath: string, target: Node | undefined, x: number, y: number): PseudoTarget | undefined {
  const candidates = candidatesFor(nodePath, target);
  if (candidates.length === 0) {
    return undefined;
  }
  const kept = new Map(measured.map((entry) => [entry.host, entry]));
  const fresh = candidates.map((candidate) => {
    const held = kept.get(candidate.host);
    return held !== undefined && held.path === candidate.path ? held : measureHost(candidate);
  });
  measured = fresh;
  const boxes = fresh.map((entry) => placed(entry));
  const hit = pseudoAt(x, y, boxes);
  if (hit === undefined) {
    return undefined;
  }
  const winner = candidates[hit.index];
  assert(winner !== undefined, 'pseudoTargetAt: the hit names a candidate');
  assert(drawsPseudoAt(winner.path, hit.pseudo), 'pseudoTargetAt: only a drawn pseudo-element is hit');
  return { path: winner.path, pseudo: hit.pseudo };
}

// Innermost first: the element the browser hit, then the resolved node's own
// element when that is a different one. Only those that draw a pseudo-element.
function candidatesFor(nodePath: string, target: Node | undefined): readonly Candidate[] {
  const out: Candidate[] = [];
  const hit = hitCandidate(target);
  const resolvedHost = hostOf(nodePath, target);
  const resolved = resolvedHost === undefined ? undefined : { path: nodePath, host: resolvedHost };
  const ordered = orderInnermostFirst(hit, resolved);
  for (const candidate of ordered) {
    if (drawsAny(candidate.path)) {
      out.push(candidate);
    }
  }
  assert(out.length <= PSEUDO_CANDIDATES_MAX, 'candidatesFor: candidates are capped');
  return out;
}

function orderInnermostFirst(hit: Candidate | undefined, resolved: Candidate | undefined): readonly Candidate[] {
  if (hit === undefined) {
    return resolved === undefined ? [] : [resolved];
  }
  if (resolved === undefined) {
    return [hit];
  }
  if (hit.host === resolved.host) {
    return [resolved];
  }
  // The resolved node may sit inside the hit tag (it was found by markers);
  // the inner one is what the pointer is over first.
  return hit.host.contains(resolved.host) ? [resolved, hit] : [hit, resolved];
}

// The tagged element the browser hit, when it belongs to what is being edited.
function hitCandidate(target: Node | undefined): Candidate | undefined {
  const tagged = target instanceof Element ? target.closest(`[${PATH_ATTR}]`) : undefined;
  if (tagged === undefined || tagged === null) {
    return undefined;
  }
  if (!inFocus(tagged)) {
    return undefined;
  }
  const path = pathsOf(tagged).find(inScope);
  return path === undefined ? undefined : { path, host: tagged };
}

// The element of `nodePath` that holds the target: the place the pointer is in.
function hostOf(nodePath: string, target: Node | undefined): Element | undefined {
  if (target === undefined) {
    return undefined;
  }
  for (const run of runsOf(nodePath) ?? []) {
    for (const node of run) {
      if (isElement(node) && node.isConnected && node.contains(target)) {
        return node;
      }
    }
  }
  return elementsWithPath(nodePath).find((element) => element.contains(target));
}

function drawsAny(nodePath: string): boolean {
  if (drawsPseudoAt(nodePath, 'before')) {
    return true;
  }
  return drawsPseudoAt(nodePath, 'after');
}

function measureHost(candidate: Candidate): MeasuredHost {
  const origin = candidate.host.getBoundingClientRect();
  const relative = (pseudo: PseudoLayer): Box | undefined => {
    if (!drawsPseudoAt(candidate.path, pseudo)) {
      return undefined;
    }
    const box = measurePseudo(candidate.host, pseudo);
    return box === undefined ? undefined : boxAt(box, -origin.left, -origin.top);
  };
  return { path: candidate.path, host: candidate.host, before: relative('before'), after: relative('after') };
}

// The kept boxes, at where their host is now, for the pseudo-elements the
// last page pass still finds drawn (a kept box can outlive its rule).
function placed(entry: MeasuredHost): PseudoBoxes {
  const origin = entry.host.getBoundingClientRect();
  const at = (pseudo: PseudoLayer, offset: Box | undefined): Box | undefined => {
    if (offset === undefined) {
      return undefined;
    }
    return drawsPseudoAt(entry.path, pseudo) ? boxAt(offset, origin.left, origin.top) : undefined;
  };
  return { before: at('before', entry.before), after: at('after', entry.after) };
}
