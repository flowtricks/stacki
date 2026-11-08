// Whether the visitor has anything Reset would undo: a page or component whose text
// differs from the baked site, or a file the bake did not have (a project setting, an
// upload). The Reset pill shows only while this holds, so a fresh visit, a visit
// after Reset and a visit whose edits were all undone back to the bake show no pill,
// and the first edit that lands shows it.
//
// Saved room records cannot answer this alone: an edit undone back to the baked text
// still leaves its updates in storage. So each file's current text is compared with
// its baked text, once on load and then on every change to that file only.
import { assert } from '../vendor/stacki/shared/core/assert';
import { DEMO_PUBLISH_STATE_FILE } from './publish';

/** Files a demo can differ in at once: every file the bake holds is a bound already,
 * this states it for the set that tracks them. */
const DIFFERING_FILES_MAX = 10_000;

export type EditPresenceListener = (present: boolean) => void;

export class EditPresence {
  private readonly differing = new Set<string>();
  private readonly extraFiles = new Set<string>();
  private present: boolean;

  constructor(
    private readonly baked: (file: string) => string | undefined,
    initial: { readonly edited: ReadonlyMap<string, string>; readonly savedFiles: Iterable<string> },
    private readonly changed: EditPresenceListener,
  ) {
    for (const [file, text] of initial.edited) {
      this.recordText(file, text);
    }
    for (const file of initial.savedFiles) {
      this.recordFile(file);
    }
    this.present = this.has();
    assert(this.present === this.differing.size + this.extraFiles.size > 0, 'EditPresence: the first answer counts every difference');
  }

  /** True while anything differs from the bake. */
  has(): boolean {
    return this.differing.size > 0 || this.extraFiles.size > 0;
  }

  /** A file's text changed: it differs from the bake, or no longer does. */
  text(file: string, text: string): void {
    this.recordText(file, text);
    this.announce();
  }

  /** A file the bake did not have was saved: a project setting or an upload. */
  file(file: string): void {
    this.recordFile(file);
    this.announce();
  }

  private recordText(file: string, text: string): void {
    if (text === this.baked(file)) {
      this.differing.delete(file);
    } else {
      assert(this.differing.size < DIFFERING_FILES_MAX || this.differing.has(file), 'EditPresence: differing files stay bounded');
      this.differing.add(file);
    }
  }

  private recordFile(file: string): void {
    // The demo's own record of a pretend publish is not the visitor's edit to the site.
    if (file !== DEMO_PUBLISH_STATE_FILE) {
      assert(this.extraFiles.size < DIFFERING_FILES_MAX || this.extraFiles.has(file), 'EditPresence: saved files stay bounded');
      this.extraFiles.add(file);
    }
  }

  private announce(): void {
    const present = this.has();
    if (present !== this.present) {
      this.present = present;
      this.changed(present);
    }
  }
}
