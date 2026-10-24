import type * as Y from 'yjs';
import { getEditorRole, type EditorRole } from '../roles/roleStore';
interface Command {
  readonly role?: EditorRole;
  readonly undo: () => unknown;
  readonly redo: () => unknown;
  readonly coalesceKey?: string;
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
    if (
      command.coalesceKey &&
      previous?.role === command.role &&
      previous?.coalesceKey === command.coalesceKey &&
      Date.now() - this.last < 600
    ) {
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
  async step(direction: 'undo' | 'redo') {
    if (this.restoring) {
      return;
    }
    const from = direction === 'undo' ? this.past : this.future;
    const to = direction === 'undo' ? this.future : this.past;
    const command = from.pop();
    if (!command) {
      return;
    }
    if (getEditorRole() === 'client' && command.role !== 'client') {
      from.push(command);
      throw new Error('Switch to Developer to undo or redo Developer changes.');
    }
    this.restoring = true;
    try {
      await command[direction]();
      to.push(command);
    } catch (error) {
      from.push(command);
      throw error;
    } finally {
      this.restoring = false;
    }
  }
}
