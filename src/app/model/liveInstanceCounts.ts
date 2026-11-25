// The Components panel's instance counts, true in the frame an edit is made in.
//
// The scan counts instances by reading every file (electron/handlers/projectScanHandlers.ts), and
// the app's own saves never cause a rescan: the watcher drops a write it hears coming back. So a
// count read from the scan alone keeps saying "1 instance" after that instance was deleted, until
// some unrelated event rescans. The editor already holds the open file's tree, which changes in the
// same commit as every edit, undo and redo. The panel's count is therefore
//
//   scanned total − the scan's share of each file the editor holds + that file's live count
//
// The open file's live share always replaces its scanned one, so a scan that read the file before
// a save (an older revision) can never put an old number back. Files the editor left keep their
// live share until a scan that started after leaving them (useLiveInsertables.ts).
//
// The live count follows the scan's own grammar (electron/properties/componentUsage.ts): every
// component tag in the file's markup counts once — inside slots, loop bodies and conditional
// branches alike, nodes not loop iterations — and so does a tag written inside an expression,
// comment or attribute value that the tree keeps as text, which the scan's pattern also reads.

import type { ScanComponent } from '../../../shared/properties/projectScan';
import type { ImportDecl } from '../../../shared/page/pageNode';
import { assert } from '../../../shared/core/assert';
import { LIMITS } from '../../../shared/core/limits';
import { componentReference } from './componentReference';

/** One file's live share of every component's count. */
export interface FileInstances {
  /** Project-relative and `/`-separated: the key the scan's `uses` are written under. */
  readonly file: string;
  /** Component path (as the scan lists it) → instances this file holds; absent means none. */
  readonly counts: ReadonlyMap<string, number>;
}

/** A tree as far as counting its component tags goes: the editor's and the page contract's nodes both fit. */
export interface InstanceCountNode {
  readonly kind: string;
  readonly name?: string;
  readonly value?: string;
  readonly inner?: string;
  readonly dynamicTag?: boolean;
  readonly astroAsset?: boolean;
  readonly props?: Readonly<Record<string, { readonly type: string; readonly value?: string }>>;
  readonly children?: readonly InstanceCountNode[] | undefined;
}

export interface FileInstanceContext {
  /** The project folder, as the app opened it. */
  readonly project: string;
  /** The open file's path, as the scan lists it. */
  readonly path: string;
  readonly components: readonly ScanComponent[];
}

// The scan's tag pattern (componentUsage.ts instanceTagCounts): a name that opens a tag.
const TAG_PATTERN = /<([A-Za-z][A-Za-z0-9]*)(?=[\s/>])/g;

/**
 * The project-relative, `/`-separated name of `path` inside `project`; undefined when the file is
 * outside it. Either separator is accepted, so a Windows path matches the scan's key.
 */
export function projectFileKey(project: string, path: string): string | undefined {
  const root = project.replaceAll('\\', '/').replace(/\/+$/, '');
  const file = path.replaceAll('\\', '/');
  if (root.length === 0) {
    return undefined;
  }
  if (file.startsWith(`${root}/`)) {
    const key = file.slice(root.length + 1);
    assert(!key.startsWith('/'), 'projectFileKey: a key is relative');
    return key;
  }
  return undefined;
}

/** How many instances of each component one file's tree holds, under the names the file imports them as. */
export function fileInstanceCounts(
  model: { readonly imports: readonly ImportDecl[]; readonly nodes: readonly InstanceCountNode[] },
  context: FileInstanceContext,
): FileInstances | undefined {
  const file = projectFileKey(context.project, context.path);
  if (file === undefined) {
    return undefined;
  }
  const tags = tagCounts(model.nodes);
  const counts = new Map<string, number>();
  const self = context.path.replaceAll('\\', '/');
  for (const [name, count] of tags) {
    const component = componentReference({ name, project: context.project, file: context.path, imports: model.imports, components: context.components });
    if (component === undefined) {
      continue;
    }
    // A file is not one of its own users, as the scan has it.
    if (component.path.replaceAll('\\', '/') === self) {
      continue;
    }
    counts.set(component.path, (counts.get(component.path) ?? 0) + count);
  }
  assert(counts.size <= tags.size, 'fileInstanceCounts: each component comes from a tag name');
  return { file, counts };
}

/**
 * The components with each count brought up to the live files: a component whose scan wrote its
 * per-file shares has those files' scanned shares replaced by their live ones. A component from an
 * older host (no `uses`) keeps its scanned count. The same array is returned when nothing changes,
 * so the panel does not redraw for an edit that moves no count.
 */
export function withLiveInstances(components: readonly ScanComponent[], files: readonly FileInstances[]): readonly ScanComponent[] {
  if (files.length === 0) {
    return components;
  }
  const keys = new Set(files.map((entry) => entry.file));
  assert(keys.size === files.length, 'withLiveInstances: each file is held once');
  let changed = false;
  const out = components.map((component) => {
    const total = liveTotal(component, files, keys);
    if (total === undefined || total === component.instances) {
      return component;
    }
    changed = true;
    return { ...component, instances: total };
  });
  return changed ? out : components;
}

