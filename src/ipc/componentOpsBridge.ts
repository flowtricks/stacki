// The renderer's side of the Components panel's duplicate and delete: each reply is read at the boundary into a
// Result, so a refusal (a component still used, a path outside the component folders) reaches the caller as a value.
import { boolean, count, record, text } from '../../shared/core/boundary';
import { err, ok, type Result } from '../../shared/core/result';
import { parseIpcPayload } from '../../shared/ipc/ipcPayloads';
import {
  parseComponentRenameApplied,
  parseComponentRenameSummary,
  type ComponentRenameRequest,
  type ComponentRenameSummary,
  type RenameDirection,
} from '../../shared/properties/componentRename';
import { parseComponentOpError, type ComponentOpError, type ComponentOpTarget, type ComponentUses } from '../../shared/properties/componentOps';
import { parseComponentRemovalPreview, type ComponentRemovalPreview } from '../../shared/properties/componentRemoval';

export interface ComponentCopy {
  readonly kind: 'component' | 'folder';
  readonly path: string;
  readonly name: string;
  readonly files: number;
}

export interface ComponentRemoval {
  readonly name: string;
  readonly files: number;
  /** Handed back to `restoreRemovedComponent` by Undo. */
  readonly undo: string;
}

export interface ComponentRestore {
  readonly files: number;
  readonly metadata: 'restored' | 'kept' | 'untouched';
}

export async function duplicateProjectComponent(projectPath: string, target: ComponentOpTarget): Promise<Result<ComponentCopy, ComponentOpError>> {
  const payload = parseIpcPayload('component:duplicate', { projectPath, target });
  return readReply(await window.avb.duplicateComponent(payload), (value) => {
    const kind = value['kind'];
    if (kind !== 'component' && kind !== 'folder') {
      throw new Error('Unknown component copy kind');
    }
    return { kind, path: text(value['path']), name: text(value['name']), files: count(value['files']) };
  });
}

/** What deleting a component would remove, edit and clean, and what blocks it: worked out by main without writing. */
export async function planProjectComponentRemoval(projectPath: string, target: ComponentOpTarget): Promise<Result<ComponentRemovalPreview, ComponentOpError>> {
  const payload = parseIpcPayload('component:planRemove', { projectPath, target });
  return readReply(await window.avb.planComponentRemoval(payload), parseComponentRemovalPreview);
}

export async function removeProjectComponent(
  projectPath: string,
  target: ComponentOpTarget,
  uses: ComponentUses,
): Promise<Result<ComponentRemoval, ComponentOpError>> {
  const payload = parseIpcPayload('component:remove', { projectPath, target, uses });
  return readReply(await window.avb.removeComponent(payload), (value) => ({
    name: text(value['name']),
    files: count(value['files']),
    undo: text(value['undo']),
  }));
}

export async function restoreRemovedProjectComponent(undo: string): Promise<Result<ComponentRestore, ComponentOpError>> {
  const payload = parseIpcPayload('component:restoreRemoved', { token: undo });
  return readReply(await window.avb.restoreRemovedComponent(payload), (value) => {
    const metadata = value['metadata'];
    if (metadata !== 'restored' && metadata !== 'kept' && metadata !== 'untouched') {
      throw new Error('Unknown component restore outcome');
    }
    return { files: count(value['files']), metadata };
  });
}

function readReply<T>(input: unknown, parseValue: (value: Record<string, unknown>) => T): Result<T, ComponentOpError> {
  const reply = record(input);
  if (boolean(reply['ok'])) {
    return ok(parseValue(record(reply['value'])));
  }
  return err(parseComponentOpError(reply['error']));
}

/** The files a rename would change, worked out by main without writing anything. */
export async function planProjectComponentRename(
  projectPath: string,
  request: ComponentRenameRequest,
): Promise<Result<ComponentRenameSummary, ComponentOpError>> {
  const payload = parseIpcPayload('component:planRename', { projectPath, request });
  return readReply(await window.avb.planComponentRename(payload), parseComponentRenameSummary);
}

/** Renames or moves the component and everything that names it, all files or none. `undo` is the token for the whole step. */
export async function renameProjectComponent(
  projectPath: string,
  request: ComponentRenameRequest,
): Promise<Result<ComponentRenameSummary & { readonly undo: string }, ComponentOpError>> {
  const payload = parseIpcPayload('component:rename', { projectPath, request });
  return readReply(await window.avb.renameComponent(payload), parseComponentRenameApplied);
}

export async function revertProjectComponentRename(undo: string, direction: RenameDirection): Promise<Result<{ readonly files: number }, ComponentOpError>> {
  const payload = parseIpcPayload('component:revertRename', { token: undo, direction });
  return readReply(await window.avb.revertComponentRename(payload), (value) => ({ files: count(value['files']) }));
}
