// The page tree every process agrees on. Produced by electron/parse/astroParser.ts
// (kinds and field names mirror it exactly), consumed by the renderer's
// editorTree and the IPC bridge. parsePageNode validates what that producer
// emits and rejects everything else — the boundary is where malformed data
// dies, and inward code never re-validates.

import { assert } from '../core/assert';
import type { NodeId } from '../core/brand';
import { toNodeId, toUtf16Offset } from '../core/brand';
import { LIMITS } from '../core/limits';
import { parseImportSlots } from './frontmatter';
import { parseUtf16Span, spanContains, spansAscending, type Utf16Span } from '../core/span';
import type {
  Attr,
  PairedNode,
  RawNode,
  MapNode,
  CondNode,
  BranchNode,
  MarkdownNodeMetadata,
  AttrSpan,
  SourceNodeMetadata,
  PageNode,
  PageNodeList,
  ImportDecl,
  PageModel,
  ParsePageResult,
} from './pageNodeTypes';
export { assertTreeInvariants } from './pageTreeInvariants';

// The shapes are declared beside this file; every caller still imports them here.
export type * from './pageNodeTypes';

// Both wire readers validate the interleaving so a malformed child list cannot
// silently drop executable statements from a general callback.
export function parseMapBodyParts(input: unknown, children: unknown): readonly string[] {
  if (!Array.isArray(input)) {
    throw new Error('Map.bodyParts: expected array');
  }
  if (input.length > LIMITS.treeNodesMax + 1) {
    throw new Error('Map.bodyParts: exceeds part limit');
  }
  if (!Array.isArray(children) || input.length !== children.length + 1) {
    throw new Error('Map.bodyParts: expected one more part than markup roots');
  }
  let length = 0;
  return input.map((part: unknown) => {
    if (typeof part !== 'string') {
      throw new Error('Map.bodyParts: expected string');
    }
    length += part.length;
    if (length > LIMITS.nodeValueCharsMax) {
      throw new Error('Map.bodyParts: exceeds source limit');
    }
    return part;
  });
}

// --- Parsers ---------------------------------------------------------------
// Internal recursion state: a shared node counter and depth, threaded through
// so the whole tree answers to LIMITS, not each subtree.

interface ParseContext {
  nodes: number;
}

function fail(where: string, what: string): never {
  throw new Error(`PageNode.${where}: ${what}`);
}

function asRecord(input: unknown, where: string): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    fail(where, 'expected object');
  }
  return input as Record<string, unknown>;
}

function asString(value: unknown, where: string, charsMax: number): string {
  if (typeof value !== 'string') {
    fail(where, 'expected string');
  }
  if (value.length > charsMax) {
    fail(where, `exceeds ${charsMax} chars`);
  }
  return value;
}

function asNodeId(value: unknown, where: string): NodeId {
  if (typeof value !== 'string') {
    fail(where, 'expected id string');
  }
  return toNodeId(asString(value, where, LIMITS.tagNameCharsMax));
}

function parseAttr(input: unknown, where: string): Attr {
  const record = asRecord(input, where);
  const type = record['type'];
  if (type === 'bare') {
    return { type };
  }
  if (type === 'string' || type === 'expr' || type === 'spread') {
    return { type, value: asString(record['value'], `${where}.value`, LIMITS.attrCharsMax) };
  }
  fail(where, `unknown attr type ${JSON.stringify(type)}`);
}

function parseProps(input: unknown, where: string): Readonly<Record<string, Attr>> | undefined {
  if (input === undefined) {
    return undefined;
  }
  const record = asRecord(input, where);
  const names = Object.keys(record);
  if (names.length > LIMITS.attrsPerNodeMax) {
    fail(where, `exceeds ${LIMITS.attrsPerNodeMax} attrs`);
  }
  const entries = names.map((name): [string, Attr] => {
    if (name.length > LIMITS.attrCharsMax) {
      fail(where, `attr name ${JSON.stringify(name)} exceeds ${LIMITS.attrCharsMax} chars`);
    }
    return [name, parseAttr(record[name], `${where}.${name}`)];
  });
  // Object.fromEntries defines `__proto__` as an ordinary attribute; assigning
  // it would invoke the inherited setter and silently drop it (the parser's
  // parseAttrs keeps it the same way).
  return Object.fromEntries(entries);
}

