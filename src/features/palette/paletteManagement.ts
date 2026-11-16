// What the Components panel's "…" menu asks of the app beyond showing instances and roles: open a component's
// settings, duplicate a component or a folder, delete one. The panel only describes what was chosen; the host
// (Desktop's shell) confirms, calls main, rescans and records the undo step. A host without these operations
// (Studio today: its server has no component copy or trash, see docs/contracts.md) passes none, and the
// menu leaves the rows out rather than showing ones that cannot work.
import type { ScanComponent } from '../../../shared/properties/projectScan';
import type { ComponentOpTarget } from '../../../shared/properties/componentOps';

/** The component or folder a menu row acts on, with what a confirmation says about it. */
export interface ManagedItem extends ComponentOpTarget {
  /** The component's or folder's display name. */
  readonly name: string;
  /** Component files it holds: one for a component. */
  readonly files: number;
}

export interface PaletteManagement {
  readonly editSettings: (component: ScanComponent) => void;
  readonly duplicate: (item: ManagedItem) => void;
  readonly remove: (item: ManagedItem) => void;
}
