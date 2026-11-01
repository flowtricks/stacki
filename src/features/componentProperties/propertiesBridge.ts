import { parseIpcPayload } from '../../../shared/ipc/ipcPayloads';
import { parseComponentProperties, parsePropertiesResult } from '../../../shared/properties/propertyEditing';
import type { ComponentProperties, PropertyChange } from '../../../shared/properties/propertyEditing';
import { toRecord } from '../../../shared/core/record';
import type { Result } from '../../../shared/core/result';

export async function readComponentProperties(projectPath: string, file: string): Promise<Result<ComponentProperties>> {
  const payload = parseIpcPayload('component:properties', { projectPath, file });
  const result: unknown = await window.avb.componentProperties(payload);
  return parsePropertiesResult(result, parseComponentProperties);
}
/** An applied property batch, and the token of its inverse (step 6: Undo). */
export type EditedProperties = ComponentProperties & { readonly undo: string };

export async function editComponentProperties(projectPath: string, file: string, source: string, change: PropertyChange): Promise<Result<EditedProperties>> {
  const payload = parseIpcPayload('component:editProperties', {
    projectPath,
    file,
    source,
    change,
  });
  const result: unknown = await window.avb.editComponentProperties(payload);
  return parsePropertiesResult(result, (value) => ({
    ...parseComponentProperties(value),
    undo: undoToken(value),
  }));
}

/** Apply a property batch's inverse; the result names the batch that redoes it. */
export async function revertComponentProperties(token: string): Promise<Result<{ readonly undo: string }>> {
  const payload = parseIpcPayload('component:revertProperties', { token });
  const result: unknown = await window.avb.revertComponentProperties(payload);
  return parsePropertiesResult(result, (value) => ({ undo: undoToken(value) }));
}

// A token main minted (a UUID): bounded, never trusted as anything else.
function undoToken(value: unknown): string {
  const token = toRecord(value)?.['undo'];
  if (typeof token !== 'string' || !/^[0-9a-f-]{36}$/.test(token)) {
    throw new Error('Property result: expected an undo token');
  }
  return token;
}