function parseChildren(input: unknown, where: string, depth: number, context: ParseContext): PageNodeList {
  if (!Array.isArray(input)) {
    fail(where, 'expected children array');
  }
  const nodes = input.map((child, index) => parsePageNode(child, `${where}[${index}]`, depth + 1, context));
  const trailingBlanks = parseMarkdownBlanks(Reflect.get(input, 'mdTrailingBlanks'), `${where}.mdTrailingBlanks`);
  return trailingBlanks === undefined ? nodes : Object.assign(nodes, { mdTrailingBlanks: trailingBlanks });
}

function parseMarkdownBlanks(input: unknown, where: string): number | undefined {
  if (input === undefined) {
    return undefined;
  }
  if (!Number.isSafeInteger(input) || Number(input) < 0) {
    fail(where, 'expected nonnegative integer');
  }
  if (Number(input) > LIMITS.treeNodesMax) {
    fail(where, 'exceeds blank-line limit');
  }
  return Number(input);
}

function markdownExtras(record: Record<string, unknown>, where: string): MarkdownNodeMetadata {
  const out: Record<string, unknown> = {};
  for (const field of ['mdIndent', 'mdFence', 'mdInfo', 'mdRaw', 'mdGap', 'mdTrail', 'mdSetext', 'mdMarker', 'mdSource'] as const) {
    if (record[field] !== undefined) {
      out[field] = asString(record[field], `${where}.${field}`, LIMITS.nodeValueCharsMax);
    }
  }
  for (const field of ['mdUnclosed', 'mdImage', 'mdLoose', 'mdEsm'] as const) {
    if (record[field] !== undefined) {
      if (typeof record[field] !== 'boolean') {
        fail(where, `${field}: expected boolean`);
      }
      out[field] = record[field];
    }
  }
  const blanks = parseMarkdownBlanks(record['mdBlanksBefore'], `${where}.mdBlanksBefore`);
  if (blanks !== undefined) {
    out['mdBlanksBefore'] = blanks;
  }
  if (record['mdNumbers'] !== undefined) {
    if (!Array.isArray(record['mdNumbers'])) {
      fail(where, 'mdNumbers: expected array');
    }
    if (record['mdNumbers'].length > LIMITS.treeNodesMax) {
      fail(where, 'mdNumbers: exceeds limit');
    }
    out['mdNumbers'] = record['mdNumbers'].map((value, index) => {
      if (!Number.isSafeInteger(value)) {
        fail(where, `mdNumbers[${index}]: expected integer`);
      }
      return Number(value);
    });
  }
  // Every preserved field was validated above; this constructor is the trust boundary.
  return out as MarkdownNodeMetadata;
}

// Layout/preservation fields shared by the tag-bearing kinds. Each is
// validated only when present, so a producer that omits them stays valid.
function tagExtras(record: Record<string, unknown>, where: string): Pick<PairedNode, 'attrOrder' | 'attrSource' | 'blankBefore' | 'blankAfter'> {
  const out: Record<string, unknown> = {};
  if (record['attrOrder'] !== undefined) {
    if (!Array.isArray(record['attrOrder']) || !record['attrOrder'].every((name) => typeof name === 'string')) {
      fail(where, 'attrOrder: expected string array');
    }
    out['attrOrder'] = record['attrOrder'] as readonly string[];
  }
  for (const field of ['attrSource', 'source', 'closeSource'] as const) {
    if (record[field] !== undefined) {
      out[field] = asString(record[field], `${where}.${field}`, LIMITS.nodeValueCharsMax);
    }
  }
  for (const field of ['blankBefore', 'blankAfter'] as const) {
    if (record[field] !== undefined) {
      if (!Number.isSafeInteger(record[field])) {
        fail(where, `${field}: expected integer`);
      }
      out[field] = record[field];
    }
  }
  for (const field of ['tightClose', 'shorthand', 'dynamicTag', 'astroAsset'] as const) {
    if (record[field] !== undefined) {
      if (typeof record[field] !== 'boolean') {
        fail(where, `${field}: expected boolean`);
      }
      out[field] = record[field];
    }
  }
  return out as Pick<PairedNode, 'attrOrder' | 'attrSource' | 'blankBefore' | 'blankAfter'>;
}