/** A file whose live share the panel holds: the open one, or one left before the scan caught up. */
export interface HeldFile {
  readonly instances: FileInstances;
  /** The scans begun when the file was left (scanSequence.ts); undefined while it is open. */
  readonly leftAfter: number | undefined;
}

export interface HeldFilesInput {
  /** The open file's live share; undefined when no editable file is open. */
  readonly current: FileInstances | undefined;
  /** The sequence of the scan the panel shows (scanSequenceOf). */
  readonly appliedScan: number;
  /** How many scans have begun by now (scanSequenceLatest). */
  readonly latestScan: number;
}

// Files left without a scan since: past this, the longest-left is let go to the scan's count. A
// person leaves one file per navigation, and any scan clears them all, so this is never reached
// in use; it only keeps the map from growing in a window that never rescans.
export const HELD_FILES_MAX = 256;

/**
 * The files whose live shares the panel uses, after one render: the open file is held at its live
 * share; a file just left is stamped with the scans begun so far, and dropped once the panel shows
 * a scan that began after it — that scan read the file as its last save left it. Leaving waits for
 * the save (savedForNavigation), so every scan begun after leaving has the file's last bytes.
 * Returns the same map when nothing changes.
 */
export function nextHeldFiles(held: ReadonlyMap<string, HeldFile>, input: HeldFilesInput): ReadonlyMap<string, HeldFile> {
  assert(input.appliedScan <= input.latestScan, 'nextHeldFiles: the shown scan has begun');
  const next = new Map<string, HeldFile>();
  let changed = false;
  for (const [file, entry] of held) {
    if (file === input.current?.file) {
      continue;
    }
    const leftAfter = entry.leftAfter ?? input.latestScan;
    if (input.appliedScan > leftAfter) {
      changed = true;
      continue;
    }
    changed = changed || entry.leftAfter === undefined;
    next.set(file, entry.leftAfter === undefined ? { instances: entry.instances, leftAfter } : entry);
  }
  if (input.current !== undefined) {
    const before = held.get(input.current.file);
    changed = changed || before?.instances !== input.current || before.leftAfter !== undefined;
    next.set(
      input.current.file,
      before?.instances === input.current && before.leftAfter === undefined ? before : { instances: input.current, leftAfter: undefined },
    );
  }
  for (const file of next.keys()) {
    if (next.size <= HELD_FILES_MAX) {
      break;
    }
    if (file !== input.current?.file) {
      next.delete(file);
      changed = true;
    }
  }
  assert(next.size <= HELD_FILES_MAX, 'nextHeldFiles: the held files are bounded');
  return changed || next.size !== held.size ? next : held;
}

// One component's count with the held files' shares swapped; undefined when the scan wrote no shares.
function liveTotal(component: ScanComponent, files: readonly FileInstances[], keys: ReadonlySet<string>): number | undefined {
  const uses = component.uses;
  const scanned = component.instances;
  if (uses === undefined || scanned === undefined) {
    return undefined;
  }
  let total = scanned;
  for (const use of uses) {
    if (keys.has(use.file)) {
      total -= use.count;
    }
  }
  // The parser checked the shares sum to the total, so removing some of them leaves no debt.
  assert(total >= 0, 'liveTotal: the scanned shares are part of the total');
  for (const entry of files) {
    total += entry.counts.get(component.path) ?? 0;
  }
  assert(Number.isSafeInteger(total), 'liveTotal: a count is an integer');
  return total;
}

// Every tag name in the tree and how often it opens a tag: component nodes once each, and tags the
// tree keeps as text (an expression it does not model, a comment, an attribute value, a script)
// as the scan's pattern reads them. Iterative and bounded by the page-tree node limit.
function tagCounts(nodes: readonly InstanceCountNode[]): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  const stack: InstanceCountNode[] = [...nodes];
  let visited = 0;
  while (stack.length > 0) {
    visited += 1;
    assert(visited <= LIMITS.treeNodesMax, 'tagCounts: the tree stays within the page-tree limit');
    const node = stack.pop();
    assert(node !== undefined, 'tagCounts: a queued node exists');
    if (node.kind === 'component' || node.kind === 'element') {
      if (node.name !== undefined && node.dynamicTag !== true && node.astroAsset !== true) {
        counts.set(node.name, (counts.get(node.name) ?? 0) + 1);
      }
    }
    countTextTags(counts, node);
    if (node.children !== undefined) {
      stack.push(...node.children);
    }
  }
  return counts;
}

function countTextTags(counts: Map<string, number>, node: InstanceCountNode): void {
  if (node.kind === 'expr' || node.kind === 'raw-line' || node.kind === 'comment') {
    countPattern(counts, node.value);
  }
  if (node.kind === 'raw') {
    countPattern(counts, node.inner);
  }
  for (const attr of Object.values(node.props ?? {})) {
    countPattern(counts, attr.value);
  }
}

function countPattern(counts: Map<string, number>, text: string | undefined): void {
  if (text === undefined || !text.includes('<')) {
    return;
  }
  assert(text.length <= LIMITS.sourceBytesMax, 'countPattern: text comes from a bounded source');
  for (const match of text.matchAll(TAG_PATTERN)) {
    const name = match[1];
    if (name !== undefined) {
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
}
