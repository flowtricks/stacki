import type { CSSProperties } from 'react';
import type { Data } from '../shared/boundary';
import type { IpcResults, WireGitInfo, WireInjectedRoute } from '../shared/ipc-results';
import type { ParsePageResult } from '../shared/page-node';
import type { ScanResult } from '../shared/scan';
import type { AssetRequest } from './assetPick';
import type { VariableSelection } from './variablesBridge';
import {
  cloneEditorModel,
  type EditorModel,
  type EditorNode,
} from '../shared/editor-model';

export { cloneEditorModel, nodeId } from '../shared/editor-model';
export type { EditorModel, EditorNode } from '../shared/editor-model';

export interface ProjectIdentity {
  readonly path: string;
  readonly name: string;
}

export type OpenKind = 'page' | 'component';
export interface OpenFile {
  readonly kind: OpenKind;
  readonly path: string;
  readonly name: string;
  readonly route?: string;
  readonly focusPath?: string | null;
  readonly focusOcc?: number;
  readonly focusWhole?: boolean;
  readonly hostKey?: string | null;
}

export interface OpenRoute {
  readonly kind: 'route';
  readonly name: string;
  readonly route: string;
  readonly from: string | null;
  readonly path?: undefined;
}

export type CurrentPage = OpenFile | OpenRoute;

interface PageStateBase {
  readonly source: string;
  readonly dirty: boolean;
}

export interface EditablePageState extends PageStateBase {
  readonly editable: true;
  readonly model: EditorModel;
}

export interface RawPageState extends PageStateBase {
  readonly editable: false;
  readonly reason: string;
  readonly bail: { readonly what: string; readonly near: string } | null;
}

export type EditorPageState = EditablePageState | RawPageState;

export interface PageStateSnapshot {
  readonly currentPage: CurrentPage | null;
  readonly pageState: EditorPageState | null;
}

export type PageSnapshot =
  | { readonly kind: 'model'; readonly model: EditorModel }
  | { readonly kind: 'source'; readonly source: string };

export interface UndoCommand {
  readonly kind: 'cmd';
  readonly undo: () => unknown | Promise<unknown>;
  redo: () => unknown | Promise<unknown>;
  label?: string;
  readonly coalesceKey?: string | null;
}

export type HistoryEntry = PageSnapshot | UndoCommand;
export interface AppHistory {
  past: HistoryEntry[];
  future: HistoryEntry[];
  lastPush: number;
  lastKey: string | null;
}

export type ToastKind = 'info' | 'success' | 'error';
export interface ToastMessage {
  readonly msg: string;
  readonly kind: ToastKind;
}

export type LeftTab =
  | 'pages'
  | 'navigator'
  | 'properties'
  | 'components'
  | 'assets'
  | 'cms'
  | 'variables'
  | 'code'
  | 'history'
  | null;
export type RightTab = 'style' | 'settings';
export type DevStatus = 'off' | 'starting' | 'on';
export type TrailingSlash = 'always' | 'never' | 'ignore';

export interface NodeStates {
  readonly hidden: readonly string[];
  readonly inert: readonly string[];
}

export interface CodeWindowState {
  readonly kind?: 'file';
  readonly area?: 'src';
  readonly targetId?: string;
  readonly rel?: string;
  readonly title: string;
  readonly language: string;
  readonly revealLine?: number;
}

export interface PreviewCommitInfo {
  readonly url: string;
  readonly subject: string | undefined;
  readonly when: string | undefined;
}

export type DynamicEntry = IpcResults['page:dynamicPaths']['entries'][number];
export type CollectionSample = Data | null;
export type CollectionSamples = Readonly<Record<string, CollectionSample>>;
export type ItemIndexes = Readonly<Record<string, number>>;
export type GitInfo = IpcResults['git:info'];
export type RepositoryInfo = WireGitInfo;
export type InjectedRoute = WireInjectedRoute;
export type VariablesGroup = VariableSelection;
export type RightTabIndicator = Pick<CSSProperties, 'left' | 'width'>;
export type AssetPick = AssetRequest;

export interface ScanRequest {
  readonly projectPath: string;
  readonly promise: Promise<ScanResult>;
  applied: boolean;
}

export interface NodeClipboard {
  readonly node: EditorNode;
  readonly vars: readonly string[];
  readonly frontmatter: string;
  readonly imports: readonly { readonly name: string; readonly path: string }[];
  readonly pagePath: string | null;
}

export function findEditorNodeById(
  nodes: readonly EditorNode[] | null | undefined,
  id: string,
): EditorNode | null {
  const pending = [...(nodes ?? [])];
  let visited = 0;
  while (pending.length > 0) {
    visited += 1;
    if (visited > 100_000) {
      throw new Error('Editor node lookup exceeds limit');
    }
    const node = pending.shift();
    if (!node) {
      continue;
    }
    if (node.id === id) {
      return node;
    }
    if ('children' in node && Array.isArray(node.children)) {
      pending.unshift(...node.children);
    }
  }
  return null;
}

export function findEditorParentList(
  model: EditorModel,
  id: string,
): { readonly list: EditorNode[]; readonly index: number } | null {
  const pending: EditorNode[][] = [model.nodes];
  let visited = 0;
  while (pending.length > 0) {
    visited += 1;
    if (visited > 100_000) {
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
  return null;
}

export function toEditorPageState(
  input: ParsePageResult & { readonly source: string },
): EditorPageState {
  if (!input.editable) {
    return { ...input, dirty: false };
  }
  return { ...input, model: cloneEditorModel(input.model), dirty: false };
}

export function isOpenFile(page: CurrentPage | null): page is OpenFile {
  return page?.kind === 'page' || page?.kind === 'component';
}

export function isEditableState(state: EditorPageState | null): state is EditablePageState {
  return state?.editable === true;
}
