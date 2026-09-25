// The page tree every process agrees on. Produced by electron/astroParser.js
// (kinds and field names mirror it exactly), consumed by the renderer's
// editorTree and the IPC bridge. parsePageNode validates what that producer
// emits and rejects everything else — the boundary is where malformed data
// dies, and inward code never re-validates.

import type { NodeId } from './brand';
import { toNodeId } from './brand';
import { LIMITS } from './limits';
import { parseImportSlots, type ImportSlot } from './frontmatter';

export type Attr =
  | { readonly type: 'string'; readonly value: string }
  | { readonly type: 'expr'; readonly value: string }
  | { readonly type: 'bare' }
  | { readonly type: 'spread'; readonly value: string };

/** Fields a component or element tag can carry. children is null exactly when
 * the tag is self-closing; layout fields preserve how the source was written
 * so serialization round-trips. */
export interface PairedNode {
  readonly kind: 'component' | 'element';
  readonly id: NodeId;
  readonly name: string;
  readonly children: readonly PageNode[] | null;
  readonly props?: Readonly<Record<string, Attr>>;
  readonly attrOrder?: readonly string[];
  readonly attrSource?: string;
  readonly tightClose?: boolean;
  readonly shorthand?: boolean;
  readonly source?: string;
  readonly blankBefore?: number;
  readonly blankAfter?: number;
  readonly closeSource?: string;
  readonly dynamicTag?: boolean;
  readonly astroAsset?: boolean;
}

/** <style>/<script>: inner kept verbatim, never parsed. */
export interface RawNode {
  readonly kind: 'raw';
  readonly id: NodeId;
  readonly name: string;
  readonly inner: string;
  readonly props?: Readonly<Record<string, Attr>>;
  readonly attrOrder?: readonly string[];
  readonly attrSource?: string;
}

export interface ValueNode {
  readonly kind: 'text' | 'expr' | 'raw-line';
  readonly id: NodeId;
  readonly value: string;
}

export interface CommentNode {
  readonly kind: 'comment';
  readonly id: NodeId;
  readonly value: string;
  /** Written inside JSX braces ({/* ... *\/}) rather than as HTML. */
  readonly jsx?: boolean;
}

/** A `.map(...)` loop: head is the normalized loop header, children the body. */
export interface MapNode {
  readonly kind: 'map';
  readonly id: NodeId;
  readonly head: string;
  readonly children: readonly PageNode[];
  readonly headSource?: string;
  readonly bare?: boolean;
  readonly body?: readonly string[];
  readonly source?: string;
}

/** Conditional markup: one 'then' branch, and an 'else' branch for ternaries. */
export interface CondNode {
  readonly kind: 'cond';
  readonly id: NodeId;
  readonly op: '?' | '&&';
  readonly test: string;
  readonly children: readonly BranchNode[];
}

export interface BranchNode {
  readonly kind: 'branch';
  readonly id: NodeId;
  readonly name: 'then' | 'else';
  readonly children: readonly PageNode[];
}

/** A serialization chunk group — produced by resolveChunks, not parsePage. */
export interface ChunkGroupNode {
  readonly kind: 'chunk-group';
  readonly id: NodeId;
  readonly name: string;
  readonly chunkFile: string;
  readonly children: readonly PageNode[];
}

export interface MarkdownNodeMetadata {
  readonly mdBlanksBefore?: number;
  readonly mdIndent?: string;
  readonly mdFence?: string;
  readonly mdInfo?: string;
  readonly mdUnclosed?: boolean;
  readonly mdRaw?: string;
  readonly mdGap?: string;
  readonly mdTrail?: string;
  readonly mdSetext?: string;
  readonly mdImage?: boolean;
  readonly mdNumbers?: readonly number[];
  readonly mdLoose?: boolean;
  readonly mdMarker?: string;
  readonly mdSource?: string;
  readonly mdEsm?: boolean;
}

export interface SourceNodeMetadata {
  readonly start?: number;
  readonly end?: number;
}

export type PageNode = (
  | PairedNode
  | RawNode
  | ValueNode
  | CommentNode
  | MapNode
  | CondNode
  | BranchNode
  | ChunkGroupNode
) & MarkdownNodeMetadata & SourceNodeMetadata;

