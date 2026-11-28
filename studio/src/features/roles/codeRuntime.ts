// Where a page holds code, as the compiler that runs the site reads it (codeRuntimeCompiler.ts). The check judges this
// reading as well as the editor’s own (codeGuard.ts): a change is allowed only if neither finds new code in it. Each
// unit found here is keyed apart from the other reading’s, so that neither vouches for the other.
//
// Anything this does not know is code, which can only refuse more.
import { record } from '../../shared/validation';
import { parseAsRun } from './codeRuntimeCompiler';
import { declarationsOf, expressionUnit, fingerprint, readComponentTag, readScript, runsWritten, sinkOf, ANIMATION_VALUES, type CodeUnit } from './codeMarkup';

export interface RuntimeCode {
  readonly frontmatter: string;
  readonly units: readonly CodeUnit[];
  readonly errors: number;
}

const NODES_MAX = 200_000;
const PLACEHOLDER = '__avbMarkup';
// Text the browser would read as markup: only raw text can hold it.
const TAG_LIKE = /<[A-Za-z/!?]/;
const FUNCTIONS: ReadonlySet<unknown> = new Set(['ArrowFunctionExpression', 'FunctionExpression', 'FunctionDeclaration']);
const MARKUP: ReadonlySet<unknown> = new Set(['JSXElement', 'JSXFragment']);

type Item = Readonly<Record<string, unknown>>;

const isItem = (value: unknown): value is Item => typeof value === 'object' && value !== null && !Array.isArray(value);
const items = (value: unknown): readonly Item[] => (Array.isArray(value) ? value.filter(isItem) : []);

function offset(node: Item, side: 'start' | 'end'): number {
  const value = node[side];
  if (typeof value !== 'number') {
    throw new Error('This page could not be checked');
  }
  return value;
}

interface Entry {
  readonly node: Item;
  readonly names: ReadonlySet<string>;
  readonly within: string;
  readonly bound: string;
}

interface Walk {
  readonly source: string;
  readonly units: CodeUnit[];
  readonly pending: Entry[];
  readonly declarations: ReturnType<typeof declarationsOf>;
}

const text = (walk: Walk, node: Item) => walk.source.slice(offset(node, 'start'), offset(node, 'end'));

export async function readRuntimeCode(source: string): Promise<RuntimeCode> {
  const parsed = await parseAsRun(source);
  const fences = isItem(parsed.ast['frontmatter']) ? parsed.ast['frontmatter'] : undefined;
  const written = fences === undefined ? '' : source.slice(offset(fences, 'start'), offset(fences, 'end'));
  const frontmatter = written.replace(/^\s*---/, '').replace(/---\s*$/, '');
  const walk: Walk = { source, units: [], pending: [], declarations: declarationsOf(frontmatter) };
  walk.pending.push(...items(parsed.ast['body']).map((node) => ({ node, names: new Set<string>(), within: '', bound: '' })));
  for (let index = 0; index < walk.pending.length; index++) {
    if (index >= NODES_MAX) {
      throw new Error('This page is too large to check');
    }
    const entry = walk.pending[index];
    if (entry !== undefined) {
      read(walk, entry);
    }
  }
  const units = walk.units.map((unit) => ({ ...unit, key: `run:${unit.key}` }));
  return { frontmatter, units, errors: parsed.errors };
}

function read(walk: Walk, entry: Entry): void {
  const { node } = entry;
  const kind = node['type'];
  if (kind === 'JSXElement') {
    readElement(walk, entry);
  } else if (kind === 'JSXFragment') {
    walk.pending.push(...items(node['children']).map((child) => ({ ...entry, node: child })));
  } else if (kind === 'JSXExpressionContainer') {
    readContainer(walk, entry, 'none');
  } else if (kind === 'JSXText') {
    const value = text(walk, node);
    if (TAG_LIKE.test(value)) {
      walk.units.push({ kind: 'browser', key: `text:${entry.within}\n${value}` });
    }
  } else if (kind !== 'AstroComment' && kind !== 'AstroDoctype') {
    walk.units.push({ kind: 'browser', key: `node:${String(kind)}\n${text(walk, node)}` });
  }
}

function readElement(walk: Walk, entry: Entry): void {
  const opening = record(entry.node['openingElement']);
  const name = text(walk, record(opening['name']));
  const tag = name.toLowerCase();
  const component = /^[A-Z_$]|\./.test(name);
  const attributes = items(opening['attributes']);
  for (const attribute of attributes) {
    readAttribute(walk, entry, attribute, { element: !component, tag });
  }
  if (component) {
    readComponentTag(walk, name, entry);
  }
  if (!component && tag === 'script') {
    const written = attributes.map((attribute) => runtimeAttribute(walk, attribute));
    // The script's own node may span the whole element, so what it holds is what stands between its tags.
    const closing = isItem(entry.node['closingElement']) ? entry.node['closingElement'] : undefined;
    const content = closing === undefined ? '' : walk.source.slice(offset(opening, 'end'), offset(closing, 'start'));
    readScript(walk, written, content);
    return;
  }
  const within = `${entry.within.slice(-500)}/${tag}`;
  walk.pending.push(...items(entry.node['children']).map((child) => ({ node: child, names: entry.names, within, bound: entry.bound })));
}

