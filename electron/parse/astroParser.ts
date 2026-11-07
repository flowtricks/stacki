// Parses .astro pages into an editable tree model and serializes the model
// back to clean .astro source.
//
// Node kinds:
//   component — <Hero .../> or <Section>...</Section>; <> uses name Fragment
//   element   — <div>, <img/>, any lowercase tag
//   text      — text content between tags (may contain {expressions})
//   comment   — <!-- ... -->
//   raw       — <style>/<script> blocks whose inner content is kept verbatim
//
// children: undefined = self-closing, [] = paired-but-empty, [nodes] otherwise.
//
// Pages whose template can't be represented (stray '<', unclosed tags) are
// reported as not editable so the UI falls back to code view.

import fs from 'node:fs';
import { parseSerializePage } from './astroParserValidation';
import { readFrontmatter, writeFrontmatter } from '../../shared/page/frontmatterSource';
import type { FrontmatterModel, ImportMember } from '../../shared/page/frontmatterSource';
import { assertTreeInvariants } from '../../shared/page/pageNode';
import { assert } from '../../shared/core/assert';
import { LIMITS } from '../../shared/core/limits';
import type { ParserNode, ParsedPage, SourceLocation } from './astroParserTypes';
import { assignPathIds, parseAttrs, serializeAttrs, required } from './astroAttrs';
import { parseState, resetParseBail } from './astroParseState';
import { serializeNode, serializeNodes } from './astroSerialize';
import { parseTemplate } from './astroTemplate';
import { serializeNodesMarked, type MarkedSource } from './astroSerializeMarked';
import { resolveChunks, chunkImportMarks, markChunkHtml } from './astroChunks';
import { parsePropSchema } from './astroPropSchema';
import { parseSlots, rootTag, rootComponent, defaultSlotInline, parseExtendsTag } from './astroComponentApi';
import type { PreviewStamp } from '../../shared/page/previewToken';

export {
  parsePage,
  locateSelection,
  serializePage,
  serializePageMarked,
  parseTemplate,
  serializeNodes,
  resolveChunks,
  markChunkHtml,
  parsePropSchema,
  parseExtendsTag,
  parseSlots,
  defaultSlotInline,
  rootTag,
  rootComponent,
  parseAttrs,
  serializeAttrs,
};

// ---------------------------------------------------------------------------
// Page parse / serialize
// ---------------------------------------------------------------------------