// A self-closing tag has no children list. JSON cannot say `undefined`, so a
// stored `null` (the sentinel before AGENTS.md §6) and a missing key both mean
// self-closing.
function parsePairedChildren(input: unknown, where: string, depth: number, context: ParseContext): PageNodeList | undefined {
  if (input === undefined) {
    return undefined;
  }
  if (input === null) {
    return undefined;
  }
  return parseChildren(input, where, depth, context);
}

function parsePaired(record: Record<string, unknown>, where: string, depth: number, context: ParseContext): PairedNode {
  const kind = record['kind'];
  if (kind !== 'component' && kind !== 'element') {
    fail(where, `parsePaired called for kind ${JSON.stringify(kind)}`);
  }
  const children = parsePairedChildren(record['children'], `${where}.children`, depth, context);
  const out: Record<string, unknown> = {
    kind,
    id: asNodeId(record['id'], `${where}.id`),
    name: asString(record['name'], `${where}.name`, LIMITS.tagNameCharsMax),
    children,
    ...tagExtras(record, where),
  };
  if (record['props'] !== undefined) {
    out['props'] = parseProps(record['props'], `${where}.props`);
  }
  return out as unknown as PairedNode;
}

function parseByKind(record: Record<string, unknown>, where: string, depth: number, context: ParseContext): PageNode {
  const kind = record['kind'];
  switch (kind) {
    case 'component':
    case 'element':
      return parsePaired(record, where, depth, context);
    case 'raw':
      return parseRaw(record, where);
    case 'text':
    case 'expr':
    case 'raw-line':
      return {
        kind,
        id: asNodeId(record['id'], `${where}.id`),
        value: asString(record['value'], `${where}.value`, LIMITS.nodeValueCharsMax),
      };
    case 'comment': {
      const jsx = record['jsx'];
      if (jsx !== undefined && typeof jsx !== 'boolean') {
        fail(where, 'jsx: expected boolean');
      }
      return {
        kind,
        id: asNodeId(record['id'], `${where}.id`),
        value: asString(record['value'], `${where}.value`, LIMITS.nodeValueCharsMax),
        ...(jsx === undefined ? {} : { jsx }),
      };
    }
    case 'map':
      return parseMap(record, where, depth, context);
    case 'cond':
      return parseCond(record, where, depth, context);
    case 'branch': {
      const name = record['name'];
      if (name !== 'then' && name !== 'else') {
        fail(where, `branch name must be 'then' or 'else'`);
      }
      return {
        kind,
        id: asNodeId(record['id'], `${where}.id`),
        name,
        children: parseChildren(record['children'], `${where}.children`, depth, context),
      };
    }
    case 'chunk-group':
      return {
        kind,
        id: asNodeId(record['id'], `${where}.id`),
        name: asString(record['name'], `${where}.name`, LIMITS.tagNameCharsMax),
        chunkFile: asString(record['chunkFile'], `${where}.chunkFile`, LIMITS.attrCharsMax),
        children: parseChildren(record['children'], `${where}.children`, depth, context),
      };
    default:
      fail(where, `unknown kind ${JSON.stringify(kind)}`);
  }
}

function parseRaw(record: Record<string, unknown>, where: string): RawNode {
  assert(record['kind'] === 'raw', 'parseRaw: dispatched on its kind');
  const out: Record<string, unknown> = {
    kind: 'raw',
    id: asNodeId(record['id'], `${where}.id`),
    name: asString(record['name'], `${where}.name`, LIMITS.tagNameCharsMax),
    inner: asString(record['inner'], `${where}.inner`, LIMITS.nodeValueCharsMax),
    ...tagExtras(record, where),
  };
  if (record['props'] !== undefined) {
    out['props'] = parseProps(record['props'], `${where}.props`);
  }
  return out as unknown as RawNode;
}

