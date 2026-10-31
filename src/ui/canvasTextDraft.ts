// One transient draft mirrors the active canvas editor without changing source,
// history or iframe markup. Only Content fields, and the prop field whose text
// is being typed, subscribe to per-keystroke updates.
import { createLiveValue, useLiveValue } from './liveValue';
import { projectRelativePath } from '../lib/projectPath';
import type { Attr } from '../../shared/page/pageNode';
import { textValueCanonical } from '../../shared/page/htmlText';
import { assert } from '../../shared/core/assert';

/** Text typed in a page text node, or in text a component instance's prop sets. */
export type CanvasTextDraft =
  | (CanvasDraftScope & { readonly kind: 'text'; readonly sourceValue: string })
  | (CanvasDraftScope & {
      readonly kind: 'prop';
      readonly prop: string;
      /** The words in the editor; `value` is the prop's value with them in place. */
      readonly typed: string;
    });

interface CanvasDraftScope {
  readonly session: string;
  readonly projectPath: string;
  readonly file: string;
  /** The text node, or the component instance whose prop it is. */
  readonly nodeID: string;
  readonly value: string;
}

export const canvasTextDraft = createLiveValue<CanvasTextDraft | undefined>(undefined);

export function clearCanvasTextDraft(session: string): void {
  if (canvasTextDraft.get()?.session === session) {
    canvasTextDraft.set(undefined);
  }
}

export function useCanvasTextDraft(scope: {
  readonly projectPath?: string | undefined;
  readonly filePath?: string | undefined;
}): CanvasTextDraft | undefined {
  const draft = useLiveValue(canvasTextDraft);
  if (!draft || !scope.projectPath || !scope.filePath) {
    return undefined;
  }
  const file = projectRelativePath(
    scope.projectPath,
    scope.filePath,
    window.avb?.platform ?? 'linux',
  );
  return draft.projectPath === scope.projectPath && draft.file === file ? draft : undefined;
}

export function canvasDraftValue(
  node: { readonly id?: string; readonly value: string },
  draft: CanvasTextDraft | undefined,
): string {
  if (draft?.kind !== 'text') {
    return node.value;
  }
  if (node.id !== draft.nodeID || node.value !== draft.sourceValue) {
    return node.value;
  }
  return textValueCanonical(canvasTypedText(node.value, draft.value));
}

// HTML's whitespace: what a browser collapses, and not U+00A0, which it keeps.
const EDGE_START = /^[ \t\n\r\f]+/;
const EDGE_END = /[ \t\n\r\f]+$/;

/**
 * The words typed on the canvas, with the source's own edges. A rendered text
 * node carries the component template's indentation and line breaks around
 * the words; those belong to the template, not to the text, so they are
 * neither shown in the panel nor written to the file. Whether the source text
 * began or ended with a space is kept.
 */
export function canvasTypedText(source: string, typed: string): string {
  const words = typed.replace(EDGE_START, '').replace(EDGE_END, '');
  if (words === '') {
    return '';
  }
  const start = EDGE_START.test(source) ? ' ' : '';
  const end = EDGE_END.test(source) ? ' ' : '';
  const text = start + words + end;
  assert(text.length <= typed.length + 2, 'Typed text gains at most its two edges');
  return text;
}

/** The words being typed on the canvas for this instance's prop, as the field shows them. */
export function canvasDraftProp(
  nodeID: string | undefined,
  prop: string,
  draft: CanvasTextDraft | undefined,
): Attr | undefined {
  if (draft?.kind !== 'prop' || draft.nodeID !== nodeID || draft.prop !== prop) {
    return undefined;
  }
  return { type: 'string', value: draft.value };
}
