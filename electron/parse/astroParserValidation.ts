// The serializer also receives legacy renderer and Markdown objects. Validate
// their wire shape once here; keep original nodes so source spelling survives.
import { toArray, toRecord } from '../../shared/core/record';
import { LIMITS } from '../../shared/core/limits';
import { parseMapBodyParts } from '../../shared/page/pageNode';
import { parseImportMember, parseImportSlots } from '../../shared/page/frontmatter';
import type { ImportMember } from '../../shared/page/frontmatter';
import type { ParserNode, ParserPageModel } from './astroParserTypes';

const NODE_VARIANT_FIELDS: Readonly<Record<string, readonly string[]>> = {
  component: ['name', 'children', 'shorthand', 'tightClose', 'closeSource', 'dynamicTag', 'astroAsset', 'chunkFile', 'chunkAggregate'],
  element: ['name', 'children', 'shorthand', 'tightClose', 'closeSource', 'dynamicTag', 'astroAsset', 'chunkFile', 'chunkAggregate'],
  text: ['value'],
  expr: ['value'],
  'raw-line': ['value'],
  comment: ['value', 'jsx'],
  raw: ['name', 'inner'],
  map: ['head', 'children', 'headSource', 'body', 'bodyParts', 'bare'],
  cond: ['op', 'test', 'children'],
  branch: ['name', 'children'],
  'chunk-group': ['name', 'chunkFile', 'children'],
};

export function parseSerializeNodes(input: unknown): ParserNode[] {
  const nodes = toArray(input);
  if (!nodes) {
    throw new Error('SerializeNodes: expected array');
  }
  if (nodes.length > LIMITS.treeNodesMax) {
    throw new Error('SerializeNodes: node limit');
  }
  if (!nodes.every(isParserNode)) {
    throw new Error('SerializeNodes: invalid node');
  }
  const pending: Array<{ readonly node: unknown; readonly depth: number }> = nodes.map((node) => ({
    node,
    depth: 0,
  }));
  let visited = 0;
  for (let index = 0; index < pending.length; index++) {
    const current = pending[index];
    if (!current) {
      throw new Error('SerializeNodes: missing traversal entry');
    }
    if (++visited > LIMITS.treeNodesMax) {
      throw new Error('SerializeNodes: node limit');
    }
    if (current.depth > LIMITS.treeDepthMax) {
      throw new Error('SerializeNodes: depth limit');
    }
    const record = parseSerializeNode(current.node);
    const children = toArray(record['children']);
    if (children) {
      if (pending.length + children.length > LIMITS.treeNodesMax) {
        throw new Error('SerializeNodes: node limit');
      }
      for (const node of children) {
        pending.push({ node, depth: current.depth + 1 });
      }
    }
  }
  return nodes;
}

export function parseSerializePage(input: unknown): ParserPageModel {
  const record = parseRecord(input, 'SerializePage');
  const imports = toArray(record['imports'] ?? []);
  if (!imports) {
    throw new Error('SerializePage.imports: expected array');
  }
  if (imports.length > LIMITS.importsMax) {
    throw new Error('SerializePage.imports: limit');
  }
  const layout = record['frontmatterLayout'] === undefined ? undefined : parseRecord(record['frontmatterLayout'], 'SerializePage.frontmatterLayout');
  return {
    imports: imports.map(parseSerializeImport),
    frontmatterLead: parseText(record['frontmatterLead'] ?? '', 'frontmatterLead'),
    extraFrontmatter: parseText(record['extraFrontmatter'] ?? '', 'extraFrontmatter'),
    extraFrontmatterSpaced: parseBoolean(record['extraFrontmatterSpaced'] ?? true),
    hadFrontmatter: parseBoolean(record['hadFrontmatter'] ?? true),
    trailingBlank: parseCount(record['trailingBlank'] ?? 0, 'trailingBlank'),
    eol: parsePageEol(record['eol']),
    nodes: parseSerializeNodes(record['nodes']),
    ...(layout === undefined
      ? {}
      : {
          frontmatterLayout: {
            extra: parseText(layout['extra'], 'frontmatterLayout.extra'),
            slots: parseImportSlots(layout['slots']),
          },
        }),
  };
}