function parseMap(record: Record<string, unknown>, where: string, depth: number, context: ParseContext): MapNode {
  // Paired with parsePageNode, which dispatched on the kind and bounded the depth.
  assert(record['kind'] === 'map', 'parseMap: dispatched on its kind');
  assert(depth <= LIMITS.treeDepthMax, 'parseMap: depth was bounded by the caller');
  const out: Record<string, unknown> = {
    kind: 'map',
    id: asNodeId(record['id'], `${where}.id`),
    head: asString(record['head'], `${where}.head`, LIMITS.attrCharsMax),
    children: parseChildren(record['children'], `${where}.children`, depth, context),
  };
  for (const field of ['headSource', 'source'] as const) {
    if (record[field] !== undefined) {
      out[field] = asString(record[field], `${where}.${field}`, LIMITS.nodeValueCharsMax);
    }
  }
  if (record['body'] !== undefined) {
    const body: unknown = record['body'];
    if (!Array.isArray(body)) {
      fail(where, 'body: expected statement array');
    }
    if (body.length > LIMITS.treeNodesMax) {
      fail(where, 'body: exceeds statement limit');
    }
    out['body'] = body.map((line: unknown, index) => asString(line, `${where}.body[${index}]`, LIMITS.nodeValueCharsMax));
  }
  if (record['bare'] !== undefined) {
    if (typeof record['bare'] !== 'boolean') {
      fail(where, 'bare: expected boolean');
    }
    out['bare'] = record['bare'];
  }
  if (record['bodyParts'] !== undefined) {
    out['bodyParts'] = parseMapBodyParts(record['bodyParts'], out['children']);
  }
  return out as unknown as MapNode;
}

function parseCond(record: Record<string, unknown>, where: string, depth: number, context: ParseContext): CondNode {
  // Paired with parsePageNode, which dispatched on the kind and bounded the depth.
  assert(record['kind'] === 'cond', 'parseCond: dispatched on its kind');
  assert(depth <= LIMITS.treeDepthMax, 'parseCond: depth was bounded by the caller');
  const op = record['op'];
  if (op !== '?' && op !== '&&') {
    fail(where, `unknown cond op ${JSON.stringify(op)}`);
  }
  const branches = parseChildren(record['children'], `${where}.children`, depth, context);
  for (const branch of branches) {
    if (branch.kind !== 'branch') {
      fail(where, 'cond children must be branch nodes');
    }
  }
  return {
    kind: 'cond',
    id: asNodeId(record['id'], `${where}.id`),
    op,
    test: asString(record['test'], `${where}.test`, LIMITS.attrCharsMax),
    children: branches as readonly BranchNode[],
  };
}

/** Parse one node subtree. Throws on any violation — boundary code decides
 * whether to let that propagate or convert it to a Result. */
export function parsePageNode(input: unknown, where = 'node', depth = 0, context: ParseContext = { nodes: 0 }): PageNode {
  if (depth > LIMITS.treeDepthMax) {
    fail(where, `exceeds depth ${LIMITS.treeDepthMax}`);
  }
  context.nodes += 1;
  if (context.nodes > LIMITS.treeNodesMax) {
    fail(where, `exceeds ${LIMITS.treeNodesMax} nodes`);
  }
  const record = asRecord(input, where);
  const node: PageNode = {
    ...parseByKind(record, where, depth, context),
    ...markdownExtras(record, where),
    ...sourceNodeMetadata(record, where),
  };
  checkAttrSpanNames(node, where);
  return node;
}

