// Editing one property from outside the Properties panel: a picker row's
// settings (PropertySettingsDialog.tsx). The transaction is the panel's: the open
// file is saved first, the change is applied against the source that was read,
// so a newer file is refused rather than overwritten; main updates every
// reference and instance on a rename; and one undo step reverts the batch.

import { assert } from '../../../shared/core/assert';
import { err, ok, type Result } from '../../../shared/core/result';
import type { ComponentProperty, PropertyChange } from '../../../shared/properties/propertyEditing';
import { propertyIsEditable } from './PropertyEditor';
import { editComponentProperties, readComponentProperties } from './propertiesBridge';
import { savePhaseOf, type PropertySaveOutcome } from './propertyAutosave';

/** What a property edit needs from the app: the file, and its save and undo steps. */
export interface PropertySaver {
  readonly projectPath: string;
  readonly file: string;
  readonly flushSave: () => Promise<unknown>;
  readonly changePhase: (phase: 'idle' | 'saving' | 'autosaving') => void;
  readonly recordUndo: (token: string) => void;
  readonly completeSave: () => Promise<void>;
}

/** A property as the form opens on it, with the source a save is checked against. */
export interface LoadedProperty {
  readonly property: ComponentProperty;
  readonly source: string;
  readonly frontmatter: string;
  readonly editable: boolean;
}

/** Reads the property from the saved file, or says why it cannot be. */
export async function loadProperty(saver: PropertySaver, key: string): Promise<Result<LoadedProperty, string>> {
  assert(key !== '', 'loadProperty: a property is named');
  await saver.flushSave();
  const read = await readComponentProperties(saver.projectPath, saver.file);
  if (!read.ok) {
    return err(read.error.message);
  }
  const property = read.value.properties.find((candidate) => candidate.name === key);
  if (property === undefined) {
    return err(`This component no longer has a ${key} property.`);
  }
  assert(property.name === key, 'loadProperty: the property found is the one named');
  const { source, frontmatter } = read.value;
  return ok({ property, source, frontmatter, editable: propertyIsEditable(property, read.value) });
}

/** Applies the change against `source`, and says what became of it. */
export async function saveProperty(saver: PropertySaver, source: string, change: PropertyChange): Promise<PropertySaveOutcome> {
  assert(change.kind === 'save', 'saveProperty: a form saves a property, nothing else');
  saver.changePhase(savePhaseOf(change));
  try {
    await saver.flushSave();
    const result = await editComponentProperties(saver.projectPath, saver.file, source, change);
    if (!result.ok) {
      return { kind: result.error.code === 'conflict' ? 'conflict' : 'refused', message: result.error.message };
    }
    saver.recordUndo(result.value.undo);
    await saver.completeSave();
    return { kind: 'saved', source: result.value.source };
  } finally {
    saver.changePhase('idle');
  }
}
