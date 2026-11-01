import type { CanvasTextDocument } from '../../features/preview/useCanvasText';
import { canvasContentBinding } from '../../features/preview/canvasContentBinding';
import { canvasTextNodes, canvasTextTarget } from '../../features/preview/canvasTextSource';
import { readContentEntries, validateContentEntry, writeContentEntry, type ContentEntry } from '../../features/content/contentViewBridge';

import type { CanvasTextEdit } from '../../features/preview/canvasTextSource';

export async function canvasContentEdits(document: CanvasTextDocument): Promise<CanvasTextEdit[]> {
  const edits: CanvasTextEdit[] = [];
  const candidates = canvasTextNodes(document.nodes)
    .filter((entry) => !entry.scoped)
    .flatMap(({ node, parent }) => {
      const binding = canvasContentBinding(document.source, node);
      return binding && parent && ['element', 'component'].includes(parent.kind) ? [{ node, parent, binding }] : [];
    });
  if (candidates.length > 32) {
    return [];
  }
  const collections = [...new Set(candidates.map(({ binding }) => binding.collection))];
  if (collections.length > 8) {
    return [];
  }
  for (const name of collections) {
    const loaded = await readContentEntries(document.projectPath, name);
    if (!loaded.ok || loaded.value.readOnly || loaded.value.idsAreGuesses) {
      continue;
    }
    for (const { node, parent, binding } of candidates.filter((item) => item.binding.collection === name)) {
      const matches = loaded.value.entries.filter((entry) => entry.id === binding.entry);
      const entry = matches.length === 1 ? matches[0] : undefined;
      if (!entry || entry.error) {
        continue;
      }
      const value = fieldAt(entry.data, binding.fields);
      if (typeof value !== 'string') {
        continue;
      }
      const target = canvasTextTarget(node, parent, value, 'Shared CMS content · changes other uses too', document.pathFor);
      if (target) {
        edits.push({ target, apply: (next) => saveContentText(document, entry, binding, next) });
      }
    }
  }
  return edits;
}

async function saveContentText(
  document: CanvasTextDocument,
  entry: ContentEntry,
  binding: { readonly collection: string; readonly fields: readonly string[] },
  value: string,
) {
  const next = replaceField(entry.data, binding.fields, value);
  const validation = await validateContentEntry(document.projectPath, binding.collection, next);
  if (!validation.ok) {
    throw new Error(validation.error);
  }
  if (validation.value.error || validation.value.issues.length) {
    throw new Error(validation.value.error ?? validation.value.issues[0]?.message ?? 'Invalid text');
  }
  const saved = await writeContentEntry(document.projectPath, entry, [{ path: binding.fields, value }], undefined, { data: entry.data, body: entry.body });
  if (!saved.ok) {
    throw new Error(saved.error);
  }
}

function fieldAt(input: unknown, fields: readonly string[]): unknown {
  let value = input;
  for (const field of fields) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return undefined;
    }
    value = Object.getOwnPropertyDescriptor(value, field)?.value;
  }
  return value;
}

function replaceField(input: unknown, fields: readonly string[], value: string): unknown {
  if (fields.length === 0 || fields.length > 8) {
    throw new Error('Invalid CMS field path');
  }
  const parents: { readonly value: object; readonly field: string }[] = [];
  let current = input;
  for (const field of fields) {
    if (typeof current !== 'object' || current === null || Array.isArray(current) || !Object.hasOwn(current, field)) {
      throw new Error('The CMS field no longer exists');
    }
    parents.push({ value: current, field });
    current = fieldAt(current, [field]);
  }
  let result: unknown = value;
  for (const parent of parents.reverse()) {
    result = { ...parent.value, [parent.field]: result };
  }
  return result;
}