// An attribute as the script reader asks about it.
function runtimeAttribute(walk: Walk, attribute: Item) {
  if (attribute['type'] !== 'JSXAttribute') {
    return { kind: 'spread', name: text(walk, attribute), value: '' };
  }
  const name = text(walk, record(attribute['name']));
  const value = isItem(attribute['value']) ? attribute['value'] : undefined;
  if (value === undefined) {
    return { kind: 'empty', name, value: '' };
  }
  const literal = value['type'] === 'Literal' && typeof value['value'] === 'string';
  return literal ? { kind: 'quoted', name, value: String(value['value']) } : { kind: 'expression', name, value: text(walk, value) };
}

function readAttribute(walk: Walk, entry: Entry, attribute: Item, owner: { readonly element: boolean; readonly tag: string }): void {
  if (attribute['type'] !== 'JSXAttribute') {
    walk.units.push(expressionUnit(text(walk, attribute), entry.names, 'names'));
    return;
  }
  const written = record(attribute['name']);
  const name = text(walk, written);
  const value = isItem(attribute['value']) ? attribute['value'] : undefined;
  if (value === undefined) {
    return;
  }
  if (value['type'] === 'Literal') {
    const literal = String(value['value']);
    if (runsWritten(name, literal, owner)) {
      walk.units.push({ kind: 'browser', key: `attribute:${name.toLowerCase()}=${literal}` });
    }
    return;
  }
  if (value['type'] !== 'JSXExpressionContainer') {
    walk.units.push({ kind: 'browser', key: `value:${text(walk, attribute)}` });
    return;
  }
  const animates = (owner.tag === 'animate' || owner.tag === 'set') && ANIMATION_VALUES.has(name.toLowerCase());
  const sink = animates ? 'url' : sinkOf(name, owner.element);
  // `{src}` names the attribute after what is written in it, so only a plain name is a value like any other.
  const shorthand = offset(value, 'start') <= offset(written, 'start');
  const plain = !shorthand || record(value['expression'])['type'] === 'Identifier';
  readContainer(walk, { ...entry, node: value }, plain ? sink : 'names');
}

// One `{…}`, with the markup inside it taken out and read in turn, knowing the callback names around it.
function readContainer(walk: Walk, entry: Entry, sink: Parameters<typeof expressionUnit>[2]): void {
  const expression = record(entry.node['expression']);
  const braced = walk.source[offset(entry.node, 'start')] === '{';
  const from = braced ? offset(entry.node, 'start') + 1 : offset(expression, 'start');
  const to = braced ? offset(entry.node, 'end') - 1 : offset(expression, 'end');
  const markup = markupWithin(expression, entry.names);
  let code = '';
  let at = from;
  for (const [index, found] of markup.entries()) {
    code += `${walk.source.slice(at, offset(found.node, 'start'))} ${PLACEHOLDER}${index} `;
    at = offset(found.node, 'end');
  }
  code += walk.source.slice(at, to);
  const placeholders = markup.map((_, index) => `${PLACEHOLDER}${index}`);
  const unit = expressionUnit(code, new Set([...entry.names, ...placeholders]), sink);
  const key = unit.key.replace(new RegExp(`${PLACEHOLDER}\\d+`, 'g'), PLACEHOLDER);
  walk.units.push({ ...unit, key });
  const bound = markup.length === 0 ? entry.bound : fingerprint(`${entry.bound}\n${key}`);
  walk.pending.push(...markup.map((found) => ({ node: found.node, names: found.names, within: entry.within, bound })));
}

interface Found {
  readonly node: Item;
  readonly names: ReadonlySet<string>;
}

// The outermost markup inside an expression, in the order it is written, each with the parameters around it.
function markupWithin(expression: Item, names: ReadonlySet<string>): readonly Found[] {
  const found: Found[] = [];
  const pending: Found[] = [{ node: expression, names }];
  for (let index = 0; index < pending.length; index++) {
    const entry = pending[index];
    if (entry === undefined || index >= NODES_MAX) {
      throw new Error('This page is too large to check');
    }
    if (MARKUP.has(entry.node['type'])) {
      // A fragment the compiler makes around sibling tags is written nowhere itself: its tags are.
      found.push(entry);
      continue;
    }
    const inner = FUNCTIONS.has(entry.node['type']) ? new Set([...entry.names, ...patternNames(items(entry.node['params']))]) : entry.names;
    for (const value of Object.values(entry.node)) {
      const children = Array.isArray(value) ? items(value) : isItem(value) ? [value] : [];
      pending.push(...children.map((node) => ({ node, names: inner })));
    }
  }
  return found.sort((left, right) => offset(left.node, 'start') - offset(right.node, 'start'));
}

function patternNames(patterns: readonly Item[]): readonly string[] {
  const names: string[] = [];
  const pending = [...patterns];
  for (let index = 0; index < pending.length && index < NODES_MAX; index++) {
    const pattern = pending[index];
    if (pattern === undefined) {
      continue;
    }
    if (pattern['type'] === 'Identifier') {
      names.push(String(pattern['name']));
    } else if (pattern['type'] === 'ObjectPattern') {
      pending.push(...items(pattern['properties']).flatMap((property) => items([property['value'] ?? property['argument']])));
    } else if (pattern['type'] === 'ArrayPattern') {
      pending.push(...items(pattern['elements']));
    } else {
      pending.push(...items([pattern['left'] ?? pattern['argument']]));
    }
  }
  return names;
}
