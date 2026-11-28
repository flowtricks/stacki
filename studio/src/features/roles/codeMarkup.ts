// Where an Astro page holds code, read with Astro's own compiler so this sees what the preview server will run:
// the frontmatter, every `{…}` expression with the callback names in scope around it, every attribute expression,
// and the browser code an attribute or a `<script>` carries. An MDX file is read for the same things (codeGuard.ts).
import { parse } from '@astrojs/compiler';
import type { AttributeNode, Node, TagLikeNode } from '@astrojs/compiler/types';
import ts from 'typescript';
import { parseExpression } from './codeExpression';
import { chainSources } from './codeModule';

export type CodeUnit =
  | {
      readonly kind: 'expression';
      readonly key: string;
      /** The text to parse; only a change that brings new text needs its syntax tree. */
      readonly code: string;
      readonly names: ReadonlySet<string>;
      /** A value the browser runs or reads as markup, which data alone does not make safe. */
      readonly sink: 'none' | 'handler' | 'url' | 'html';
    }
  | { readonly kind: 'browser'; readonly key: string };

export interface PageCode {
  readonly frontmatter: string;
  readonly units: readonly CodeUnit[];
  /** The data sources the markup's loops already read (`posts` in `posts.map(…)`). */
  readonly sources: readonly string[];
  readonly errors: number;
}

const NODES_MAX = 50_000;
const SCOPE_DEPTH_MAX = 200;
const URL_ATTRIBUTES: ReadonlySet<string> = new Set(['href', 'src', 'action', 'formaction', 'xlink:href', 'data', 'poster']);
const EVENT_NAMES =
  /^on(?:abort|animation\w+|before\w+|blur|canplay\w*|change|click|contextmenu|copy|cut|dblclick|drag\w*|drop|ended?|error|focus\w*|input|invalid|key\w+|load\w*|message|mouse\w+|paste|pause|play\w*|pointer\w+|popstate|resize|scroll\w*|select\w*|submit|toggle|touch\w+|transition\w+|unload|wheel)$/i;

const decodeEntities = (value: string): string =>
  value.replace(/&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|(colon|tab|newline|lt|gt|quot|amp));?/gi, (whole, decimal: string, hex: string, named: string) => {
    const code = decimal !== undefined && decimal !== '' ? Number(decimal) : hex !== undefined && hex !== '' ? Number.parseInt(hex, 16) : undefined;
    if (code !== undefined) {
      return code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    const names: Readonly<Record<string, string>> = { colon: ':', tab: '\t', newline: '\n', lt: '<', gt: '>', quot: '"', amp: '&' };
    return names[named.toLowerCase()] ?? whole;
  });

/** Whether an address runs script when followed or loaded. */
export function scriptAddress(value: string): boolean {
  const bare = decodeEntities(value).replace(/[\u0000- ]/g, '');
  return /^(?:javascript|vbscript):/i.test(bare) || /^data:(?:text\/html|text\/javascript|application\/javascript)/i.test(bare);
}