export type PageNodeList = readonly PageNode[] & { readonly mdTrailingBlanks?: number };

/** One import declaration in a frontmatter block. */
export interface ImportDecl {
  readonly name: string;
  readonly path: string;
  readonly quote: string;
  readonly named?: boolean;
  readonly imported?: string;
  readonly typeOnly?: boolean;
  /** Existing imports retain their source slot; new imports have no slot yet. */
  readonly at?: number;
}

/** The frontmatter model plus the parsed body tree, as parsePage returns it. */
export interface PageModel {
  readonly imports: readonly ImportDecl[];
  readonly frontmatterLead: string;
  readonly extraFrontmatter: string;
  readonly extraFrontmatterSpaced: boolean;
  readonly frontmatterLayout: {
    readonly extra: string;
    readonly slots: readonly ImportSlot[];
  };
  readonly hadFrontmatter: boolean;
  readonly trailingBlank: number;
  readonly eol?: '\n' | '\r\n';
  readonly nodes: PageNodeList;
  readonly bodyStart?: number;
  readonly format?: 'md' | 'mdx';
  readonly frontmatterLang?: 'yaml';
  readonly layoutPath?: string | null;
  readonly mdEol?: string;
  readonly mdEndsWithNewline?: boolean;
  readonly mdHasFrontmatter?: boolean;
}

export type ParsePageResult =
  | {
      readonly editable: false;
      readonly reason: string;
      readonly bail: { readonly what: string; readonly near: string } | null;
    }
  | { readonly editable: true; readonly model: PageModel };

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

