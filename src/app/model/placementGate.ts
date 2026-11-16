// The one question every gesture asks before it builds an edit that puts a node somewhere: may
// it go there, and if not, where may it go instead (src/editor/placementCheck.ts). The palette,
// a Navigator or canvas drop, paste, duplicate and move all ask here, so the same refusal reads
// the same wherever it came from, and the planner behind them is only ever a second line.
import type { InsertTarget } from '../../editor/insertTarget';
import { documentOfPath, resolveTarget, type PlacementInsertable, type PlacementSubject } from '../../editor/placementCheck';
import type { TreeView } from '../../editor/treeView';
import type { PlacementMessage } from '../../../shared/page/placement';
import type { Translator } from '../../lib/i18n/localeContext';

export type PlacementGate =
  /** Go ahead at `target`; `moved` says why it is not where it was asked (the nearest valid place), `warning` what to double check. */
  | { readonly kind: 'place'; readonly target: InsertTarget; readonly moved: PlacementMessage | undefined; readonly warning: PlacementMessage | undefined }
  | { readonly kind: 'stop'; readonly refusal: PlacementMessage };

/** `target` undefined is the end of the page's root list, as an insert with no place names it. */
export function gatePlacement(
  model: { readonly nodes: readonly TreeView[] },
  subject: PlacementSubject,
  target: InsertTarget | undefined,
  context: { readonly insertables: readonly PlacementInsertable[] | undefined; readonly pagePath: string | undefined },
): PlacementGate {
  const asked = target ?? { parentId: undefined, index: model.nodes.length };
  const resolved = resolveTarget(model.nodes, subject, asked, { insertables: context.insertables, document: documentOfPath(context.pagePath) });
  switch (resolved.kind) {
    case 'placed':
      return { kind: 'place', target: asked, moved: undefined, warning: resolved.warning };
    case 'snapped':
      return { kind: 'place', target: resolved.target, moved: resolved.reason, warning: resolved.warning };
    case 'refused':
      return { kind: 'stop', refusal: resolved.refusal };
    default: {
      const exhaustive: never = resolved;
      return exhaustive;
    }
  }
}

/** What to tell the person about a gate's answer: why nothing happened, or why it landed beside where they aimed. */
export function placementNotice(gate: PlacementGate, translate: Translator): { readonly tone: 'error' | 'info'; readonly text: string } | undefined {
  if (gate.kind === 'stop') {
    return { tone: 'error', text: translate(gate.refusal.messageKey, gate.refusal.params) };
  }
  if (gate.moved === undefined) {
    return undefined;
  }
  return { tone: 'info', text: translate('structure.placement.snapped', { reason: translate(gate.moved.messageKey, gate.moved.params) }) };
}
