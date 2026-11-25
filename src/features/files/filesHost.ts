// What the Files panel needs from the app around it. The panel is a feature: it cannot reach the page editor, the
// Pages panel's rename planner or the Components panel's rename (eslint `stacki/source-layers`), so the app layer
// (src/app/shell/DesktopFiles.tsx) hands them in here. A host without them still works: every move is a plain move.
import type { ExplorerPath } from '../../../shared/ipc/fileExplorer';

export type FilesToastKind = 'info' | 'success' | 'warning' | 'error';

export interface FilesUndo {
  readonly label: string;
  readonly undo: () => Promise<void>;
  readonly redo: () => Promise<void>;
}

/**
 * A rename or move the app updates references for: a page (its links and imports, `.stacki/pages.json`) or a component
 * (its imports, tags and `.stacki/components.json` recipe keys). The runner asks, reports and records its own undo; it
 * answers whether the entry moved.
 */
export type ReferenceMove = () => Promise<boolean>;

export interface FilesHost {
  readonly projectPath: string;
  /** `darwin`, `win32` or `linux`: name rules and path separators follow it. */
  readonly platform: string;
  readonly showToast: (message: string, kind: FilesToastKind) => void;
  readonly recordUndo: (command: FilesUndo) => void;
  /** The reference-updating move for `from` → `to`, when the app has one; undefined for a plain move. */
  readonly referenceMove: (from: ExplorerPath, to: ExplorerPath) => ReferenceMove | undefined;
}