function sourceNodeMetadata(record: Record<string, unknown>, where: string): SourceNodeMetadata {
  const start = record['start'];
  const end = record['end'];
  if (start === undefined && end === undefined) {
    if (record['attrSpans'] !== undefined) {
      fail(where, 'attrSpans: requires the node source range');
    }
    return {};
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) {
    fail(where, 'source range: expected safe integer offsets');
  }
  if (Number(start) < 0) {
    fail(where, 'source range: start must be nonnegative');
  }
  if (Number(end) < Number(start)) {
    fail(where, 'source range: end must not precede start');
  }
  const range = { start: toUtf16Offset(Number(start)), end: toUtf16Offset(Number(end)) };
  if (record['attrSpans'] === undefined) {
    return range;
  }
  return { ...range, attrSpans: parseAttrSpans(record['attrSpans'], `${where}.attrSpans`, range) };
}

function parseAttrSpans(input: unknown, where: string, node: Utf16Span): readonly AttrSpan[] {
  if (!Array.isArray(input)) {
    fail(where, 'expected array');
  }
  if (input.length > LIMITS.attrsPerNodeMax) {
    fail(where, `exceeds ${LIMITS.attrsPerNodeMax} attrs`);
  }
  const spans = input.map((entry: unknown, index) => parseAttrSpan(entry, `${where}[${index}]`));
  for (const entry of spans) {
    if (!spanContains(node, entry.span)) {
      fail(where, `${JSON.stringify(entry.name)} lies outside its node`);
    }
  }
  if (!spansAscending(spans.map((entry) => entry.span))) {
    fail(where, 'expected ascending, disjoint attribute spans');
  }
  return spans;
}

function parseAttrSpan(input: unknown, where: string): AttrSpan {
  const record = asRecord(input, where);
  const name = asString(record['name'], `${where}.name`, LIMITS.attrCharsMax);
  const span = parseUtf16Span(record['span'], `${where}.span`);
  const type = record['type'];
  const inner = (field: 'nameSpan' | 'valueSpan'): Utf16Span => {
    const value = parseUtf16Span(record[field], `${where}.${field}`);
    if (!spanContains(span, value)) {
      fail(where, `${field} lies outside the attribute`);
    }
    return value;
  };
  const absent = (field: 'nameSpan' | 'valueSpan'): void => {
    if (record[field] !== undefined) {
      fail(where, `${field}: not allowed on a ${String(type)} attribute`);
    }
  };
  switch (type) {
    case 'string':
    case 'expr': {
      const nameSpan = inner('nameSpan');
      const valueSpan = inner('valueSpan');
      if (valueSpan.start < nameSpan.end) {
        fail(where, 'valueSpan must follow nameSpan');
      }
      return { type, name, span, nameSpan, valueSpan };
    }
    case 'bare':
      absent('valueSpan');
      return { type, name, span, nameSpan: inner('nameSpan') };
    case 'spread':
    case 'markdown':
      absent('nameSpan');
      return { type, name, span, valueSpan: inner('valueSpan') };
    default:
      fail(where, `unknown attr type ${JSON.stringify(type)}`);
  }
}

// The spans and the props record describe the same tag: the same names, and the
// last occurrence of each name has the type props kept for it.
function checkAttrSpanNames(node: PageNode, where: string): void {
  if (node.attrSpans === undefined) {
    return;
  }
  const props = 'props' in node ? (node.props ?? {}) : undefined;
  if (props === undefined) {
    fail(where, `attrSpans: a ${node.kind} node has no attributes`);
  }
  // A Markdown attribute is a string the syntax places, not a typed attribute.
  const last = new Map(node.attrSpans.map((entry) => [entry.name, entry.type === 'markdown' ? 'string' : entry.type]));
  const names = Object.keys(props);
  if (last.size !== names.length) {
    fail(where, 'attrSpans: names differ from props');
  }
  for (const name of names) {
    if (last.get(name) !== props[name]?.type) {
      fail(where, `attrSpans: ${JSON.stringify(name)} differs from props`);
    }
  }
}

/** Parse a whole tree (a page model's nodes array). */
export function parsePageTree(input: unknown): PageNodeList {
  if (!Array.isArray(input)) {
    fail('tree', 'expected array');
  }
  const context: ParseContext = { nodes: 0 };
  const nodes = input.map((child, index) => parsePageNode(child, `tree[${index}]`, 0, context));
  const trailingBlanks = parseMarkdownBlanks(Reflect.get(input, 'mdTrailingBlanks'), 'tree.mdTrailingBlanks');
  return trailingBlanks === undefined ? nodes : Object.assign(nodes, { mdTrailingBlanks: trailingBlanks });
}

