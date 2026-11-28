// Where an Astro page holds code, read with Astro's own compiler so this sees what the preview server will run:
// the frontmatter, every `{…}` expression with the callback names in scope around it, every attribute expression,
// and the browser code an attribute or a `<script>` carries. An MDX file is read for the same things (codeGuard.ts).
import { parseAstro } from './codeCompiler';
import type { AttributeNode, Node, TagLikeNode } from '@astrojs/compiler/types';
import ts from 'typescript';
import { createHash } from 'node:crypto';
import { onlyComments } from './codeText';
import { parseExpression, scriptValue } from './codeExpression';
import { chainSources, declaredNames, importSpecifier, readModule } from './codeModule';

export type CodeUnit =
  | {
      readonly kind: 'expression';
      readonly key: string;
      /** The text to parse; only a change that brings new text needs its syntax tree. */
      readonly code: string;
      readonly names: ReadonlySet<string>;
      /** A value the browser runs or reads as markup, which data alone does not make safe. */
      readonly sink: Sink;
    }
  | { readonly kind: 'browser'; readonly key: string };

/**
 * Where a value ends up. `handler`, `html` and `names` are never accepted as new code: the browser runs the first,
 * reads the second as markup, and the third also chooses the names of the attributes that are written.
 */
export type Sink = 'none' | 'handler' | 'url' | 'html' | 'names';

export interface PageCode {
  readonly frontmatter: string;
  readonly units: readonly CodeUnit[];
  /** The data sources the markup's loops already read (`posts` in `posts.map(…)`). */
  readonly sources: readonly string[];
  readonly errors: number;
}

const NODES_MAX = 50_000;
const SCOPE_DEPTH_MAX = 200;
const TAG_LIKE = /<[A-Za-z/!?]/;
const URL_ATTRIBUTES: ReadonlySet<string> = new Set(['href', 'src', 'action', 'formaction', 'xlink:href', 'data', 'poster']);
const EVENT_NAMES =
  /^on(?:abort|animation\w+|auxclick|before\w+|begin|blur|cancel|canplay\w*|change|click|close|command|content\w+|context\w*|copy|cuechange|cut|dblclick|device\w+|drag\w*|drop|durationchange|emptied|ended?|error|focus\w*|formdata|fullscreen\w+|gotpointercapture|hashchange|input|invalid|key\w+|languagechange|load\w*|lostpointercapture|message\w*|mouse\w+|offline|online|orientationchange|page\w+|paste|pause|play\w*|pointer\w+|popstate|progress|ratechange|readystatechange|rejectionhandled|repeat|reset|resize|scroll\w*|search|securitypolicyviolation|seek\w+|select\w*|slotchange|stalled|storage|submit|suspend|timeupdate|toggle|touch\w+|transition\w+|unhandledrejection|unload|visibilitychange|volumechange|waiting|webkit\w+|wheel)$/i;

export const decodeEntities = (value: string): string =>
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
  // A handler anywhere after a tag opens: a `>` inside an earlier quoted value does not end the tag.
  const tag = html.search(/<[a-z]/i);
  const handler = tag >= 0 && /[\s/"']on[a-z]+\s*=/i.test(html.slice(tag));
  return /<\s*script\b/i.test(html) || handler || /(?:javascript|vbscript)\s*:/i.test(html) || /\bsrcdoc\s*=/i.test(html);
}

