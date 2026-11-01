import { request } from '../project/projectClient';
import { record, sourcePath, string } from '../../shared/validation';
let versions: Readonly<Record<string, string>> = {};
let reading: Promise<unknown> | undefined;

export function readVariables() {
  // The navigation and sheet share one in-flight scan.
  reading ??= request('/studio/api/variables')
    .then((response) => {
      const data = record(response);
      const incoming = record(data['versions']);
      if (Object.keys(incoming).length > 1000) {
        throw new Error('Variable file limit exceeded');
      }
      versions = Object.fromEntries(Object.entries(incoming).map(([file, version]) => [sourcePath(file), string(version, 64)]));
      return data;
    })
    .finally(() => {
      reading = undefined;
    });
  return reading;
}
export async function editVariables(operation: string, payload: unknown) {
  const result = await request('/studio/api/variables', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ operation, payload, versions }),
  });
  window.dispatchEvent(new Event('studio:source-updated'));
  return result;
}
export function onVariablesChanged(callback: () => void) {
  window.addEventListener('studio:source-updated', callback);
  return () => window.removeEventListener('studio:source-updated', callback);
}
export async function restoreVariableTexts(expected: Readonly<Record<string, string>>, texts: Readonly<Record<string, string>>) {
  const result = record(await editVariables('restoreCssVariables', { expected, texts }));
  if (result['ok'] !== true) {
    throw new Error(string(result['error'] ?? 'Could not restore the stylesheet.'));
  }
}
