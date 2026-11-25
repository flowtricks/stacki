// The canvas-only hover preview, as one function of where the edit is aimed. The Style panel gives
// it its state and selector (useEditorWrites' useCanvasPreview); a code window's chips, which have
// neither, aim it at the selected element's own style (codeChips/chipPreview.ts).
//
// The preview goes to the frame as a hover style (shared/properties/liveRules.ts), set inline on the
// selected element, and no save follows: nothing is mutated, written, put in history or marked dirty,
// so taking it back is only telling the frame to put the element's own style back, and a restore can
// never race a write. A state or pseudo-element context has no element to show it on: there the
// control alone shows it.

import { assert } from '../../../../shared/core/assert';
import { HOVER_STYLE_LIMITS, HOVER_STYLE_MESSAGE, parseHoverStyleMessage, type HoverDeclaration } from '../../../../shared/properties/liveRules';
import type { PreviewProp } from '../connectFieldHelpers';
import { writtenValue } from '../model/lengthUnit';
import { getHost } from '../model/host';
import { hoverStyle } from '../model/liveRuleEdits';
import { parseImportant } from '../model/styleDisplay';
import { isSupportedCssValue } from '../model/supportedCssValue';

/** Where a preview may be shown: no state, no pseudo-element, the selected element's own style. */
export interface CanvasPreviewContext {
  readonly stateKey: string;
  readonly activeSelector: string | undefined;
}

/** The preview a code window's chips use: the selected element, in no state, under no selector. */
export const SELECTED_ELEMENT_PREVIEW: CanvasPreviewContext = { stateKey: '', activeSelector: undefined };

/** A preview writer for `context`: a value shows it, `undefined` takes it back. */
export function canvasPreviewProp({ stateKey, activeSelector }: CanvasPreviewContext): PreviewProp {
  return (propOrProps, typed, important) => {
    const props: readonly string[] = typeof propOrProps === 'string' ? [propOrProps] : propOrProps;
    assert(props.length > 0, 'Canvas preview: a preview names a property');
    const shown = typed === undefined ? undefined : hoverDeclarationsOf(props, typed, { important, stateKey, activeSelector });
    if (shown === undefined) {
      hoverStyle.clear(props);
      return;
    }
    hoverStyle.show(shown.path, shown.declarations);
    assert(hoverStyle.showing().length === shown.declarations.length, 'Canvas preview: the shown properties are remembered');
  };
}

// What the frame shows for `typed` on the selected element, or undefined when there is nowhere to show
// it: no selection, a value a property does not take, a state or pseudo-element context.
function hoverDeclarationsOf(
  props: readonly string[],
  typed: string,
  { important, stateKey, activeSelector }: { readonly important: boolean; readonly stateKey: string; readonly activeSelector: string | undefined },
): { readonly path: string; readonly declarations: readonly HoverDeclaration[] } | undefined {
  if (stateKey.length > 0) {
    return undefined;
  }
  if (activeSelector !== undefined) {
    if (activeSelector.includes('::')) {
      return undefined;
    }
  }
  const host = getHost();
  const nodeId = host.selectedId;
  if (nodeId === undefined) {
    return undefined;
  }
  const path = host.pathOf?.(nodeId);
  if (path === undefined) {
    return undefined;
  }
  // A field's text may carry its own flag (`12px !important`); a dropdown passes it apart.
  const parsed = parseImportant(typed.trim());
  const declarations: HoverDeclaration[] = [];
  for (const prop of props.slice(0, HOVER_STYLE_LIMITS.declarationsMax)) {
    const value = writtenValue(prop, parsed.value);
    if (value.length === 0) {
      return undefined;
    }
    // A half-made value is not sent: the frame would drop the declaration and show nothing.
    if (!isSupportedCssValue(prop, value)) {
      return undefined;
    }
    declarations.push({ property: prop, value, important: important || parsed.important });
  }
  // Parsed as the frame will parse it, so the panel never sends what the frame refuses.
  const message = parseHoverStyleMessage({ type: HOVER_STYLE_MESSAGE, op: 'show', path, declarations });
  return message?.op === 'show' ? { path: message.path, declarations: message.declarations } : undefined;
}