function parseImport(input: unknown, where: string): ImportDecl {
  const record = asRecord(input, where);
  const out: Record<string, unknown> = {
    name: asString(record['name'], `${where}.name`, LIMITS.tagNameCharsMax),
    path: asString(record['path'], `${where}.path`, LIMITS.attrCharsMax),
    quote: asString(record['quote'], `${where}.quote`, 4),
  };
  if (record['named'] !== undefined || record['typeOnly'] !== undefined) {
    if (record['named'] !== undefined && typeof record['named'] !== 'boolean') {
      fail(where, 'named: expected boolean');
    }
    if (record['typeOnly'] !== undefined && typeof record['typeOnly'] !== 'boolean') {
      fail(where, 'typeOnly: expected boolean');
    }
    if (record['named'] !== undefined) {
      out['named'] = record['named'];
    }
    if (record['typeOnly'] !== undefined) {
      out['typeOnly'] = record['typeOnly'];
    }
  }
  if (record['imported'] !== undefined) {
    out['imported'] = asString(record['imported'], `${where}.imported`, LIMITS.tagNameCharsMax);
  }
  if (record['at'] !== undefined) {
    if (!Number.isSafeInteger(record['at']) || Number(record['at']) < 0) {
      fail(where, 'at: expected nonnegative integer');
    }
    out['at'] = record['at'];
  }
  return out as unknown as ImportDecl;
}

/** Parse a full page model, including the source slots used to preserve imports. */
export function parsePageModel(input: unknown): PageModel {
  const record = asRecord(input, 'model');
  if (record['format'] === 'md' || record['format'] === 'mdx') {
    return parseMarkdownPageModel(record);
  }
  if (!Array.isArray(record['imports'])) {
    fail('model.imports', 'expected array');
  }
  if (record['imports'].length > LIMITS.importsMax) {
    fail('model.imports', `exceeds ${LIMITS.importsMax}`);
  }
  const layout = asRecord(record['frontmatterLayout'], 'model.frontmatterLayout');
  if (!Array.isArray(layout['slots'])) {
    fail('model.frontmatterLayout.slots', 'expected array');
  }
  const out: Record<string, unknown> = {
    imports: record['imports'].map((entry, index) => parseImport(entry, `model.imports[${index}]`)),
    frontmatterLead: asString(record['frontmatterLead'], 'model.frontmatterLead', LIMITS.nodeValueCharsMax),
    extraFrontmatter: asString(record['extraFrontmatter'], 'model.extraFrontmatter', LIMITS.nodeValueCharsMax),
    extraFrontmatterSpaced: record['extraFrontmatterSpaced'] === true,
    frontmatterLayout: {
      extra: asString(layout['extra'], 'model.frontmatterLayout.extra', LIMITS.nodeValueCharsMax),
      slots: parseImportSlots(layout['slots']),
    },
    hadFrontmatter: record['hadFrontmatter'] === true,
    eol: parsePageEol(record['eol']),
    nodes: parsePageTree(record['nodes']),
  };
  if (!Number.isSafeInteger(record['trailingBlank'])) {
    fail('model.trailingBlank', 'expected integer');
  }
  out['trailingBlank'] = record['trailingBlank'];
  if (record['bodyStart'] !== undefined) {
    if (!Number.isSafeInteger(record['bodyStart'])) {
      fail('model.bodyStart', 'expected integer');
    }
    out['bodyStart'] = record['bodyStart'];
  }
  return out as unknown as PageModel;
}

function parsePageEol(input: unknown): '\n' | '\r\n' {
  if (input === undefined || input === '\n') {
    return '\n';
  }
  if (input === '\r\n') {
    return '\r\n';
  }
  fail('model.eol', 'expected LF or CRLF');
}

