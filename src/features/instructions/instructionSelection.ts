// The file the Instructions panel has open, shared by the panel (which picks it)
// and the reading view over the canvas (which shows it). Kept here rather than in
// the app's state: nothing else in the app reads it, and the two components sit
// in different parts of the shell. One window opens one project, so one value.
import { useSyncExternalStore } from 'react';
import { assert } from '../../../shared/core/assert';

export interface InstructionSelection {
  readonly projectPath: string;
  readonly file: string;
}

let current: InstructionSelection | undefined;
const listeners = new Set<() => void>();
/** The panel, the view and the settings tab: a handful, never more. */
const LISTENERS_MAX = 16;

export function selectedInstruction(): InstructionSelection | undefined {
  return current;
}

export function selectInstruction(next: InstructionSelection | undefined): void {
  assert(next === undefined || next.file.length > 0, 'A selected instruction names a file');
  if (next?.file === current?.file && next?.projectPath === current?.projectPath) {
    return;
  }
  current = next;
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: () => void): () => void {
  assert(listeners.size < LISTENERS_MAX, 'Instruction selection listeners are bounded');
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The open file for `projectPath`; a selection left from another project reads as none. */
export function useInstructionSelection(projectPath: string): string | undefined {
  const selection = useSyncExternalStore(subscribe, selectedInstruction, selectedInstruction);
  return selection?.projectPath === projectPath ? selection.file : undefined;
}
