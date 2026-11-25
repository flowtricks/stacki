import { indentUnitOf } from '../../../vendor/stacki/shared/core/indent';
import { serializeNodes } from '../../../vendor/stacki/electron/parse/astroSerialize';
import { PLACEHOLDER_PROPS } from '../../../vendor/stacki/src/features/palette/astroAssets';
import { parseInsertContent } from './insertContentContract';
export { parseInsertContent } from './insertContentContract';
import { insertFragment } from './sourceOperations';
import { insertedContentNode } from './insertedContent';
import { parsePage, type Edit, type TreeAction } from './source';

export function contentInsertionEdits(source: string, action: Extract<TreeAction, { kind: 'insert-content' }>): Edit[] {
  const content = parseInsertContent(action.content);
  const parsed = parsePage(source);
  if (!parsed.editable) {
    throw new Error(parsed.reason);
  }
  const imports = parsed.model.imports;
  const existing =
    content.type === 'astroAsset' ? imports.find((item) => item.path === 'astro:assets' && item.imported === content.name && !item.typeOnly) : undefined;
  let name = existing?.name ?? (content.type === 'astroAsset' ? content.name : '');
  if (content.type === 'astroAsset' && !existing && imports.some((item) => item.name === name)) {
    name = `Astro${content.name}`;
    if (imports.some((item) => item.name === name)) {
      throw new Error('Import name conflict');
    }
  }
  const node =
    content.type === 'astroAsset' ? { kind: 'component' as const, name, props: { ...PLACEHOLDER_PROPS }, children: undefined } : insertedContentNode(content);
  const fragment = serializeNodes([node], indentUnitOf(source));
  const edits = [insertFragment(source, action, fragment, parsed.model.nodes.length === 0)];
  if (content.type === 'astroAsset' && !existing) {
    const imported = content.name === name ? name : `${content.name} as ${name}`;
    const statement = `import { ${imported} } from 'astro:assets';`;
    const eol = parsed.model.eol;
    const start = source.startsWith('---') ? 3 + eol.length : 0;
    edits.push({
      start,
      end: start,
      text: start ? statement + eol : `---${eol}${statement}${eol}---${eol}`,
    });
  }
  return edits;
}