function asString(value: unknown, where: string, maxChars: number): string {
  if (typeof value !== 'string') {
    fail(where, 'expected string');
  }
  if (value.length > maxChars) {
    fail(where, `exceeds ${maxChars} chars`);
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
  const out: Record<string, Attr> = {};
  for (const name of names) {
    if (name.length > LIMITS.attrCharsMax) {
      fail(where, `attr name ${JSON.stringify(name)} exceeds ${LIMITS.attrCharsMax} chars`);
    }
    out[name] = parseAttr(record[name], `${where}.${name}`);
  }
  return out;
}

function parseChildren(
  input: unknown,
  where: string,
  depth: number,
  context: ParseContext,
): PageNodeList {
  if (!Array.isArray(input)) {
    fail(where, 'expected children array');
  }
  const nodes = input.map((child, index) =>
    parsePageNode(child, `${where}[${index}]`, depth + 1, context),
  );
  const trailingBlanks = parseMarkdownBlanks(
    Reflect.get(input, 'mdTrailingBlanks'),
    `${where}.mdTrailingBlanks`,
  );
  return trailingBlanks === undefined
    ? nodes
    : Object.assign(nodes, { mdTrailingBlanks: trailingBlanks });
}

function parseMarkdownBlanks(input: unknown, where: string): number | undefined {
  if (input === undefined) {return undefined;}
  if (!Number.isSafeInteger(input) || Number(input) < 0) {
    fail(where, 'expected nonnegative integer');
  }
  if (Number(input) > LIMITS.treeNodesMax) {fail(where, 'exceeds blank-line limit');}
  return Number(input);
}

function markdownExtras(record: Record<string, unknown>, where: string): MarkdownNodeMetadata {
  const out: Record<string, unknown> = {};
  for (const field of [
    'mdIndent',
    'mdFence',
    'mdInfo',
    'mdRaw',
    'mdGap',
    'mdTrail',
    'mdSetext',
    'mdMarker',
    'mdSource',
  ] as const) {
    if (record[field] !== undefined) {
      out[field] = asString(record[field], `${where}.${field}`, LIMITS.nodeValueCharsMax);
    }
  }
  for (const field of ['mdUnclosed', 'mdImage', 'mdLoose', 'mdEsm'] as const) {
    if (record[field] !== undefined) {
      if (typeof record[field] !== 'boolean') {fail(where, `${field}: expected boolean`);}
      out[field] = record[field];
    }
  }
  const blanks = parseMarkdownBlanks(record['mdBlanksBefore'], `${where}.mdBlanksBefore`);
  if (blanks !== undefined) {out['mdBlanksBefore'] = blanks;}
  if (record['mdNumbers'] !== undefined) {
    if (!Array.isArray(record['mdNumbers'])) {fail(where, 'mdNumbers: expected array');}
    if (record['mdNumbers'].length > LIMITS.treeNodesMax) {fail(where, 'mdNumbers: exceeds limit');}
    out['mdNumbers'] = record['mdNumbers'].map((value, index) => {
      if (!Number.isSafeInteger(value)) {fail(where, `mdNumbers[${index}]: expected integer`);}
      return Number(value);
    });
  }
  // Every preserved field was validated above; this constructor is the trust boundary.
  return out as MarkdownNodeMetadata;
}

// Layout/preservation fields shared by the tag-bearing kinds. Each is
// validated only when present, so a producer that omits them stays valid.
function tagExtras(
  record: Record<string, unknown>,
  where: string,
): Pick<PairedNode, 'attrOrder' | 'attrSource' | 'blankBefore' | 'blankAfter'> {
  const out: Record<string, unknown> = {};
  if (record['attrOrder'] !== undefined) {
    if (!Array.isArray(record['attrOrder']) || !record['attrOrder'].every((n) => typeof n === 'string')) {
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

function parsePaired(record: Record<string, unknown>, where: string, depth: number, context: ParseContext): PairedNode {
  const kind = record['kind'];
  if (kind !== 'component' && kind !== 'element') {
    fail(where, `parsePaired called for kind ${JSON.stringify(kind)}`);
  }
  const children =
    record['children'] === null ? null : parseChildren(record['children'], `${where}.children`, depth, context);
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

function parseByKind(
  record: Record<string, unknown>,
  where: string,
  depth: number,
  context: ParseContext,
): PageNode {
  const kind = record['kind'];
  switch (kind) {
    case 'component':
    case 'element':
      return parsePaired(record, where, depth, context);
    case 'raw': {
      const out: Record<string, unknown> = {
        kind,
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
    case 'map': {
      const out: Record<string, unknown> = {
        kind,
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
        if (!Array.isArray(body)) { fail(where, 'body: expected statement array'); }
        if (body.length > LIMITS.treeNodesMax) { fail(where, 'body: exceeds statement limit'); }
        out['body'] = body.map((line: unknown, index) =>
          asString(line, `${where}.body[${index}]`, LIMITS.nodeValueCharsMax));
      }
      if (record['bare'] !== undefined) {
        if (typeof record['bare'] !== 'boolean') {
          fail(where, 'bare: expected boolean');
        }
        out['bare'] = record['bare'];
      }
      return out as unknown as MapNode;
    }
    case 'cond': {
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
        kind,
        id: asNodeId(record['id'], `${where}.id`),
        op,
        test: asString(record['test'], `${where}.test`, LIMITS.attrCharsMax),
        children: branches as readonly BranchNode[],
      };
    }
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

/** Parse one node subtree. Throws on any violation — boundary code decides
 * whether to let that propagate or convert it to a Result. */
export function parsePageNode(
  input: unknown,
  where = 'node',
  depth = 0,
  context: ParseContext = { nodes: 0 },
): PageNode {
  if (depth > LIMITS.treeDepthMax) {
    fail(where, `exceeds depth ${LIMITS.treeDepthMax}`);
  }
  context.nodes += 1;
  if (context.nodes > LIMITS.treeNodesMax) {
    fail(where, `exceeds ${LIMITS.treeNodesMax} nodes`);
  }
  const record = asRecord(input, where);
  return {
    ...parseByKind(record, where, depth, context),
    ...markdownExtras(record, where),
    ...sourceNodeMetadata(record, where),
  };
}

function sourceNodeMetadata(
  record: Record<string, unknown>,
  where: string,
): SourceNodeMetadata {
  const start = record['start'];
  const end = record['end'];
  if (start === undefined && end === undefined) {return {};}
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) {
    fail(where, 'source range: expected safe integer offsets');
  }
  if (Number(start) < 0) {fail(where, 'source range: start must be nonnegative');}
  if (Number(end) < Number(start)) {
    fail(where, 'source range: end must not precede start');
  }
  return { start: Number(start), end: Number(end) };
}

/** Parse a whole tree (a page model's nodes array). */
export function parsePageTree(input: unknown): PageNodeList {
  if (!Array.isArray(input)) {
    fail('tree', 'expected array');
  }
  const context: ParseContext = { nodes: 0 };
  const nodes = input.map((child, index) => parsePageNode(child, `tree[${index}]`, 0, context));
  const trailingBlanks = parseMarkdownBlanks(
    Reflect.get(input, 'mdTrailingBlanks'),
    'tree.mdTrailingBlanks',
  );
  return trailingBlanks === undefined
    ? nodes
    : Object.assign(nodes, { mdTrailingBlanks: trailingBlanks });
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

function parseMarkdownPageModel(record: Record<string, unknown>): PageModel {
  const format = record['format'];
  if (format !== 'md' && format !== 'mdx') {fail('model.format', 'expected Markdown format');}
  if (!Array.isArray(record['imports'])) {fail('model.imports', 'expected array');}
  if (record['imports'].length > LIMITS.importsMax) {fail('model.imports', 'exceeds limit');}
  const imports = record['imports'].map((input, index) => {
    const value = asRecord(input, `model.imports[${index}]`);
    return {
      name: asString(value['name'], `model.imports[${index}].name`, LIMITS.tagNameCharsMax),
      path: asString(value['path'], `model.imports[${index}].path`, LIMITS.attrCharsMax),
      quote: "'",
    };
  });
  const layoutPath = record['layoutPath'];
  if (layoutPath !== null && typeof layoutPath !== 'string') {
    fail('model.layoutPath', 'expected string or null');
  }
  for (const field of ['mdEndsWithNewline', 'mdHasFrontmatter'] as const) {
    if (typeof record[field] !== 'boolean') {fail(`model.${field}`, 'expected boolean');}
  }
  return {
    imports,
    frontmatterLead: '',
    extraFrontmatter: asString(
      record['extraFrontmatter'],
      'model.extraFrontmatter',
      LIMITS.nodeValueCharsMax,
    ),
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

/** Parse the parsePage result envelope: not-editable is data, not an error. */
export function parsePageResult(input: unknown): ParsePageResult {
  const record = asRecord(input, 'result');
  if (record['editable'] === true) {
    return { editable: true, model: parsePageModel(record['model']) };
  }
  if (record['editable'] === false) {
    const bailInput = record['bail'];
    let bail = null;
    if (bailInput !== null && bailInput !== undefined) {
      const bailRecord = asRecord(bailInput, 'result.bail');
      bail = {
        what: asString(bailRecord['what'], 'result.bail.what', LIMITS.attrCharsMax),
        near: asString(bailRecord['near'], 'result.bail.near', LIMITS.attrCharsMax),
      };
    }
    return {
      editable: false,
      reason: asString(record['reason'], 'result.reason', LIMITS.attrCharsMax),
      bail,
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

interface TreeInvariantNode {
  readonly id?: string;
  readonly kind: string;
  readonly children?: readonly TreeInvariantNode[] | null;
}

/** Check the producer's own tree without cloning it or claiming it has already
 * crossed the wire parser. Iteration makes the depth limit independent of the
 * JavaScript call stack. The receiver checks the same invariant after parsing. */
export function assertTreeInvariants(nodes: readonly TreeInvariantNode[]): void {
  if (nodes.length > LIMITS.treeNodesMax) {
    throw new Error(`Tree invariant violated: exceeds ${LIMITS.treeNodesMax} nodes`);
  }
  const pending = nodes.map((node) => ({ node, depth: 0 }));
  const ids = new Set<string>();
  for (let index = 0; index < pending.length; index++) {
    const entry = pending[index];
    if (!entry) { throw new Error('Tree invariant violated: missing traversal entry'); }
    if (entry.depth > LIMITS.treeDepthMax) {
      throw new Error(`Tree invariant violated: exceeds depth ${LIMITS.treeDepthMax}`);
    }
    const { node, depth } = entry;
    if (typeof node.id !== 'string') {
      throw new Error('Tree invariant violated: missing id');
    }
    if (ids.has(node.id)) {
      throw new Error(`Tree invariant violated: duplicate id ${node.id}`);
    }
    ids.add(node.id);
    if (node.children) {
      if (pending.length + node.children.length > LIMITS.treeNodesMax) {
        throw new Error(`Tree invariant violated: exceeds ${LIMITS.treeNodesMax} nodes`);
      }
      for (const child of node.children) { pending.push({ node: child, depth: depth + 1 }); }
    }
  }
}
