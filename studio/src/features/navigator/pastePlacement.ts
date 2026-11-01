import { VOID_TAGS } from '../../../vendor/stacki/src/editor/elementSchemas';
import type { Component } from '../project/projectClient';
import { resolveImport } from '../source/imports';
import { nodeAt, parsePage } from '../source/source';

export function pastePlacement(source: string, file: string, target: string, components: readonly Pick<Component, 'file' | 'name' | 'slots' | 'importPath'>[]) {
  const node = nodeAt(source, target);
  if (node.id === 'layout' || (node.kind === 'element' && !VOID_TAGS.has(node.name.toLowerCase()))) {
    return 'inside';
  }
  if (node.kind === 'component') {
    const parsed = parsePage(source);
    const imported = parsed.editable ? parsed.model.imports.find((item) => item.name === node.name) : undefined;
    const resolved = resolveImport(file, imported?.path, components);
    const component = components.find((item) => (resolved ? item.file === resolved : item.name === node.name));
    if (component?.slots.includes('default')) {
      return 'inside';
    }
  }
  return 'after';
}
