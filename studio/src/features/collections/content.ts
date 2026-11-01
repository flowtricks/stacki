import { parseDocument } from 'yaml';
import { parseTree, findNodeAtLocation, modify, applyEdits, type ParseError } from 'jsonc-parser';
import { record } from '../../shared/validation';

export function collectionContent(file: string, source: string) {
  if (file.endsWith('.json')) {
    const fields = record(JSON.parse(source));
    return {
      fields,
      body: undefined,
      change: (key: string, value: unknown) => updateJson(source, key, value),
    };
  }
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source);
  if (!match) {
    return { fields: {}, body: source, change: (_key: string, _value: unknown) => source };
  }
  const frontmatter = parseDocument(match[1] ?? '');
  if (frontmatter.errors.length) {
    throw new Error(frontmatter.errors[0]?.message);
  }
  const fields = record(frontmatter.toJS({ maxAliasCount: 50 }) ?? {});
  const body = source.slice(match[0].length);
  return {
    fields,
    body,
    change: (key: string, value: unknown) => {
      frontmatter.set(key, value);
      return '---\n' + frontmatter.toString() + '---\n' + body;
    },
  };
}
function updateJson(source: string, key: string, value: unknown) {
  const errors: ParseError[] = [];
  const root = parseTree(source, errors);
  if (!root || errors.length || !findNodeAtLocation(root, [key])) {
    throw new Error('Collection changed. Reload its fields.');
  }
  return applyEdits(source, modify(source, [key], value, { formattingOptions: { insertSpaces: true, tabSize: 2 } }));
}
