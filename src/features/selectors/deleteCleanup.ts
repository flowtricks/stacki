// After an element is deleted, offer to remove the styles that only it used.
// The offer names only selectors the deleted markup carried a class or id for,
// so it never surfaces leftovers the user did not just create; those stay in
// the style selectors panel. The check waits for the deletion to reach disk:
// until then the file still uses the class and every verdict says "used".
import { assert } from '../../../shared/core/assert';
import type { Attr } from '../../../shared/page/pageNode';
import { reportActionToast } from '../../ui/errorNotices';
import { readSelectorReport, removeSelectors, restoreSelectors } from './selectorsBridge';
import type { SelectorEntry } from '../../../shared/properties/selectorUsage';

export const DELETE_CLEANUP_LIMITS = {
  /** Nodes walked in one deleted subtree; past this the offer is skipped. */
  nodesMax: 20_000,
  /** Save-state polls before giving up: 40 × 250 ms is ten seconds. */
  savePollsMax: 40,
  savePollMs: 250,
  /** Selectors named in the toast before "and N more". */
  namedMax: 3,
} as const satisfies Record<string, number>;

interface NamedNode {
  readonly props?: Readonly<Record<string, Attr>> | undefined;
  readonly children?: readonly NamedNode[] | undefined;
}

/** The class and id names written as plain strings anywhere in a subtree. */
export function namesInSubtree(root: NamedNode): readonly string[] {
  const names = new Set<string>();
  const stack: NamedNode[] = [root];
  let visited = 0;
  while (stack.length > 0) {
    visited += 1;
    if (visited > DELETE_CLEANUP_LIMITS.nodesMax) {
      return [];
    }
    const node = stack.pop();
    assert(node !== undefined, 'namesInSubtree: the stack was not empty');
    for (const key of ['class', 'className', 'id']) {
      const attr = node.props?.[key];
      if (attr?.type === 'string') {
        for (const name of attr.value.split(/\s+/)) {
          if (name !== '') {
            names.add(name);
          }
        }
      }
    }
    stack.push(...(node.children ?? []));
  }
  return [...names];
}

export interface DeleteCleanupHost {
  readonly projectPath: string;
  /** Whether the open page's edits have all reached disk. */
  readonly saved: () => boolean;
  readonly showToast: (message: string, kind?: 'info' | 'success' | 'error') => void;
  readonly pushCommand: (command: { readonly label: string; readonly undo: () => Promise<void>; redo: () => Promise<void> }) => void;
}

/** Check, once the deletion is saved, for selectors only the deleted names fed. */
export async function offerStyleCleanup(host: DeleteCleanupHost, names: readonly string[]): Promise<void> {
  if (names.length === 0) {
    return;
  }
  if (!(await waitForSave(host.saved))) {
    return;
  }
  const report = await readSelectorReport(host.projectPath);
  if (!report.ok) {
    return;
  }
  const deleted = new Set(names);
  const orphans = report.value.entries.filter((entry) => entry.verdict.kind === 'unused' && entry.verdict.names.some((name) => deleted.has(name)));
  if (orphans.length === 0) {
    return;
  }
  const files = report.value.files.filter((file) => orphans.some((entry) => entry.rel === file.rel));
  reportActionToast(`Nothing uses ${describe(orphans)} any more.`, 'info', [
    {
      label: orphans.length === 1 ? 'Remove style' : 'Remove styles',
      run: async () => {
        const result = await removeSelectors(
          host.projectPath,
          orphans.map((entry) => entry.id),
          files,
        );
        if (!result.ok) {
          host.showToast(result.error, 'error');
          return;
        }
        const { changes, removed } = result.value;
        host.pushCommand({
          label: 'Remove unused styles',
          undo: () => restoreSelectors(host.projectPath, changes, 'before'),
          redo: () => restoreSelectors(host.projectPath, changes, 'after'),
        });
        host.showToast(removed === 1 ? 'Removed 1 unused selector' : `Removed ${removed} unused selectors`, 'success');
      },
    },
  ]);
}

function describe(entries: readonly SelectorEntry[]): string {
  const named = entries.slice(0, DELETE_CLEANUP_LIMITS.namedMax).map((entry) => entry.selector);
  const rest = entries.length - named.length;
  return rest > 0 ? `${named.join(', ')} and ${rest} more` : named.join(', ');
}

async function waitForSave(saved: () => boolean): Promise<boolean> {
  for (let poll = 0; poll < DELETE_CLEANUP_LIMITS.savePollsMax; poll += 1) {
    await new Promise((resolve) => setTimeout(resolve, DELETE_CLEANUP_LIMITS.savePollMs));
    if (saved()) {
      return true;
    }
  }
  return false;
}
