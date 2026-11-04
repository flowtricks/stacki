// The open page as the editor holds it: which file is open, and its state —
// an editable model with the origin its edits are stated against, or the raw
// source of a page the visual model cannot hold.
import { assert } from '../../shared/core/assert';
import type { Digest } from '../../shared/core/brand';
import { LIMITS } from '../../shared/core/limits';
import type { ParsePageResult } from '../../shared/page/pageNode';
import { carryHandles, randomSeed, seedOf } from './nodeHandles';
import type { PageOrigin } from './pageEdits';
import type { EditorModel, EditorNode } from './pageView';
import { saveStateClean, type SaveState } from './saveState';

export type OpenKind = 'page' | 'component';
export interface OpenFile {
  readonly kind: OpenKind;
  readonly path: string;
  readonly name: string;
  readonly route?: string;
  readonly focusPath?: string | undefined;
  readonly focusOcc?: number;
  readonly focusWhole?: boolean;
  readonly hostKey?: string | undefined;
}

export interface OpenRoute {
  readonly kind: 'route';
  readonly name: string;
  readonly route: string;
  readonly from: string | undefined;
  readonly path?: undefined;
}

export type CurrentPage = OpenFile | OpenRoute;

interface PageStateBase {
  readonly source: string;
  /** Where this state stands against the file on disk (plan §7). */
  readonly save: SaveState;
}

export interface EditablePageState extends PageStateBase {
  readonly editable: true;
  readonly model: EditorModel;
  /** The text `model` is a parse of — for nodes a gesture changed or made,
   * the parse the gesture was applied to. Its source ranges index this text,
   * and handles are carried from it onto the next parse (src/editor/nodeHandles.ts). */
  readonly parsedFrom: string;
  /** The page as the app's last read or reply left it: edit requests are
   * stated against it when they are sent. Undefined only while typed code has
   * made a page parse whose bytes on disk did not: until the code is saved,
   * there are no bytes to state a request against. */
  readonly origin: PageOrigin | undefined;
}

export interface RawPageState extends PageStateBase {
  readonly editable: false;
  readonly reason: string;
  readonly bail: { readonly what: string; readonly near: string } | undefined;
}

export type EditorPageState = EditablePageState | RawPageState;

export interface PageStateSnapshot {
  readonly currentPage: CurrentPage | undefined;
  readonly pageState: EditorPageState | undefined;
}

export type TrailingSlash = 'always' | 'never' | 'ignore';

export function findEditorNodeById(nodes: readonly EditorNode[] | undefined, id: string): EditorNode | undefined {
  const pending = [...(nodes ?? [])];
  let visited = 0;
  while (pending.length > 0) {
    visited += 1;
    // Each node is visited once, so a model past the page-tree bound has a cycle.
    if (visited > LIMITS.treeNodesMax) {
      throw new Error('Editor node lookup exceeds limit');
    }
    const node = pending.shift();
    if (!node) {
      continue;
    }
    if (node.id === id) {
      return node;
    }
    if ('children' in node && node.children !== undefined) {
      pending.unshift(...node.children);
    }
  }
  return undefined;
}

export function findEditorParentList(model: EditorModel, id: string): { readonly list: readonly EditorNode[]; readonly index: number } | undefined {
  const pending: (readonly EditorNode[])[] = [model.nodes];
  let visited = 0;
  while (pending.length > 0) {
    visited += 1;
    // Each node is visited once, so a model past the page-tree bound has a cycle.
    if (visited > LIMITS.treeNodesMax) {
      throw new Error('Editor parent lookup exceeds limit');
    }
    const list = pending.shift();
    if (!list) {
      continue;
    }
    const index = list.findIndex((node) => node.id === id);
    if (index >= 0) {
      return { list, index };
    }
    for (const node of list) {
      if ('children' in node && Array.isArray(node.children)) {
        pending.push(node.children);
      }
    }
  }
  return undefined;
}

/** A page as a read or a reply left it: clean, and its own origin. */
export function toEditorPageState(input: ParsePageResult & { readonly source: string; readonly checksum: Digest }): EditorPageState {
  const save = saveStateClean(input.checksum);
  const source = input.source;
  if (!input.editable) {
    return { editable: false, reason: input.reason, bail: input.bail, source, save };
  }
  const model: EditorModel = input.model;
  const origin = { checksum: input.checksum, source, model: input.model };
  return { editable: true, model, source, parsedFrom: source, save, origin };
}

/** A fresh parse with the session's handles, carried from the page state it
 * replaces by the byte diff (src/editor/nodeHandles.ts): a reload, typed code's
 * parse, a code save's reply. Replies to the app's own gestures are carried
 * from the origin by the saver, with the gesture's own prediction — never
 * from the view, which also holds newer gestures' nodes. Unchanged when
 * either side is not editable. */
export function carriedParse<Parsed extends ParsePageResult & { readonly source: string }>(
  local: EditorPageState | undefined,
  parsed: Parsed & { readonly checksum?: Digest },
): Parsed {
  if (!isEditableState(local) || !parsed.editable) {
    return parsed;
  }
  const before = { source: local.parsedFrom, model: local.model };
  const checksum = parsed.checksum;
  const seed = checksum === undefined ? randomSeed() : seedOf(checksum);
  const after = { source: parsed.source, seed, model: parsed.model };
  const model = carryHandles({ before, after, own: undefined, predicted: undefined });
  return { ...parsed, model };
}

/**
 * The page the canvas shows while a component is open: the bottom of the edit
 * stack. Opening a component makes it the current page, so the current page
 * is the component itself, never where it is rendered; the Style panel needs
 * the page, whose `:global()` selectors reach the component's markup
 * (src/app/model/componentStyles.ts). Undefined when the open file is not a
 * component, or the stack does not start at a page.
 */
export function canvasPageOf(stack: readonly OpenFile[]): string | undefined {
  const open = stack.at(-1);
  const bottom = stack[0];
  if (open === undefined || bottom === undefined) {
    return undefined;
  }
  if (open.kind === 'component') {
    if (bottom.kind === 'page') {
      assert(bottom.path !== open.path, 'canvasPageOf: a component is not the page it is shown on');
      return bottom.path;
    }
    return undefined;
  }
  return undefined;
}

export function isOpenFile(page: CurrentPage | undefined): page is OpenFile {
  return page?.kind === 'page' || page?.kind === 'component';
}

export function isEditableState(state: EditorPageState | undefined): state is EditablePageState {
  return state?.editable === true;
}
