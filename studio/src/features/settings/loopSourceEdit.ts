// A loop's list settings, written to the page as Desktop writes them: one plan
// (loopQueryPlan.ts) says the new head, the children re-pointed at the new item
// and the frontmatter the change needs, and this module places that plan on the
// page's own bytes. Desktop sends the same plan through its document engine
// (appLoopEdits.ts); Studio's document is shared text, so the plan lands as text
// edits, each touching only what the plan changed:
//
//   - the head alone, where the children stay as they were: a filter, a sort, a
//     limit, a section typed as code;
//   - the loop's own bytes, where the children changed too: each hunk of the
//     printer's change placed on the bytes as written (editAnchors.placedHunks),
//     refused rather than reprinted when the formatting itself differs;
//   - the frontmatter block, where the plan wrote a query or took one away.

import { assert } from '../../../vendor/stacki/shared/core/assert';
import { described } from '../../../vendor/stacki/shared/properties/i18n/messageRef';
import { encodeUtf8 } from '../../../vendor/stacki/shared/core/span';
import { writeFrontmatter } from '../../../vendor/stacki/shared/page/frontmatterSource';
import { lineIndent } from '../../../vendor/stacki/shared/engine/planSupport';
import { placedHunks } from '../../../vendor/stacki/electron/documents/editAnchors';
import { serializeNodes } from '../../../vendor/stacki/electron/parse/astroSerialize';
import { planLoop, type LoopPlan, type LoopTarget } from '../../../vendor/stacki/src/editor/loopQueryPlan';
import type { LoopApplyResult } from '../../../vendor/stacki/src/features/props/LoopSettings';
import { parsePageModel } from '../../../vendor/stacki/shared/page/pageNode';
import { LIMITS } from '../../../vendor/stacki/shared/core/limits';
import type { EditorNode } from '../../../vendor/stacki/src/editor/pageView';
import { applyEdits, bounds, flatten, parsePage, type Edit, type ParserNode } from '../source/source';
import { frontmatterEdit, nodeTextEdit } from './settingsEdits';

/** The page with the loop's new settings, and what applying them did. */
export interface LoopSourceEdit {
  readonly source: string;
  readonly result: LoopApplyResult;
}

/**
 * The page `source` with loop `id` reading `target`. A change the plan refuses
 * (code the settings cannot write) comes back as the reason, with the page as it
 * was; a page that no longer holds the loop throws, as every Studio edit does.
 */
export function loopSourceEdit(source: string, id: string, target: LoopTarget, sanityClient: 'available' | 'unavailable'): LoopSourceEdit {
  const parsed = parsePage(source, { locs: true });
  if (!parsed.editable) {
    throw new Error('Fix the page syntax before changing this loop.');
  }
  // The planner reads the checked page model; the parser's own nodes say where each one is written.
  const model = parsePageModel(parsed.model);
  const written = flatten(parsed.model.nodes).find((node) => node.id === id);
  const loop = editorNodes(model.nodes).find((node) => node.id === id);
  if (written?.kind !== 'map' || loop?.kind !== 'map') {
    throw new Error('Selection changed. Select the loop again.');
  }
  assert(loop.head === written.head, 'The checked loop is the loop as written');
  const planned = planLoop({ model, loop, target, sanityClient });
  if (!planned.ok) {
    return { source, result: planned };
  }
  const plan = planned.plan;
  assert(plan.loop.id === loop.id, 'A loop plan restates the loop it was made for');
  const loopEdits = loopNodeEdits(source, { written, loop }, plan);
  if (loopEdits === undefined) {
    return { source, result: { ok: false, ...described('settings.element.loopDifferent') } };
  }
  const frontmatterChanged = plan.extraFrontmatter !== model.extraFrontmatter || plan.imports !== model.imports;
  const text = frontmatterChanged ? writeFrontmatter({ ...model, extraFrontmatter: plan.extraFrontmatter, imports: plan.imports }) : undefined;
  const edits = text === undefined ? loopEdits : [...loopEdits, frontmatterEdit(source, text.replace(/\r?\n$/, ''))];
  const next = applyEdits(source, edits);
  assert(parsePage(next).editable, 'A planned loop change leaves a page the parser reads');
  return { source: next, result: { ok: true, unbound: plan.unbound, lost: plan.lost, restored: plan.restored } };
}

// Every node of the page, depth first, within the parser's node bound.
function editorNodes(nodes: readonly EditorNode[]): readonly EditorNode[] {
  const out: EditorNode[] = [];
  const queue = [...nodes].reverse();
  while (queue.length > 0 && out.length < LIMITS.treeNodesMax) {
    const node = queue.pop();
    if (node === undefined) {
      break;
    }
    out.push(node);
    queue.push(...[...(node.children ?? [])].reverse());
  }
  return out;
}

// The edits to the loop's own bytes: none when it reads the same, the head
// alone when only the head changed, or the printer's change placed on the bytes.
// Undefined when that change cannot be placed without reprinting the loop.
function loopNodeEdits(
  source: string,
  nodes: { readonly written: Extract<ParserNode, { readonly kind: 'map' }>; readonly loop: Extract<EditorNode, { readonly kind: 'map' }> },
  plan: LoopPlan,
): readonly Edit[] | undefined {
  const { written, loop } = nodes;
  if (plan.loop.children === loop.children) {
    return plan.loop.head === loop.head ? [] : [nodeTextEdit(source, loop.id, plan.loop.head)];
  }
  const range = bounds(written);
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const own = source.slice(range.start, range.end);
  const indent = lineIndent(encodeUtf8(source), encodeUtf8(source.slice(0, range.start)).length);
  const print = (node: unknown): string =>
    serializeNodes([node])
      .replace(/\r?\n$/, '')
      .split(/\r?\n/)
      .join(`${eol}${indent}`);
  const hunks = placedHunks(print(loop), print(plan.loop), own);
  if (!hunks.ok) {
    return undefined;
  }
  const ownBytes = encodeUtf8(own);
  // Hunks are placed on the loop's UTF-8 bytes; the shared text counts UTF-16 units.
  const offset = (byte: number): number => range.start + new TextDecoder().decode(ownBytes.subarray(0, byte)).length;
  const edits = hunks.value.map((hunk) => ({ start: offset(hunk.span.start), end: offset(hunk.span.end), text: hunk.text }));
  assert(
    edits.every((edit) => edit.start >= range.start && edit.end <= range.end),
    'A loop’s edits stay inside the loop',
  );
  return edits;
}