// Returns {editable: true, model} or {editable: false, reason}.
// model = {imports, extraFrontmatter, nodes: tree}. The page's layout wrapper
// (if any) stays in the tree as a regular node with the well-known id
// 'layout', so nodes can live before/after it at the top level.
// `opts.locs` records source offsets on every node and the body's own start
// offset on the model — for reading a location out of the file on disk, not
// for the editor's live model (see parseTemplate).
function parsePage(source: string, options: { readonly locs?: boolean } = {}): ParsedPage {
  if (typeof source !== 'string' || source.length > LIMITS.ipcFieldCharsMax) {
    return {
      editable: false,
      reason: 'Page source is invalid or exceeds the size limit.',
      bail: undefined,
    };
  }
  // Try the empty block first.
  // Otherwise `---\n---\n--- prose` consumes the real close as code and
  // mistakes the start of the prose for a second closing fence.
  // A leading byte-order mark is an encoding signal, not content (plan §3.2):
  // the fences are matched past it, and offsets still count it so they index
  // the file as read. No write touches it: an edit is splices of other bytes.
  const bom = source.startsWith('\uFEFF') ? 1 : 0;
  const fm = source.slice(bom).match(/^---\r?\n(?:---|([\s\S]*?\r?\n)---)\r?\n?/);
  const frontmatter = fm ? fm[1] || '' : '';
  const hadFrontmatter = !!fm;
  const bodyStart = bom + (fm ? fm[0].length : 0);
  const body = source.slice(bodyStart);
  const eol = source.includes('\r\n') ? '\r\n' : '\n';

  const frontmatterModel = readFrontmatter(frontmatter);
  const { imports } = frontmatterModel;

  resetParseBail();
  const { nodes: topNodes, clean, trailingBlank } = parseTemplate(body, options.locs ? bodyStart : undefined);
  // A newline at the very start of the body is a blank line, because the
  // frontmatter's closing --- already ended its own line. Everywhere else a
  // leading newline is just the break after the tag before it, which is why
  // parseTemplate counts one fewer — so the first node is told directly.
  if (topNodes.length) {
    const lead = (body.match(/^(?:[ \t]*\r?\n)+/) || [''])[0];
    const blanks = (lead.match(/\n/g) || []).length;
    const first = required(topNodes[0], 'First top-level node exists');
    if (blanks) {
      first.blankBefore = blanks;
    } else {
      delete first.blankBefore;
    }
  }
  if (!clean) {
    // Name the construct and point at it. The bail records the text it stopped
    // on, so find that text back in the file for a line number — far more
    // actionable than "something in this page".
    let where = '';
    if (parseState.lastBail) {
      const at = source.indexOf(parseState.lastBail.near);
      const line = at === -1 ? 0 : source.slice(0, at).split('\n').length;
      where = ` Found ${parseState.lastBail.what}${line ? ` on line ${line}` : ''}.`;
    }
    return {
      editable: false,
      reason: `Page contains markup the visual editor cannot represent.${where}`,
      bail: parseState.lastBail ? { what: parseState.lastBail.what, near: parseState.lastBail.near } : undefined,
    };
  }

  // Type-only specifiers name types, not values, so nothing on the page can be
  // one of them — they must not count as "this component is imported".
  const importsByName = Object.fromEntries(imports.filter((i) => !i.typeOnly).map((i) => [i.name, i]));

  // Layout detection: a single top-level component wrapping the whole page,
  // or — when siblings live outside it — exactly one top-level component
  // whose import path mentions "layout". The wrapper keeps its place in the
  // tree; it's just tagged with the well-known id 'layout'. A lone top-level
  // component the page never imported is content (a component used as a tag,
  // e.g. a snippet page), not a layout: only an import makes it a layout.
  parsePageLayout(topNodes, importsByName);

  // A capitalized tag that isn't imported is a dynamic tag, not a component:
  // `const Tag = tag` then `<Tag>` is how an Astro component renders a
  // caller-chosen element. Flag those so the UI treats them as elements —
  // they have no file to open and no props of their own.
  parsePageMarkDynamic(topNodes, importsByName, 0);

  assignPathIds(topNodes, '', 0);
  // Producer-side invariant check (paired with parsePageResult at the IPC
  // boundary): a tree that violates this never leaves the parser.
  assertTreeInvariants(topNodes);

  return {
    editable: true,
    model: {
      ...frontmatterModel,
      hadFrontmatter,
      trailingBlank,
      eol,
      nodes: topNodes,
      // Only when offsets were asked for: it describes the file on disk, and
      // the live model is edited out from under it.
      ...(options.locs ? { bodyStart } : {}),
    },
  };
}

// A shared source-aware writer keeps the preview, file and code editor in
// agreement. The surrounding page writer supplies the last line break.
function serializeFrontmatter(model: FrontmatterModel, lines: string[], specFor?: (imp: ImportMember) => string): void {
  const text = writeFrontmatter(model, specFor);
  if (text) {
    lines.push(text.replace(/\r?\n$/, ''));
  }
}

