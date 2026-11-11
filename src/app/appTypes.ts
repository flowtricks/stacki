// The application shell's own types: history, toasts, tabs, the project and
// what the shell keeps about it. A page's state is src/editor/pageState.ts.
import type { Data } from '../../shared/core/boundary';
import type { IpcResults, WireGitInfo, WireInjectedRoute } from '../../shared/ipc/ipcResults';
import type { ScanResult } from '../../shared/properties/projectScan';
import type { AssetRequest } from '../ui/assetPick';
import type { CoalescedRun } from '../lib/coalescedRun';
import type { EditsRecord } from '../editor/pageEdits';
import type { EditorNode } from '../editor/pageView';
import type { VariableSelection } from '../ipc/variablesBridge';

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
  /** The step's name when an app named it (docs/apps.md, "Undo labels"); shown when it is undone or redone. */
  label?: string;
  /** Files the same step made, such as a component created from the selection
   *  (src/app/model/componentCreation.ts): one ⌘Z takes back both. */
  readonly files?: StepFiles;
}

/** A step's work on files beside its page writes. Undo runs once the page's
 *  writes are reverted, redo before they are replayed, so the page never
 *  imports a file that is not there. Both are idempotent: a step that undid
 *  only part of its page writes is undone again later, and runs them again. */
export interface StepFiles {
  readonly undo: () => Promise<void>;
  readonly redo: () => Promise<void>;
}

export type HistoryEntry = UndoCommand | EditsEntry;
export interface AppHistory {
  past: HistoryEntry[];
  future: HistoryEntry[];
  lastPush: number;
  lastKey: string | undefined;
}

export type ToastKind = 'info' | 'success' | 'warning' | 'error';
export type LeftTab =
  | 'pages'
  | 'navigator'
  | 'properties'
  | 'components'
  | 'assets'
  | 'cms'
  | 'variables'
  | 'selectors'
  | 'code'
  | 'history'
  | 'apps'
  | 'instructions'
  | 'audits'
  | 'ai'
  | undefined;
export type RightTab = 'style' | 'settings';
export type DevStatus = 'off' | 'starting' | 'on';

export interface NodeStates {
  readonly hidden: readonly string[];
  readonly inert: readonly string[];
  /** Nodes whose ::before is drawn, and whose ::after is: layers in the navigator. */
  readonly before: readonly string[];
  readonly after: readonly string[];
}

/**
 * A ::before or ::after picked in the navigator: its element, which one, and a
 * count that makes picking the same one again a new request for the Style
 * panel to select its selector.
 */
export interface PseudoPick {
  readonly nodeId: string;
  readonly pseudo: 'before' | 'after';
  readonly serial: number;
}

export interface PreviewCommitInfo {
  readonly url: string;
  readonly subject: string | undefined;
  readonly when: string | undefined;
}

export type DynamicEntry = IpcResults['page:dynamicPaths']['entries'][number];
export type CollectionSample = Data;
export type CollectionSamples = Readonly<Record<string, CollectionSample>>;
/** What a file's import calls returned, keyed `<file>|<value name>`; absent: never asked. */
export type ValueSamples = Readonly<Record<string, Data>>;
export type ItemIndexes = Readonly<Record<string, number>>;
export type GitInfo = IpcResults['git:info'];
export type RepositoryInfo = WireGitInfo;
export type InjectedRoute = WireInjectedRoute;
export type VariablesGroup = VariableSelection;
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