function parsePageEol(input: unknown): '\n' | '\r\n' {
  if (input === undefined || input === '\n') {
    return '\n';
  }
  if (input === '\r\n') {
    return '\r\n';
  }
  throw new Error('SerializePage.eol: expected LF or CRLF');
}

function parseSerializeImport(input: unknown): ImportMember {
  const record = parseRecord(input, 'SerializeImport');
  const member = parseImportMember({
    ...record,
    quote: record['quote'] ?? "'",
    at: record['at'] ?? 0,
  });
  // New imports have no original source slot. A sentinel cannot match an
  // existing slot, whose offsets are all nonnegative.
  return record['at'] === undefined ? { ...member, at: -1 } : member;
}

function parseSerializeNode(input: unknown): Record<string, unknown> {
  const record = parseRecord(input, 'SerializeNode');
  parseSerializeMetadata(record);
  parseSerializeVariant(record);
  switch (record['kind']) {
    case 'text':
    case 'expr':
    case 'raw-line':
    case 'comment':
      parseText(record['value'], 'node.value');
      break;
    case 'raw':
      parseText(record['name'], 'node.name');
      parseText(record['inner'], 'node.inner');
      break;
    case 'component':
    case 'element':
    case 'branch':
    case 'chunk-group':
      parseText(record['name'], 'node.name');
      if (record['kind'] === 'branch') {
        if (record['name'] !== 'then' && record['name'] !== 'else') {
          throw new Error('SerializeNode: invalid branch name');
        }
      }
      if (record['kind'] === 'chunk-group') {
        parseText(record['chunkFile'], 'node.chunkFile');
      }
      parseSerializeChildren(record);
      break;
    case 'map':
      parseText(record['head'], 'node.head');
      if (record['bodyParts'] !== undefined) {
        parseMapBodyParts(record['bodyParts'], record['children']);
      }
      if (record['body'] !== undefined) {
        parseStrings(record['body'], LIMITS.treeNodesMax);
      }
      parseSerializeChildren(record);
      break;
    case 'cond':
      parseText(record['test'], 'node.test');
      if (record['op'] !== '?' && record['op'] !== '&&') {
        throw new Error('SerializeNode: invalid conditional operator');
      }
      parseSerializeChildren(record);
      break;
    default:
      throw new Error('SerializeNode: unknown kind');
  }
  return record;
}

function isParserNode(input: unknown): input is ParserNode {
  parseSerializeNode(input);
  return true;
}

// Variant-only fields cannot leak into another kind: the constructor below
// promises the same negative space that ParserNode enforces at compile time.
function parseSerializeVariant(record: Record<string, unknown>): void {
  const kind = record['kind'];
  if (typeof kind !== 'string') {
    throw new Error('SerializeNode: unknown kind');
  }
  const allowed = Object.hasOwn(NODE_VARIANT_FIELDS, kind) ? NODE_VARIANT_FIELDS[kind] : undefined;
  if (!allowed) {
    throw new Error('SerializeNode: unknown kind');
  }
  for (const field of [
    'name',
    'children',
    'shorthand',
    'tightClose',
    'closeSource',
    'dynamicTag',
    'astroAsset',
    'chunkFile',
    'chunkAggregate',
    'value',
    'jsx',
    'inner',
    'head',
    'headSource',
    'body',
    'bodyParts',
    'bare',
    'op',
    'test',
  ]) {
    if (record[field] !== undefined && !allowed.includes(field)) {
      throw new Error(`SerializeNode: ${field} is not valid on ${kind}`);
    }
  }
}