// A Markdown page without a layout has no layout path. JSON cannot say
// `undefined`, so a stored `null` (the sentinel before AGENTS.md §6) and a
// missing key both mean none.
function parseLayoutPath(input: unknown): string | undefined {
  if (input === undefined) {
    return undefined;
  }
  if (input === null) {
    return undefined;
  }
  if (typeof input !== 'string') {
    fail('model.layoutPath', 'expected string or nothing');
  }
  return input;
}

function parseMarkdownPageModel(record: Record<string, unknown>): PageModel {
  const format = record['format'];
  if (format !== 'md' && format !== 'mdx') {
    fail('model.format', 'expected Markdown format');
  }
  if (!Array.isArray(record['imports'])) {
    fail('model.imports', 'expected array');
  }
  if (record['imports'].length > LIMITS.importsMax) {
    fail('model.imports', 'exceeds limit');
  }
  const imports = record['imports'].map((input, index) => {
    const value = asRecord(input, `model.imports[${index}]`);
    return {
      name: asString(value['name'], `model.imports[${index}].name`, LIMITS.tagNameCharsMax),
      path: asString(value['path'], `model.imports[${index}].path`, LIMITS.attrCharsMax),
      quote: "'",
    };
  });
  const layoutPath = parseLayoutPath(record['layoutPath']);
  for (const field of ['mdEndsWithNewline', 'mdHasFrontmatter'] as const) {
    if (typeof record[field] !== 'boolean') {
      fail(`model.${field}`, 'expected boolean');
    }
  }
  const bodyStart = record['bodyStart'];
  if (bodyStart !== undefined) {
    if (!Number.isSafeInteger(bodyStart) || Number(bodyStart) < 0) {
      fail('model.bodyStart', 'expected nonnegative integer');
    }
  }
  const located = bodyStart === undefined ? {} : { bodyStart: Number(bodyStart) };
  return {
    ...located,
    imports,
    frontmatterLead: '',
    extraFrontmatter: asString(record['extraFrontmatter'], 'model.extraFrontmatter', LIMITS.nodeValueCharsMax),
    extraFrontmatterSpaced: true,
    frontmatterLayout: { extra: '', slots: [] },
    hadFrontmatter: record['mdHasFrontmatter'] === true,
    trailingBlank: 0,
    nodes: parsePageTree(record['nodes']),
    format,
    frontmatterLang: 'yaml',
    layoutPath,
    mdEol: asString(record['mdEol'], 'model.mdEol', 2),
    mdEndsWithNewline: record['mdEndsWithNewline'] === true,
    mdHasFrontmatter: record['mdHasFrontmatter'] === true,
  };
}

// Why a page is not editable, when the parser could say. JSON cannot say
// `undefined`: a stored `null` bail (the sentinel before AGENTS.md §6) and a
// missing key both mean none.
function parseBail(input: unknown): { readonly what: string; readonly near: string } | undefined {
  if (input === undefined) {
    return undefined;
  }
  if (input === null) {
    return undefined;
  }
  const record = asRecord(input, 'result.bail');
  return {
    what: asString(record['what'], 'result.bail.what', LIMITS.attrCharsMax),
    near: asString(record['near'], 'result.bail.near', LIMITS.attrCharsMax),
  };
}

/** Parse the parsePage result envelope: not-editable is data, not an error. */
export function parsePageResult(input: unknown): ParsePageResult {
  const record = asRecord(input, 'result');
  if (record['editable'] === true) {
    return { editable: true, model: parsePageModel(record['model']) };
  }
  if (record['editable'] === false) {
    return {
      editable: false,
      reason: asString(record['reason'], 'result.reason', LIMITS.attrCharsMax),
      bail: parseBail(record['bail']),
    };
  }
  fail('result.editable', 'expected boolean');
}

/** Parse the page:read envelope: the parse result plus the source text. */
export function parsePageReadResult(input: unknown): ParsePageResult & { readonly source: string } {
  const result = parsePageResult(input);
  const record = asRecord(input, 'pageRead');
  const source = asString(record['source'], 'pageRead.source', LIMITS.ipcFieldCharsMax);
  return { ...result, source };
}