/** A page without its style blocks, comparable between two versions: equal means only styles differ. */
export async function markupBesideStyles(source: string): Promise<string> {
  const parsed = await parseAstro(source);
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

interface Entry {
  readonly node: Node;
  readonly names: ReadonlySet<string>;
  /** The expressions around the node, which bind the names it can read. */
  readonly bound: string;
}

interface Walk {
  readonly units: CodeUnit[];
  readonly sources: string[];
  readonly pending: Entry[];
  readonly declarations: Declarations;
}

/** What the frontmatter declares, to tell a component's tag from a tag that is whatever a value says. */
export interface Declarations {
  readonly components: ReadonlySet<string>;
  readonly declared: ReadonlyMap<string, string>;
}

// An imported data file's value is whatever the file says, so as a tag it is no component.
const DATA_MODULE = /\.(?:json|md|markdown|mdoc|ya?ml|toml|csv|ndjson|txt|css|scss|sass|less)$/i;

export const fingerprint = (value: string): string => createHash('sha256').update(value).digest('base64');

export function declarationsOf(frontmatter: string): Declarations {
  const components = new Set<string>();
  const declared = new Map<string, string>();
  for (const statement of readModule(frontmatter).statements) {
    const names = declaredNames(statement);
    const specifier = importSpecifier(statement);
    let written: string | undefined;
    for (const name of names) {
      if (specifier !== undefined && !DATA_MODULE.test(specifier)) {
        components.add(name);
      } else {
        // Digests, not the statements themselves: one statement may declare thousands of names.
        declared.set(name, fingerprint(`${declared.get(name) ?? ''}\n${(written ??= fingerprint(statement.getText()))}`));
      }
    }
  }
  return { components, declared };
}

/** The code of one `.astro` source. */
export async function readPageCode(source: string): Promise<PageCode> {
  const parsed = await parseAstro(source);
  const frontmatter = parsed.ast.children.map((node) => (node.type === 'frontmatter' ? node.value : '')).join('');
  const walk: Walk = { units: [], sources: [], pending: [], declarations: declarationsOf(frontmatter) };
  walk.pending.push(...parsed.ast.children.map((node) => ({ node, names: new Set<string>(), bound: '' })));
  for (let index = 0; index < walk.pending.length; index++) {
    if (index >= NODES_MAX) {
      throw new Error('This page is too large to check');
    }
    const entry = walk.pending[index];
    if (entry === undefined) {
      break;
    }
    const { node } = entry;
    if (node.type === 'expression') {
      // The compiler gives an empty `{}` no list at all.
      readExpression(walk, node.children ?? [], entry);
    } else if (node.type === 'element' || node.type === 'component' || node.type === 'custom-element' || node.type === 'fragment') {
      readTag(walk, node, entry);
    }
  }
  const errors = parsed.diagnostics.filter((diagnostic) => diagnostic.severity === 1).length;
  return { frontmatter, units: walk.units, sources: walk.sources, errors };
}

function readTag(walk: Walk, node: TagLikeNode, entry: Entry): void {
  const element = node.type === 'element' || node.type === 'custom-element';
  const tag = node.name.toLowerCase();
  for (const attribute of node.attributes) {
    readAttribute(walk, attribute, entry.names, { element, tag });
  }
  if (node.type === 'component' || node.type === 'fragment') {
    readComponentTag(walk, node.name, entry);
  }
  if (element && tag === 'script') {
    readScript(walk, node.attributes, node.children.map((child) => (child.type === 'text' ? child.value : '')).join(''));
    return;
  }
  walk.pending.push(...node.children.map((child) => ({ node: child, names: entry.names, bound: entry.bound })));
}

// A tag named after a value writes whatever element the value says. It is code, together with what gives it its value,
// unless it was already there unchanged.
export function readComponentTag(walk: Pick<Walk, 'units' | 'declarations'>, name: string, entry: Pick<Entry, 'names' | 'bound'>): void {
  const root = name.split('.')[0] ?? '';
  if (root === '') {
    return;
  }
  const local = entry.names.has(root);
  const declared = walk.declarations.declared.get(root);
  const compiled = root === 'Fragment' && declared === undefined;
  if (!local && (compiled || (walk.declarations.components.has(root) && declared === undefined))) {
    return;
  }
  walk.units.push({ kind: 'browser', key: `tag:${name}\n${local ? entry.bound : (declared ?? '')}` });
}

interface ScriptAttribute {
  readonly kind: string;
  readonly name: string;
  readonly value: string;
}

// An empty script, as the Add panel writes one, runs nothing; JSON data in a script tag is never run.
export function readScript(walk: Pick<Walk, 'units'>, attributes: readonly ScriptAttribute[], content: string): void {
  // A value, a spread or a directive could change what the tag is.
  const plain = attributes.every((item) => (item.kind === 'quoted' || item.kind === 'empty') && !item.name.includes(':'));
  const attribute = (name: string) => attributes.find((item) => item.name.toLowerCase() === name);
  const written = attributes.map((item) => `${item.kind} ${item.name}=${item.value}`).join('\n');
  const type = attribute('type');
  const typed = plain && type?.kind === 'quoted' && type.value === 'application/ld+json';
  // Data holds no tag.
  const data = typed && attribute('src') === undefined && !TAG_LIKE.test(content);
  const empty = content.trim() === '' && attribute('src') === undefined && attribute('set:html') === undefined;
  if (!data && !empty) {
    walk.units.push({ kind: 'browser', key: `script:${written}\n${content}` });
  }
}

export function sinkOf(name: string, element: boolean): 'none' | 'handler' | 'url' | 'html' {
  const lower = name.toLowerCase();
  if (element ? /^on[a-z]+$/.test(lower) : EVENT_NAMES.test(name)) {
    return 'handler';
  }
  if (URL_ATTRIBUTES.has(lower)) {
    return 'url';
  }
  return lower === 'set:html' || lower === 'srcdoc' ? 'html' : 'none';
}

/** The attributes with which an SVG animation writes another attribute, a link among them. */
export const ANIMATION_VALUES: ReadonlySet<string> = new Set(['values', 'to', 'from', 'by']);
const ANIMATIONS: ReadonlySet<string> = new Set(['animate', 'set']);

export interface Owner {
  readonly element: boolean;
  readonly tag: string;
}

// A value that holds markup may be printed as markup. Words that only mention a script stay words.
const holdsScript = (value: string): boolean => /<[a-z]/i.test(decodeEntities(value)) && scriptMarkup(value);

/** Whether a written (not computed) attribute value makes the browser run something. */
export function runsWritten(name: string, value: string, owner: Owner): boolean {
  const sink = sinkOf(name, owner.element);
  if (sink === 'handler') {
    return true;
  }
  if (ANIMATIONS.has(owner.tag) && ANIMATION_VALUES.has(name.toLowerCase())) {
    return value.split(';').some(scriptAddress);
  }
  return (sink === 'url' ? scriptAddress(value) : scriptValue(decodeEntities(value))) || holdsScript(value);
}

function readAttribute(walk: Walk, attribute: AttributeNode, names: ReadonlySet<string>, owner: Owner): void {
  const animates = ANIMATIONS.has(owner.tag) && ANIMATION_VALUES.has(attribute.name.toLowerCase());
  const sink = animates ? 'url' : sinkOf(attribute.name, owner.element);
  if (attribute.kind === 'quoted' || attribute.kind === 'empty') {
    if (runsWritten(attribute.name, attribute.value, owner)) {
      walk.units.push({ kind: 'browser', key: `attribute:${attribute.name.toLowerCase()}=${attribute.value}` });
    }
    return;
  }
  if (attribute.kind === 'spread') {
    walk.units.push(expressionUnit(attribute.name, names, 'names'));
    return;
  }
  if (attribute.kind === 'shorthand') {
    // `{src}` names the attribute after its text, so only a plain name is a value like any other.
    walk.units.push(expressionUnit(attribute.name, names, /^[A-Za-z_$][\w$]*$/.test(attribute.name.trim()) ? sink : 'names'));
    return;
  }
  const code = attribute.kind === 'template-literal' ? `\`${attribute.value}\`` : attribute.value;
  walk.units.push(expressionUnit(code, names, sink));
}

export function expressionUnit(code: string, names: ReadonlySet<string>, sink: Sink): CodeUnit {
  const text = code.trim();
  // A comment alone, or nothing at all, is no code.
  const blank = onlyComments(text);
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
function readExpression(walk: Walk, children: readonly Node[], entry: Entry): void {
  const { names } = entry;
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
  const key = unit.key.replace(new RegExp(`${PLACEHOLDER}\\d+`, 'g'), PLACEHOLDER);
  walk.units.push({ ...unit, key });
  const reads = markup.length > 0 || code.includes('.map(');
  const expression = reads && unit.kind === 'expression' ? parseExpression(unit.code) : undefined;
  const scopes = expression === undefined ? new Map<string, ReadonlySet<string>>() : placeholderScopes(expression, names);
  if (expression !== undefined) {
    walk.sources.push(...loopSources(expression));
  }
  // What binds the names inside, as one short value however deep and long the expressions around are.
  const bound = markup.length === 0 ? entry.bound : fingerprint(`${entry.bound}\n${key}`);
  markup.forEach((node, index) => walk.pending.push({ node, names: scopes.get(`${PLACEHOLDER}${index}`) ?? names, bound }));
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
