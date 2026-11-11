import type * as Y from 'yjs';
import { getEditorRole, type EditorRole } from '../roles/roleStore';
interface Command {
  readonly role?: EditorRole;
  readonly undo: () => unknown;
  readonly redo: () => unknown;
  readonly coalesceKey?: string;
  /** The step's name when an app named it (docs/apps.md, "Undo labels"); shown when it is undone or redone. */
  label?: string;
}
export class EditorHistory {
  private readonly past: Command[] = [];
  private readonly future: Command[] = [];
  private restoring = false;
  private last = 0;
  constructor(private readonly manager: Y.UndoManager) {
    manager.on('stack-item-added', (event) => {
      if (!this.restoring && event.type === 'undo') {
        this.record({ undo: () => manager.undo(), redo: () => manager.redo() }, true);
      }
    });
  }
  record(command: Command, source = false) {
    if (this.restoring) {
      return;
    }
    command = { ...command, role: getEditorRole() };
    if (!source) {
      this.manager.stopCapturing();
    }
    const previous = this.past.at(-1);
    if (command.coalesceKey && previous?.role === command.role && previous?.coalesceKey === command.coalesceKey && Date.now() - this.last < 600) {
      this.past[this.past.length - 1] = { ...command, undo: previous.undo };
    } else {
      this.past.push(command);
    }
    if (this.past.length > 200) {
      this.past.shift();
    }
    this.future.length = 0;
    this.last = Date.now();
  }
  /** The newest step, so an edit can tell whether it made one. */
  newest(): object | undefined {
    return this.past.at(-1);
  }
  /** Names the newest step when it is not `before`: the edit just run made it. A step it folded into keeps its name. */
  labelNewest(before: object | undefined, label: string) {
    const newest = this.past.at(-1);
    if (newest === undefined || newest === before) {
      return;
    }
    newest.label = label;
  }
  /** Undoes or redoes one step; resolves with the step's label, when it has one. */
  async step(direction: 'undo' | 'redo'): Promise<string | undefined> {
    if (this.restoring) {
      return undefined;
    }
    const from = direction === 'undo' ? this.past : this.future;
    const to = direction === 'undo' ? this.future : this.past;
    const command = from.pop();
    if (!command) {
      return undefined;
    }
    if (getEditorRole() === 'client' && command.role !== 'client') {
      from.push(command);
      throw new Error('Switch to Admin to undo or redo Admin changes.');
    }
    this.restoring = true;
    try {
      await command[direction]();
      to.push(command);
      return command.label;
    } catch (error) {
      from.push(command);
      throw error;
    } finally {
      this.restoring = false;
    }
  }
}