function parseSerializeChildren(record: Record<string, unknown>): void {
  // A self-closing tag says so with a present `children: undefined`; a missing
  // key is still a malformed node.
  if (Object.hasOwn(record, 'children')) {
    if (record['children'] === undefined) {
      if (record['kind'] === 'component' || record['kind'] === 'element') {
        return;
      }
    }
  }
  const children = toArray(record['children']);
  if (!children) {
    throw new Error('SerializeNode.children: expected array');
  }
  if (children.length > LIMITS.treeNodesMax) {
    throw new Error('SerializeNodes: node limit');
  }
  if (record['kind'] === 'cond') {
    for (const child of children) {
      if (toRecord(child)?.['kind'] !== 'branch') {
        throw new Error('SerializeNode: conditional children must be branches');
      }
    }
  }
}

function parseSerializeMetadata(record: Record<string, unknown>): void {
  for (const field of ['id', 'source', 'attrSource', 'closeSource', 'headSource', 'chunkFile', 'mdSource'] as const) {
    if (record[field] !== undefined) {
      parseText(record[field], `node.${field}`);
    }
  }
  for (const field of ['blankBefore', 'blankAfter', 'start', 'end'] as const) {
    if (record[field] !== undefined) {
      parseCount(record[field], `node.${field}`);
    }
  }
  for (const field of ['jsx', 'shorthand', 'tightClose', 'dynamicTag', 'astroAsset', 'chunkAggregate', 'bare'] as const) {
    if (record[field] !== undefined) {
      parseBoolean(record[field]);
    }
  }
  if (record['attrOrder'] !== undefined) {
    parseStrings(record['attrOrder'], LIMITS.attrsPerNodeMax);
  }
  if (record['props'] !== undefined) {
    parseSerializeProps(record['props']);
  }
}

function parseSerializeProps(input: unknown): void {
  const record = parseRecord(input, 'SerializeProps');
  const entries = Object.entries(record);
  if (entries.length > LIMITS.attrsPerNodeMax) {
    throw new Error('SerializeProps: attr limit');
  }
  for (const [name, input] of entries) {
    parseText(name, 'attribute name', LIMITS.attrCharsMax);
    const prop = parseRecord(input, 'SerializeProp');
    switch (prop['type']) {
      case 'bare':
        break;
      case 'expr':
      case 'spread':
      case 'string':
        parseText(prop['value'], 'attribute value', LIMITS.attrCharsMax);
        break;
      default:
        throw new Error('SerializeProp: unknown type');
    }
  }
}

function parseRecord(input: unknown, field: string): Record<string, unknown> {
  const record = toRecord(input);
  if (!record) {
    throw new Error(`${field}: expected object`);
  }
  return record;
}

function parseText(input: unknown, field: string, limit: number = LIMITS.nodeValueCharsMax): string {
  if (typeof input !== 'string') {
    throw new Error(`${field}: expected string`);
  }
  if (input.length > limit) {
    throw new Error(`${field}: exceeds limit`);
  }
  return input;
}

function parseStrings(input: unknown, limit: number): void {
  const list = toArray(input);
  if (!list) {
    throw new Error('SerializeNode: expected string array');
  }
  if (list.length > limit) {
    throw new Error('SerializeNode: string array limit');
  }
  for (const value of list) {
    parseText(value, 'array value');
  }
}

function parseCount(input: unknown, field: string): number {
  if (typeof input !== 'number') {
    throw new Error(`${field}: expected integer`);
  }
  if (!Number.isSafeInteger(input)) {
    throw new Error(`${field}: expected integer`);
  }
  if (input < 0 || input > LIMITS.ipcFieldCharsMax) {
    throw new Error(`${field}: outside source bounds`);
  }
  return input;
}

function parseBoolean(input: unknown): boolean {
  if (typeof input !== 'boolean') {
    throw new Error('SerializeNode: expected boolean');
  }
  return input;
}
