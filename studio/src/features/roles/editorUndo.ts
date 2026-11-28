// A limited role's own recent changes to one document, so its undo and redo work.
// Undo arrives as a plain text edit that takes something back: taking back a
// delete looks like adding an element, which the role's limits would refuse. The
// room therefore lets a person step back and forth through states their own
// accepted changes made, exactly, and only while nobody else has changed the file
// since. Anything else is judged as a new edit (documentAccess.ts).
import { assert } from '../../../vendor/stacki/shared/core/assert';
import { EDITOR_PARTS } from '../../../vendor/stacki/shared/properties/projectRoles';
import type { RoleView } from '../../../vendor/stacki/shared/properties/projectRoles';

export const EDITOR_UNDO_LIMITS = {
  /** States kept for one person in one document. */
  statesMax: 100,
  /** Characters those states may hold together. */
  charsMax: 4_000_000,
  /** People remembered in one document: a room's own connection bound. */
  peopleMax: 30,
} as const satisfies Record<string, number>;

interface Chain {
  /** The options in force when the chain was recorded: a changed limit starts it again. */
  readonly limits: string;
  readonly states: readonly string[];
  readonly at: number;
}

export interface Change {
  readonly current: string;
  readonly next: string;
}

const limitsOf = (role: RoleView): string => EDITOR_PARTS.filter((part) => role.editorOff.has(part)).join(' ');

const total = (states: readonly string[]): number => states.reduce((sum, state) => sum + state.length, 0);

export class EditorUndo {
  private readonly chains = new Map<string, Chain>();

  /** Whether going from `current` to `next` is this person's own undo or redo. */
  steps(person: string, role: RoleView, change: Change): boolean {
    const chain = this.chains.get(person);
    if (chain === undefined || chain.limits !== limitsOf(role)) {
      return false;
    }
    return chain.states[chain.at] === change.current && chain.states.includes(change.next);
  }

  /** Records one accepted change by `person`. */
  record(person: string, role: RoleView, change: Change): void {
    assert(person.length > 0, 'A change belongs to a person');
    const chain = this.chains.get(person);
    if (chain !== undefined && this.steps(person, role, change)) {
      this.chains.set(person, { ...chain, at: chain.states.indexOf(change.next) });
      return;
    }
    const continues = chain !== undefined && chain.limits === limitsOf(role) && chain.states[chain.at] === change.current;
    const states = continues ? [...chain.states.slice(0, chain.at + 1), change.next] : [change.current, change.next];
    while (states.length > 1 && (states.length > EDITOR_UNDO_LIMITS.statesMax || total(states) > EDITOR_UNDO_LIMITS.charsMax)) {
      states.shift();
    }
    this.chains.delete(person);
    if (this.chains.size >= EDITOR_UNDO_LIMITS.peopleMax) {
      const oldest = this.chains.keys().next();
      if (!oldest.done) {
        this.chains.delete(oldest.value);
      }
    }
    this.chains.set(person, { limits: limitsOf(role), states, at: states.length - 1 });
    assert(this.chains.size <= EDITOR_UNDO_LIMITS.peopleMax, 'Remembered people are bounded');
  }
}