function serializePage(input: unknown, unit?: string): string {
  const model = parseSerializePage(input);
  // A file that never had a frontmatter block does not acquire one. Writing
  // `---` twice at the top of a component that had none is a change to every
  // line number in it, for nothing.
  const fmLines: string[] = [];
  serializeFrontmatter(model, fmLines);
  const lines: string[] = [];
  if (fmLines.length || model.hadFrontmatter !== false) {
    lines.push('---', ...fmLines, '---');
  }

  for (const node of model.nodes) {
    serializeNode(node, '', lines, 0, unit);
  }
  // Blank lines the file ended on.
  for (let i = 0; i < (model.trailingBlank || 0); i++) {
    lines.push('');
  }
  const source = lines.join('\n') + '\n';
  return model.eol === '\r\n' ? source.replace(/\r?\n/g, '\r\n') : source.replace(/\r\n/g, '\n');
}

// Dev-preview variant used by the marker Vite plugin: wraps every node in
// <!--avb-s:path--> / <!--avb-e:path--> boundary comments (path = index trail,
// e.g. "0.2.1") so the preview iframe can map rendered DOM back to model nodes.
//
// Comments, not elements. A <template> is an element like any other as far as
// the tree is concerned: it counts for :nth-child, :first-child, + and ~, so
// every marker shifted the page's own structural selectors by one for as long
// as it was in the DOM — which is until the preview strips them, i.e. through
// first paint. A comment node is invisible to all of those, so the page a
// marked build renders is the page the real build renders.
// Children of {…map} loops render once per item and are left unmarked.
// Chunk subtrees can't be marked here — they render from an imported HTML
// string, not from page markup — so the ?raw import carries the Fragment's
// path and the dev plugin marks the chunk module itself. Passing it through
// the id (rather than a side map) also keys Vite's cache: move the Fragment
// and the chunk module's id changes with it.
// `prefix` namespaces every path so a component file’s markers cannot collide
// with the page’s. A page marks as "0.1"; src/components/Card.astro marks as
// "src/components/Card.astro|0.1", and the app asks for that namespace while
// that component is the file being edited.
function serializePageMarked(input: unknown, prefix = '', stamp: PreviewStamp | undefined = undefined, source: MarkedSource = undefined): string {
  const model = parseSerializePage(input);
  const marks = chunkImportMarks(model);
  const lines = ['---'];
  // Through the same writer as a real save: `frontmatterLead` is ordinary
  // frontmatter that happens to sit above the imports, and a preview that
  // dropped it would be missing whatever it declares.
  serializeFrontmatter(model, lines, (imp) => {
    const mark = /\.html\?raw$/i.test(imp.path) ? marks.get(imp.name) : undefined;
    return mark ? `${imp.path}&avb=${mark.path}${mark.group ? '&avbg=1' : ''}` : imp.path;
  });
  lines.push('---');
  // The file's own roots: what a caller sees of this file is whatever these
  // put on the page, so they are where a caller's name for this instance
  // belongs (see `atRoot`).
  const roots = serializeNodesMarked(model.nodes, { pathOf: (i) => `${prefix}${i}`, atRoot: true, stamp, source });
  if (roots !== '') {
    lines.push(roots);
  }
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Selection → source location
// ---------------------------------------------------------------------------

// 1-based line number of a source offset.
function lineOf(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source[i] === '\n') {
      line++;
    }
  }
  return line;
}

