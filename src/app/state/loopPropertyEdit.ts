// Renaming a list setting's property, or changing its tooltip, from the loop
// panel's Property settings (LoopBinding.tsx). It goes through the same
// transaction as the Properties panel: the open file is saved first, the
// change is applied against that revision, every page passing the property
// is updated by a rename, and one undo step reverts the batch.

import {
  editComponentProperties,
  readComponentProperties,
} from '../../features/componentProperties/propertiesBridge';
import { propertyName } from '../../../shared/properties/propertyEditing';
import { assert } from '../../../shared/core/assert';

export interface LoopPropertyEdit {
  readonly name: string;
  readonly description: string;
}

export interface LoopPropertySaver {
  readonly projectPath: string;
  readonly file: string;
  readonly flushSave: () => Promise<unknown>;
  readonly changePhase: (phase: 'idle' | 'saving') => void;
  readonly recordUndo: (token: string) => void;
  readonly completeSave: () => Promise<void>;
}

/** Applies the edit; undefined when it was saved, or why it was not. */
export async function editLoopProperty(
  saver: LoopPropertySaver,
  key: string,
  edit: LoopPropertyEdit,
): Promise<string | undefined> {
  assert(key !== '', 'A property is named');
  try {
    propertyName(edit.name);
  } catch (caught: unknown) {
    return caught instanceof Error ? caught.message : String(caught);
  }
  saver.changePhase('saving');
  try {
    await saver.flushSave();
    const read = await readComponentProperties(saver.projectPath, saver.file);
    if (!read.ok) {
      return read.error.message;
    }
    const property = read.value.properties.find((candidate) => candidate.name === key);
    if (property === undefined) {
      return `This component no longer has a ${key} property.`;
    }
    const change = {
      kind: 'save' as const,
      originalName: key,
      property: { ...property, name: edit.name, description: edit.description },
    };
    const result = await editComponentProperties(
      saver.projectPath,
      saver.file,
      read.value.source,
      change,
    );
    if (!result.ok) {
      return result.error.message;
    }
    saver.recordUndo(result.value.undo);
    await saver.completeSave();
    return undefined;
  } finally {
    saver.changePhase('idle');
  }
}