/** Whether HTML written into a page as a string runs script. */
export function scriptMarkup(value: string): boolean {
  const html = decodeEntities(value);
  return /<\s*script\b/i.test(html) || /<[a-z][^>]*[\s/"']on[a-z]+\s*=/i.test(html) || /(?:javascript|vbscript)\s*:/i.test(html) || /\bsrcdoc\s*=/i.test(html);
}

/** A page without its style blocks, comparable between two versions: equal means only styles differ. */
export async function markupBesideStyles(source: string): Promise<string> {
  const parsed = await parse(source, { position: false });
  const parts: string[] = [];
  const pending: (Node | string)[] = [...parsed.ast.children].reverse();
  for (let index = 0; pending.length > 0; index++) {
    if (index >= NODES_MAX * 2) {
      throw new Error('This page is too large to check');
    }
    const node = pending.pop();
    if (node === undefined) {
      break;
    }
    if (typeof node === 'string') {
      parts.push(node);
    } else if (node.type === 'text' || node.type === 'comment' || node.type === 'frontmatter' || node.type === 'doctype') {
      parts.push(node.type === 'text' ? node.value : `\u0000${node.type}:${node.value}\u0000`);
    } else if (node.type === 'expression') {
      parts.push('\u0000{');
      pending.push('}\u0000', ...[...node.children].reverse());
    } else if (node.type !== 'root' && (node.type !== 'element' || node.name !== 'style')) {
      const attributes = node.attributes.map((item) => [item.kind, item.name, item.value]);
      parts.push(`\u0000<${node.type} ${node.name} ${JSON.stringify(attributes)}\u0000`);
      pending.push(`\u0000/${node.name}>\u0000`, ...[...node.children].reverse());
    }
  }
  // Space around a block that came or went is not a change to the page.
  return parts
    .join('')
    .split('\u0000')
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .join('\u0000');
}

interface Walk {
  readonly units: CodeUnit[];
  readonly sources: string[];
  readonly pending: { readonly node: Node; readonly names: ReadonlySet<string> }[];
}

/** The code of one `.astro` source. */
export async function readPageCode(source: string): Promise<PageCode> {
  const parsed = await parse(source, { position: false });
  const walk: Walk = { units: [], sources: [], pending: [] };
  let frontmatter = '';
  walk.pending.push(...parsed.ast.children.map((node) => ({ node, names: new Set<string>() })));
  for (let index = 0; index < walk.pending.length; index++) {
    if (index >= NODES_MAX) {
      throw new Error('This page is too large to check');
    }
    const entry = walk.pending[index];
    if (entry === undefined) {
      break;
    }
    const { node, names } = entry;
    if (node.type === 'frontmatter') {
      frontmatter += node.value;
    } else if (node.type === 'expression') {
      readExpression(walk, node.children, names);
    } else if (node.type === 'element' || node.type === 'component' || node.type === 'custom-element' || node.type === 'fragment') {
      readTag(walk, node, names);
    }
  }
  const errors = parsed.diagnostics.filter((diagnostic) => diagnostic.severity === 1).length;
  return { frontmatter, units: walk.units, sources: walk.sources, errors };
}

function readTag(walk: Walk, node: TagLikeNode, names: ReadonlySet<string>): void {
  const element = node.type === 'element' || node.type === 'custom-element';
  for (const attribute of node.attributes) {
    readAttribute(walk, attribute, names, element);
  }
  if (element && node.name.toLowerCase() === 'script') {
    readScript(walk, node);
    return;
  }
  walk.pending.push(...node.children.map((child) => ({ node: child, names })));
}

// An empty script, as the Add panel writes one, runs nothing; JSON data in a script tag is never run.
function readScript(walk: Walk, node: TagLikeNode): void {
  const content = node.children.map((child) => (child.type === 'text' ? child.value : '')).join('');
  const attribute = (name: string) => node.attributes.find((item) => item.name.toLowerCase() === name);
  const written = node.attributes.map((item) => `${item.kind} ${item.name}=${item.value}`).join('\n');
  const type = attribute('type');
  const data = type?.kind === 'quoted' && type.value === 'application/ld+json' && attribute('src') === undefined;
  const empty = content.trim() === '' && attribute('src') === undefined && attribute('set:html') === undefined;
  if (!data && !empty) {
    walk.units.push({ kind: 'browser', key: `script:${written}\n${content}` });
  }
}

function sinkOf(name: string, element: boolean): 'none' | 'handler' | 'url' | 'html' {
  const lower = name.toLowerCase();
  if (element ? /^on[a-z]+$/.test(lower) : EVENT_NAMES.test(name)) {
    return 'handler';
  }
  if (URL_ATTRIBUTES.has(lower)) {
    return 'url';
  }
  return lower === 'set:html' || lower === 'srcdoc' ? 'html' : 'none';
}

function readAttribute(walk: Walk, attribute: AttributeNode, names: ReadonlySet<string>, element: boolean): void {
  const sink = sinkOf(attribute.name, element);
  if (attribute.kind === 'quoted' || attribute.kind === 'empty') {
    const runs = sink === 'handler' || (sink === 'url' && scriptAddress(attribute.value)) || (sink === 'html' && scriptMarkup(attribute.value));
    if (runs) {
      walk.units.push({ kind: 'browser', key: `attribute:${attribute.name.toLowerCase()}=${attribute.value}` });
    }
    return;
  }
  if (attribute.kind === 'shorthand' || attribute.kind === 'spread') {
    walk.units.push(expressionUnit(attribute.name, names, 'none'));
    return;
  }
  const code = attribute.kind === 'template-literal' ? `\`${attribute.value}\`` : attribute.value;
  walk.units.push(expressionUnit(code, names, sink));
}

export function expressionUnit(code: string, names: ReadonlySet<string>, sink: 'none' | 'handler' | 'url' | 'html'): CodeUnit {
  const text = code.trim();
  // A comment alone, or nothing at all, is no code.
  const blank = text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '').trim() === '';
  return {
    kind: 'expression',
    key: `${sink === 'none' ? 'expression' : sink}:${text}`,
    code: blank ? 'undefined' : text,
    names,
    sink,
  };
}