// Where a canvas selection sits in source. `indexPath` is the "0.2.1" half of
// a "<file>#<path>" node key — '' for the file itself, 'frontmatter' for the
// frontmatter block. Reads the file from disk and parses it fresh, so the
// answer describes what an agent opening that file would actually see.
//
// The file returned isn't always the one asked for: chunk children are written
// in the imported .html, not in the page that pulls it in. A node with no
// range of its own (an unrepresentable file, a synthetic chunk group, a path
// that no longer resolves) comes back as a bare file.
function locateSelection(absPath: string, indexPath: string): SourceLocation | undefined {
  let source;
  try {
    source = fs.readFileSync(absPath, 'utf8');
  } catch {
    return undefined;
  }
  const bare = { file: absPath };
  if (!indexPath) {
    return bare;
  }

  const parsed = parsePage(source, { locs: true });
  if (!parsed.editable) {
    return bare;
  }
  if (indexPath === 'frontmatter') {
    return parsed.model.bodyStart ? { file: absPath, startLine: 1, endLine: lineOf(source, parsed.model.bodyStart - 1) } : bare;
  }
  resolveChunks(parsed.model, absPath, { locs: true });

  let file = absPath;
  let list: ParserNode[] | undefined = parsed.model.nodes;
  let node = undefined;
  for (const part of indexPath.split('.')) {
    // Stepping past a chunk boundary: everything below it is written in the
    // chunk file, while the boundary node itself belongs to the page.
    if (node?.chunkFile) {
      file = node.chunkFile;
    }
    node = Array.isArray(list) ? list[Number(part)] : undefined;
    if (!node) {
      return { file };
    }
    list = node.children;
  }
  // A branch has no markup of its own. `{render && ( … )}` writes one brace, a
  // condition and then the contents — so nothing in the file is the branch, and
  // it was the one kind of node a selection could not be turned into a line
  // range. What it stands for is what is inside it.
  if (!node) {
    return { file };
  }
  let span: { readonly start?: number | undefined; readonly end?: number | undefined } = node;
  if (typeof span.start !== 'number' && Array.isArray(node.children)) {
    const placed = node.children.filter((child) => typeof child.start === 'number');
    if (placed.length) {
      span = {
        start: required(placed[0], 'First placed child exists').start,
        end: required(placed[placed.length - 1], 'Last placed child exists').end,
      };
    }
  }
  if (typeof span.start !== 'number') {
    return { file };
  }

  let text = source;
  if (file !== absPath) {
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      return { file };
    }
  }
  // Text nodes run from the end of the previous tag, so their range starts and
  // ends in whitespace on lines that hold nothing else. Tighten it to the
  // lines the content is actually on.
  let start = span.start;
  let end = Math.min(required(span.end, 'Placed node has an end offset'), text.length);
  while (start < end && /\s/.test(text.charAt(start))) {
    start++;
  }
  while (end > start && /\s/.test(text.charAt(end - 1))) {
    end--;
  }
  return { file, startLine: lineOf(text, start), endLine: lineOf(text, end - 1) };
}

// The template parse bounded the tree's depth before this runs.
function parsePageMarkDynamic(list: readonly ParserNode[], importsByName: Readonly<Record<string, ImportMember>>, depth: number): void {
  assert(depth <= LIMITS.treeDepthMax, 'parsePageMarkDynamic: depth limit');
  for (const node of list) {
    if (node.kind === 'component' && node.name !== 'Fragment') {
      const imp = importsByName[node.name];
      if (!imp) {
        node.dynamicTag = true;
      }
      // Astro's own <Image>/<Picture>, identified by where the name came
      // from rather than by the name itself — a project is perfectly
      // entitled to its own component called Image, and several have one.
      else if (imp.path === 'astro:assets') {
        node.astroAsset = true;
      }
    }
    if (Array.isArray(node.children)) {
      parsePageMarkDynamic(node.children, importsByName, depth + 1);
    }
  }
}

function parsePageLayout(topNodes: readonly ParserNode[], importsByName: Readonly<Record<string, ImportMember>>): void {
  const significant = topNodes.filter((node) => node.kind !== 'comment');
  let wrapper: ParserNode | undefined;
  const significantFirst = significant[0];
  if (
    significant.length === 1 &&
    significantFirst !== undefined &&
    significantFirst.kind === 'component' &&
    significantFirst.name !== 'Fragment' &&
    significantFirst.children !== undefined &&
    !!importsByName[significantFirst.name]
  ) {
    wrapper = significantFirst;
  } else if (significant.length > 1) {
    const layoutish = significant.filter(
      (node) => node.kind === 'component' && node.children !== undefined && /layout/i.test(importsByName[node.name]?.path || ''),
    );
    if (layoutish.length === 1) {
      wrapper = layoutish[0];
    }
  }
  if (wrapper) {
    wrapper.id = 'layout';
  }
}
