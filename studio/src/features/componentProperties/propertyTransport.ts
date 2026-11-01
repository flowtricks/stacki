import { request } from '../project/projectClient';
import { record, string } from '../../shared/validation';
import { parseComponentProperties, parsePropertiesResult, type PropertyChange } from '../../../vendor/stacki/shared/properties/propertyEditing';

const endpoint = '/studio/api/component-properties';
export async function readComponentProperties(_project: string, file: string) {
  return parsePropertiesResult(await request(endpoint + '?file=' + encodeURIComponent(file)), parseComponentProperties);
}
export async function editComponentProperties(_project: string, file: string, source: string, change: PropertyChange) {
  const result = parsePropertiesResult(await post({ file, source, change }), (value) => ({
    ...parseComponentProperties(value),
    undo: undoToken(value),
  }));
  if (result.ok) {
    window.dispatchEvent(new Event('studio:source-updated'));
  }
  return result;
}
export async function revertComponentProperties(token: string) {
  const result = parsePropertiesResult(await post({ undo: token }), (value) => ({
    undo: undoToken(value),
  }));
  if (result.ok) {
    window.dispatchEvent(new Event('studio:source-updated'));
  }
  return result;
}
function post(body: unknown) {
  return request(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}
function undoToken(value: unknown) {
  const token = string(record(value)['undo'], 36);
  if (!/^[0-9a-f-]{36}$/.test(token)) {
    throw new Error('Invalid property history token');
  }
  return token;
}
export function onPropertyFilesChanged(callback: (value: { files: string[] }) => void) {
  const changed = () => callback({ files: [] });
  window.addEventListener('studio:source-updated', changed);
  return () => window.removeEventListener('studio:source-updated', changed);
}
