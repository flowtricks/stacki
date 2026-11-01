// HTML chunks: pages built as <Fragment set:html={x} /> where x imports
// "chunks/foo.html?raw". Their markup is parsed into the page tree, written
// back to the chunk files, and marked for the preview.

import fs from 'node:fs';
import path from 'node:path';
import { assert } from '../../shared/core/assert';
import { LIMITS } from '../../shared/core/limits';
import type { ParserNode, ParserPageModel } from './astroParserTypes';
import { makeId, assignPathIds, required } from './astroAttrs';
import { parseTemplate } from './astroTemplate';
import { serializeNodeMarked } from './astroSerializeMarked';

// ---------------------------------------------------------------------------
// HTML chunks
// ---------------------------------------------------------------------------
// Pages built as <Fragment set:html={x} /> where x is an import of
// "chunks/foo.html?raw" (or a joined array of them). The chunk files' markup
// is parsed into the Fragment's children so it's editable in the navigator;
// edits are written back to the chunk file, never the page.

export function resolveChunks(model: ParserPageModel, pagePath: string, options: { readonly locs?: boolean } = {}): void {
  // Identifier to absolute chunk file path.
  const rawImports = new Map<string, string>();
  for (const imp of model.imports) {
    if (/\.html\?raw$/i.test(imp.path) && imp.path.startsWith('.')) {
      rawImports.set(imp.name, path.resolve(path.dirname(pagePath), imp.path.replace(/\?raw$/i, '')));
    }
  }
  if (!rawImports.size) {
    return;
  }

  // The `const main = [a, b, c].join("")` aggregations in the frontmatter.
  const aggregates = resolveChunksAggregates(model.extraFrontmatter);

  // The walk covers the parsed page, which is within the depth bound; the chunk trees it
  // attaches are not walked.
  const walk = (list: readonly ParserNode[], depth: number): void => {
    assert(depth <= LIMITS.treeDepthMax, 'resolveChunks: depth limit');
    for (const node of list) {
      if (node.kind === 'component' && node.props?.['set:html']?.type === 'expr' && node.children === undefined) {
        const ref = node.props['set:html'].value.trim();
        if (rawImports.has(ref)) {
          const file = required(rawImports.get(ref), 'Chunk import exists');
          const children = resolveChunksParseFile(file, options);
          if (children) {
            node.chunkFile = file;
            node.children = children;
          }
          continue;
        }
        if (aggregates.has(ref)) {
          const groups: ParserNode[] = [];
          for (const ident of required(aggregates.get(ref), 'Chunk aggregate exists')) {
            if (!rawImports.has(ident)) {
              continue;
            }
            const file = required(rawImports.get(ident), 'Aggregate chunk import exists');
            const children = resolveChunksParseFile(file, options);
            if (children) {
              groups.push({
                id: makeId(),
                kind: 'chunk-group',
                name: ident,
                chunkFile: file,
                children,
              });
            }
          }
          if (groups.length) {
            node.children = groups;
            node.chunkAggregate = true;
          }
          continue;
        }
      }
      if (Array.isArray(node.children)) {
        walk(node.children, depth + 1);
      }
    }
  };
  walk(model.nodes, 0);
  assignPathIds(model.nodes, '', 0); // The chunks' nodes joined the tree.
}

// Marker path each chunk import's content occupies in the tree, keyed by the
// import's identifier: the Fragment's own path for a lone chunk, the
// chunk-group's path for each member of a joined aggregate. Requires a model
// that's been through resolveChunks.
export function chunkImportMarks(model: ParserPageModel): Map<string, { path: string; group: boolean }> {
  const marks = new Map<string, { path: string; group: boolean }>();
  // The model has been through resolveChunks, whose path ids bound the joined tree's depth.
  const walk = (list: readonly ParserNode[], prefix: string, depth: number): void => {
    assert(depth <= LIMITS.treeDepthMax, 'chunkImportMarks: depth limit');
    list.forEach((node, i) => {
      const childPath = prefix ? `${prefix}.${i}` : String(i);
      if (node.chunkFile) {
        const group = node.kind === 'chunk-group';
        const html = node.props?.['set:html'];
        const ident = group ? node.name : html && html.type !== 'bare' ? html.value.trim() : undefined;
        if (ident) {
          marks.set(ident, { path: childPath, group });
        }
      }
      if (Array.isArray(node.children)) {
        walk(node.children, childPath, depth + 1);
      }
    });
  };
  walk(model.nodes, '', 0);
  return marks;
}

// Dev-preview only: the chunk's markup with the same boundary markers the
// page serializer emits, numbered from the Fragment's (or group's) key so
// chunk nodes address identically to the app's tree. `prefix` is a full
// "<file>#<path>" key — the file half rides along untouched. A group also gets
// a marker pair of its own — nothing in the page wraps it. Returns undefined when
// the chunk isn't representable, so the caller can serve it unmarked.
export function markChunkHtml(source: string, prefix: string, { group }: { readonly group: boolean }): string | undefined {
  const { nodes, clean } = parseTemplate(source);
  if (!clean) {
    return undefined;
  }
  const lines: string[] = [];
  if (group) {
    lines.push(`<!--avb-s:${prefix}-->`);
  }
  nodes.forEach((node, i) =>
    serializeNodeMarked(node, '', lines, {
      path: `${prefix}.${i}`,
      inSlot: false,
      atRoot: false,
      depth: 0,
      stamp: undefined,
    }),
  );
  if (group) {
    lines.push(`<!--avb-e:${prefix}-->`);
  }
  return lines.join('\n') + '\n';
}

function resolveChunksParseFile(filePath: string, options: { readonly locs?: boolean }): ParserNode[] | undefined {
  let source: string;
  try {
    source = fs.readFileSync(filePath, 'utf8');
  } catch {
    return undefined;
  }
  // Only disk failures are caught. Broken parser invariants must stay loud.
  const { nodes, clean } = parseTemplate(source, options.locs ? 0 : undefined);
  return clean ? nodes : undefined;
}

function resolveChunksAggregates(extraFrontmatter: string): Map<string, string[]> {
  const aggregates = new Map<string, string[]>();
  const aggRe = /(?:const|let)\s+(\w+)\s*=\s*\[([^\]]*)\]\s*\.join\(/g;
  let am;
  while ((am = aggRe.exec(extraFrontmatter)) !== null) {
    const idents = required(am[2], 'Chunk aggregate members capture')
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean);
    if (idents.length && idents.every((i) => /^\w+$/.test(i))) {
      aggregates.set(required(am[1], 'Chunk aggregate name capture'), idents);
    }
  }

  return aggregates;
}
