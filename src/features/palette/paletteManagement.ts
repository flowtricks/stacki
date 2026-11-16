// What the Components panel's "…" menu asks of the app beyond showing instances and roles: open a component's
// settings, duplicate a component or a folder, delete one. The panel only describes what was chosen; the host
// (Desktop's shell) confirms, calls main, rescans and records the undo step. A host without these operations
// (Studio today: its server has no component copy or trash, see docs/contracts.md) passes none, and the
// menu leaves the rows out rather than showing ones that cannot work.
import type { ScanComponent } from '../../../shared/properties/projectScan';
import type { Result } from '../../../shared/core/result';
import type { ComponentOpError, ComponentOpTarget } from '../../../shared/properties/componentOps';
import type { ComponentRenameRequest, ComponentRenameSummary } from '../../../shared/properties/componentRename';

/** The component or folder a menu row acts on, with what a confirmation says about it. */
export interface ManagedItem extends ComponentOpTarget {
  /** The component's or folder's display name. */
  readonly name: string;
  /** Component files it holds: one for a component. */
  readonly files: number;
}

/** What the rename and move dialog needs from its host: the component folders, a preview of the files a rename changes, and the rename itself. */
export interface RenameHost {
  /** The configured component folders, project-relative (`src/components`). */
  readonly roots: readonly string[];
  readonly plan: (request: ComponentRenameRequest) => Promise<Result<ComponentRenameSummary, ComponentOpError>>;
  readonly apply: (component: ScanComponent, request: ComponentRenameRequest, change: 'rename' | 'move' | 'both') => void;
}

export interface PaletteManagement {
  /** Absent (Studio, a package component): the Rename and Move rows are left out. */
  readonly rename?: RenameHost | undefined;
  readonly editSettings: (component: ScanComponent) => void;
  readonly duplicate: (item: ManagedItem) => void;
  readonly remove: (item: ManagedItem) => void;
}
