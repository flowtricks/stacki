import { relativeImport } from '../source/imports';
import { frontmatterRange } from '../source/frontmatter';
import { parsePage } from '../source/source';
import type { Attr } from '../../../vendor/stacki/shared/page/pageNode';
import type { InlineNode } from '../../../vendor/stacki/src/features/props/RichContent';
import { serializeNodes } from '../../../vendor/stacki/electron/parse/astroSerialize';
import { applyEdits, attributeEdit, bounds, nodeAt, type Edit, type ParserNode } from '../source/source';

export function setAttributes(source: string, id: string, values: Readonly<Record<string, Attr | undefined>>) {
  for (const [name, value] of Object.entries(values)) {
    source = applyEdits(source, [
      attributeEdit(source, id, name, value?.type === 'bare' ? 'true' : value?.value, value?.type === 'expr' || value?.type === 'bare'),
    ]);
  }
  return source;
}
export function inlineContentEdit(source: string, id: string, nodes: readonly InlineNode[]): Edit {
  return innerContentEdit(source, id, serializeInline(nodes));
}
function serializeInline(nodes: readonly InlineNode[], depth = 0): string {
  if (depth > 50 || nodes.length > 10_000) {
    throw new Error('Content exceeds editing limits');
  }
  return nodes
    .map((node): string => {
      if (node.kind === 'text') {
        return node.value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('{', '&#123;');
      }
      if (node.kind === 'expr') {
        return node.value;
      }
      const attrs = Object.entries(node.props ?? {})
        .map(([key, value]) => {
          if (!value) {
            return '';
          }
          return value.type === 'bare'
            ? ` ${key}`
            : value.type === 'expr'
              ? ` ${key}={${value.value}}`
              : ` ${key}="${value.value.replaceAll('&', '&amp;').replaceAll('"', '&quot;')}"`;
        })
        .join('');
      return node.name === 'br' ? '<br>' : `<${node.name}${attrs}>${serializeInline(node.children ?? [], depth + 1)}</${node.name}>`;
    })
    .join('');
}
export function innerContentEdit(source: string, id: string, content: string): Edit {
  const node = nodeAt(source, id);
  const range = bounds(node);
  const first = node.children?.[0];
  const last = node.children?.at(-1);
  if (first && last) {
    return { start: bounds(first).start, end: bounds(last).end, text: content };
  }
  const written = source.slice(range.start, range.end);
  if (/\/\s*>$/.test(written)) {
    return { ...range, text: written.replace(/\/\s*>$/, '>') + content + `</${node.name}>` };
  }
  const end = source.lastIndexOf('</', range.end);
  if (end < range.start) {
    throw new Error('This node cannot contain content');
  }
  return { start: end, end, text: content };
}
export function nodeTextEdit(source: string, id: string, value: string): Edit {
  const node = nodeAt(source, id);
  const range = bounds(node);
  if (node.kind === 'text') {
    return { ...range, text: serializeInline([{ kind: 'text', value }]) };
  }
  if (node.kind === 'map' || node.kind === 'cond') {
    return headEdit(source, node, value);
  }
  if (node.kind === 'raw') {
    const end = source.lastIndexOf('</', range.end);
    // A quoted attribute may contain ">"; the parser already found the
    // exact inner content, so measure back from the closing tag instead.
    const start = end - node.inner.length;
    if (start <= range.start || end < start || source.slice(start, end) !== node.inner) {
      throw new Error('This code block needs source editing.');
    }
    return { start, end, text: value };
  }
  if ('value' in node) {
    return { ...range, text: serializeNodes([{ ...node, value }]).trimEnd() };
  }
  throw new Error('Open Code to edit this node.');
}
export function renameTag(source: string, id: string, name: string): string {
  if (!/^[A-Za-z][\w.:-]*$/.test(name)) {
    throw new Error('Invalid tag name');
  }
  const node = nodeAt(source, id);
  if (!node.name) {
    throw new Error('This node has no tag');
  }
  const range = bounds(node);
  const edits: Edit[] = [{ start: range.start + 1, end: range.start + 1 + node.name.length, text: name }];
  const closing = source.lastIndexOf('</' + node.name, range.end);
  if (closing >= range.start) {
    edits.push({ start: closing + 2, end: closing + 2 + node.name.length, text: name });
  }
  return applyEdits(source, edits);
}
export function frontmatterEdit(source: string, value: string): Edit {
  const range = frontmatterRange(source);
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const content = value.replace(/\r?\n/g, eol);
  const start = source.startsWith('\uFEFF') ? 1 : 0;
  return range
    ? { start: range.start, end: range.end, text: `---${eol}${content}${eol}---` }
    : { start, end: start, text: `---${eol}${content}${eol}---${eol}` };
}

export function assetProp(source: string, id: string, file: string, name: string, asset: string) {
  if (asset.startsWith('public/')) {
    return setAttributes(source, id, { [name]: { type: 'string', value: '/' + asset.slice(7) } });
  }
  const parsed = parsePage(source);
  if (!parsed.editable) {
    throw new Error('Fix the page syntax before choosing an asset.');
  }
  const specifier = relativeImport(file, asset);
  const existing = parsed.model.imports.find((entry) => entry.path === specifier);
  const names = new Set(parsed.model.imports.map((entry) => entry.name));
  let binding = existing?.name ?? 'studioAsset';
  for (let index = 1; !existing && names.has(binding) && index <= 1000; index++) {
    binding = `studioAsset${index}`;
  }
  if (!existing && names.has(binding)) {
    throw new Error('No available import name');
  }
  const node = nodeAt(source, id);
  source = setAttributes(source, id, {
    [name]: { type: 'expr', value: node.kind === 'element' ? binding + '.src' : binding },
  });
  if (!existing) {
    const eol = parsed.model.eol;
    const offset = source.startsWith('---\r\n') ? 5 : 4;
    const line = `import ${binding} from ${JSON.stringify(specifier)};${eol}`;
    source = parsed.model.hadFrontmatter ? source.slice(0, offset) + line + source.slice(offset) : `---${eol}${line}---${eol}${source}`;
  }
  return source;
}

function headEdit(source: string, node: Extract<ParserNode, { kind: 'map' | 'cond' }>, value: string): Edit {
  const range = bounds(node);
  if (node.kind === 'cond') {
    const offset = source.indexOf(node.test, range.start + 1);
    const childStart = node.children[0]?.children?.[0]?.start ?? range.end;
    if (offset < range.start || offset + node.test.length > childStart) {
      throw new Error('Open Code to edit this condition.');
    }
    return { start: offset, end: offset + node.test.length, text: value };
  }
  if (node.body || !node.children[0]) {
    throw new Error('Open Code to edit this loop header.');
  }
  const start = range.start + 1;
  const child = bounds(node.children[0]).start;
  const prefix = source.slice(start, child);
  const match = /^(\s*)([\s\S]*?=>\s*\(?)(\s*)$/.exec(prefix);
  if (!match) {
    throw new Error('Open Code to edit this loop header.');
  }
  return {
    start: start + (match[1]?.length ?? 0),
    end: child - (match[3]?.length ?? 0),
    text: node.bare ? value.replace(/\($/, '') : value,
  };
}
