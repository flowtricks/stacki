import { formatFor } from '../../../vendor/stacki/electron/content/contentEntries';
import { parse as frontmatter } from '../../../vendor/stacki/electron/content/formats/markdownEntry';
import { parseIpcPayload } from '../../../vendor/stacki/shared/ipc/ipcPayloads';
import { record } from '../../shared/validation';

export function checkContentExpected(sources: ReadonlyMap<string, string>, payload: unknown, expected: unknown) {
  const input = parseIpcPayload('content:writeEntry', payload);
  const source = sources.get(input.entry.file);
  const format = formatFor(input.entry.file);
  if (source === undefined || !format) {
    throw new Error('Content entry is no longer available.');
  }
  let current: unknown = format.parseData(source) ?? {};
  for (const part of input.entry.locator ?? []) {
    current = typeof part === 'number' && Array.isArray(current) ? current[part] : record(current)[part];
  }
  const before = record(expected);
  const sameData = JSON.stringify(current) === JSON.stringify(before['data']);
  const sameBody = before['body'] === undefined || frontmatter(source).body === before['body'];
  if (!sameData || !sameBody) {
    throw new Error('A collaborator changed this entry. Reopen it before saving.');
  }
}
