// The application shell's own types: history, toasts, tabs, the project and
// what the shell keeps about it. A page's state is src/editor/pageState.ts.
import type { CSSProperties } from 'react';
import type { Data } from '../../shared/core/boundary';
import type { IpcResults, WireGitInfo, WireInjectedRoute } from '../../shared/ipc/ipcResults';
import type { ScanResult } from '../../shared/properties/projectScan';
import type { AssetRequest } from '../ui/assetPick';
import type { CoalescedRun } from '../lib/coalescedRun';
import type { EditsRecord } from '../editor/pageEdits';
import type { EditorNode } from '../editor/pageView';
import type { VariableSelection } from '../features/variables/variablesBridge';

export interface ProjectIdentity {
  readonly path: string;
  readonly name: string;
}

export interface UndoCommand {
  readonly kind: 'cmd';
  readonly undo: () => unknown | Promise<unknown>;
  redo: () => unknown | Promise<unknown>;
  label?: string;
  readonly coalesceKey?: string | undefined;
}

/** An undo step of the open page: its writes' inverses, which Undo submits
 * against the checksums they were returned with (plan §11.9: undo is inverse
 * splices only). The record is mutable: answers arrive after the entry is
 * pushed. */
export interface EditsEntry {
  readonly kind: 'edits';
  readonly record: EditsRecord;
}

export type HistoryEntry = UndoCommand | EditsEntry;
export interface AppHistory {
  past: HistoryEntry[];
  future: HistoryEntry[];
  lastPush: number;
  lastKey: string | undefined;
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
  | 'feedback'
  | undefined;
export type RightTab = 'style' | 'settings';
export type DevStatus = 'off' | 'starting' | 'on';

export interface NodeStates {
  readonly hidden: readonly string[];
  readonly inert: readonly string[];
}

export interface PreviewCommitInfo {
  readonly url: string;
  readonly subject: string | undefined;
  readonly when: string | undefined;
}

export type DynamicEntry = IpcResults['page:dynamicPaths']['entries'][number];
export type CollectionSample = Data;
export type CollectionSamples = Readonly<Record<string, CollectionSample>>;
export type ItemIndexes = Readonly<Record<string, number>>;
export type GitInfo = IpcResults['git:info'];
export type RepositoryInfo = WireGitInfo;
export type InjectedRoute = WireInjectedRoute;
export type VariablesGroup = VariableSelection;
export type RightTabIndicator = Pick<CSSProperties, 'left' | 'width'>;
export type AssetPick = AssetRequest;

/** The open project's scans: one in flight, at most one waiting. */
export interface ProjectScans {
  readonly projectPath: string;
  readonly scans: CoalescedRun<ScanResult>;
}

export interface NodeClipboard {
  readonly node: EditorNode;
  readonly vars: readonly string[];
  readonly frontmatter: string;
  readonly imports: readonly { readonly name: string; readonly path: string }[];
  readonly pagePath: string | undefined;
}