const PLACEHOLDER = '__avbMarkup';

// `{items.map((item) => (<li>{item}</li>))}` is judged as `items.map((item) => (__avbMarkup0))`, and the markup inside
// is walked in turn, knowing `item` is in scope there.
function readExpression(walk: Walk, children: readonly Node[], names: ReadonlySet<string>): void {
  const markup: Node[] = [];
  const code = children
    .map((child) => {
      if (child.type === 'text') {
        return child.value;
      }
      markup.push(child);
      return ` ${PLACEHOLDER}${markup.length - 1} `;
    })
    .join('');
  const placeholders = new Set(markup.map((_, index) => `${PLACEHOLDER}${index}`));
  const unit = expressionUnit(code, new Set([...names, ...placeholders]), 'none');
  // The key keeps the markup's place without its bytes: editing the words inside leaves the expression the same.
  walk.units.push({ ...unit, key: unit.key.replace(new RegExp(`${PLACEHOLDER}\\d+`, 'g'), PLACEHOLDER) });
  const reads = markup.length > 0 || code.includes('.map(');
  const expression = reads && unit.kind === 'expression' ? parseExpression(unit.code) : undefined;
  const scopes = expression === undefined ? new Map<string, ReadonlySet<string>>() : placeholderScopes(expression, names);
  if (expression !== undefined) {
    walk.sources.push(...loopSources(expression));
  }
  markup.forEach((node, index) => walk.pending.push({ node, names: scopes.get(`${PLACEHOLDER}${index}`) ?? names }));
}

// The names each placeholder can read: those outside, plus the parameters of every callback around it.
function placeholderScopes(expression: ts.Expression, names: ReadonlySet<string>): ReadonlyMap<string, ReadonlySet<string>> {
  const found = new Map<string, ReadonlySet<string>>();
  const visit = (node: ts.Node, scope: ReadonlySet<string>, depth: number): void => {
    if (depth > SCOPE_DEPTH_MAX) {
      return;
    }
    if (ts.isIdentifier(node) && node.text.startsWith(PLACEHOLDER)) {
      found.set(node.text, scope);
    }
    const inner = ts.isArrowFunction(node) ? new Set([...scope, ...node.parameters.flatMap((parameter) => parameterNames(parameter.name, 0))]) : scope;
    ts.forEachChild(node, (child) => visit(child, inner, depth + 1));
  };
  visit(expression, names, 0);
  return found;
}

function parameterNames(name: ts.BindingName, depth: number): readonly string[] {
  if (ts.isIdentifier(name)) {
    return [name.text];
  }
  if (depth > SCOPE_DEPTH_MAX) {
    return [];
  }
  return name.elements.flatMap((element) => (ts.isOmittedExpression(element) ? [] : parameterNames(element.name, depth + 1)));
}

// What a loop reads: `items`, and each step of `items.filter(…).map(…)`.
function loopSources(expression: ts.Expression): readonly string[] {
  if (ts.isCallExpression(expression) && ts.isPropertyAccessExpression(expression.expression) && expression.expression.name.text === 'map') {
    return chainSources(expression.expression.expression);
  }
  return [];
}
