// What a component does with a `style` set on one of its instances, read from the component file.
//
// A component that writes `style={columns} {...rest}` does not keep both: on an element Astro writes two `style`
// attributes and the browser reads the first, so the instance's is ignored; on a tag chosen at run time (`<Tag>`)
// the spread replaces the component's (both seen with Astro 7.3.8). A component keeps both by naming `style` in its props and writing its
// own value and that one into one attribute, the instance's last, so the instance wins a property both declare:
//
//   const { class: className, style, ...rest } = Astro.props;
//   <div style={[columns, style].filter(Boolean).join("; ") || undefined} {...rest}>
//
// The Style panel and Design mode write an instance's style only where this reading proves it takes effect. The
// reading is conservative: what it cannot prove is `unproven`, never a guess. The frontmatter and the style
// expression are read with the JavaScript parser (@lezer/javascript); the template's tags by a bounded scan, since
// no Astro parser runs in the renderer.

import type { SyntaxNode } from '@lezer/common';
import { parser } from '@lezer/javascript';
import { assert } from '../../../../shared/core/assert';
import { matchingClose, stringEnd } from './inlineCode';

/** What happens to a `style` set on an instance. */
export type StyleForwarding =
  // The component writes its own style and the instance's together, the instance's last.
  | 'combines'
  // The instance's style reaches an element that writes none of its own.
  | 'passes'
  // The element the rest of the props go to writes its own `style`: one of the two is lost.
  | 'overrides'
  // The style reaches no element.
  | 'drops'
  // Anything this reading cannot follow.
  | 'unproven';

/** Why an instance's own `style` cannot be written: the file is not held, or what it does with it. */
export type InstanceStyleRefusal = 'unreadable' | 'overrides' | 'drops' | 'unproven';

/** Why a style written on an instance of the component reading `code` is not sure to take effect; undefined when it is. */
export function instanceStyleRefusal(code: string | undefined): InstanceStyleRefusal | undefined {
  if (code === undefined) {
    return 'unreadable';
  }
  const forwarding = styleForwardingOf(code);
  switch (forwarding) {
    case 'combines':
    case 'passes':
      return undefined;
    case 'overrides':
    case 'drops':
    case 'unproven':
      return forwarding;
    default: {
      const exhaustive: never = forwarding;
      return exhaustive;
    }
  }
}

const SOURCE_CHARS_MAX = 1_000_000;
const TEMPLATE_TAGS_MAX = 5_000;
const TAG_ATTRIBUTES_MAX = 256;
// `style={merged}` is followed to the `const` that builds it, and no further.
const CONST_DEPTH_MAX = 1;
const READINGS_MAX = 64;

const typescript = parser.configure({ dialect: 'ts' });

interface Frontmatter {
  /** The local name `style` is destructured to; undefined when the props destructure leaves it in the rest. */
  readonly styleName: string | undefined;
  /** The names that hold the instance's other props: the rest binding, or all of `Astro.props`. */
  readonly restNames: readonly string[];
  /** Top-level `const name = value`, by name, as written. */
  readonly constants: ReadonlyMap<string, string>;
  /** Names imported into the file: a tag by one of them is another component. */
  readonly imports: ReadonlySet<string>;
  /** How often each name is read in the frontmatter, outside the declaration that binds it. */
  readonly uses: ReadonlyMap<string, number>;
}

interface TagAttribute {
  /** `...` for a spread; the attribute's name otherwise. */
  readonly name: string;
  /** The expression in `{…}` or the template literal; undefined for a quoted or bare value. */
  readonly code: string | undefined;
}

interface Tag {
  readonly name: string;
  readonly attributes: readonly TagAttribute[];
}

const readings = new Map<string, StyleForwarding>();

/** What the component whose file reads `code` does with an instance's `style`. */
export function styleForwardingOf(code: string): StyleForwarding {
  const known = readings.get(code);
  if (known !== undefined) {
    return known;
  }
  const reading = read(code);
  if (readings.size >= READINGS_MAX) {
    const oldest = readings.keys().next().value;
    if (oldest !== undefined) {
      readings.delete(oldest);
    }
  }
  readings.set(code, reading);
  assert(readings.size <= READINGS_MAX, 'styleForwardingOf: the readings held are bounded');
  return reading;
}

function read(code: string): StyleForwarding {
  if (code.length > SOURCE_CHARS_MAX) {
    return 'unproven';
  }
  const fence = /^\s*---\r?\n([\s\S]*?)\r?\n---/.exec(code);
  const script = fence?.[1] ?? '';
  const template = code.slice(fence?.[0].length ?? 0);
  // `<style define:vars>` writes a style attribute on every element of the component by itself.
  if (template.includes('define:vars')) {
    return 'unproven';
  }
  const frontmatter = readFrontmatter(script);
  const tags = templateTags(template);
  if (frontmatter === undefined || tags === undefined) {
    return 'unproven';
  }
  // `Astro.props.style` read past the destructure is a use this reading does not follow.
  if (/Astro\s*\.\s*props\s*(\?\.|\.|\[)/.test(code)) {
    return 'unproven';
  }
  return frontmatter.styleName === undefined ? passedForwarding(frontmatter, tags) : namedForwarding(frontmatter, frontmatter.styleName, tags);
}

// `style` is named in the props: it reaches an element only where the template writes it.
function namedForwarding(frontmatter: Frontmatter, styleName: string, tags: readonly Tag[]): StyleForwarding {
  if (!restReadOnlyBySpread(frontmatter, tags)) {
    return 'unproven';
  }
  const styled: Tag[] = [];
  let combiningConstant: string | undefined;
  for (const tag of tags) {
    for (const attribute of tag.attributes) {
      if (attribute.code === undefined || !mentions(attribute.code, styleName)) {
        // `style={merged}`, the merge built in the frontmatter.
        const built = attribute.name === 'style' ? frontmatter.constants.get(attribute.code?.trim() ?? '') : undefined;
        if (built === undefined || !mentions(built, styleName)) {
          continue;
        }
        combiningConstant = attribute.code?.trim();
      }
      if (attribute.name !== 'style' || attribute.code === undefined) {
        return 'unproven';
      }
      if (!combines(attribute.code, styleName, frontmatter.constants)) {
        return 'unproven';
      }
      styled.push(tag);
    }
  }
  // The frontmatter may read `style` only to build the value the template writes.
  const built = combiningConstant === undefined ? 0 : countMentions(frontmatter.constants.get(combiningConstant) ?? '', styleName);
  if ((frontmatter.uses.get(styleName) ?? 0) !== built) {
    return 'unproven';
  }
  if (styled.length === 0) {
    return 'drops';
  }
  const spreading = tags.filter((tag) => spreadsRest(tag, frontmatter));
  if (spreading.length === 0) {
    const root = tags[0];
    return styled.length === 1 && styled[0] === root && root !== undefined && isElement(root, frontmatter) ? 'combines' : 'unproven';
  }
  // Every branch the rest of the props go to keeps the style, and each is an element, not another component.
  const kept = spreading.every((tag) => styled.includes(tag) && isElement(tag, frontmatter) && onlyRestSpread(tag, frontmatter));
  return kept && styled.every((tag) => spreading.includes(tag)) ? 'combines' : 'unproven';
}

// `style` stays among the other props: it reaches an element only where they are spread.
function passedForwarding(frontmatter: Frontmatter, tags: readonly Tag[]): StyleForwarding {
  if (!restReadOnlyBySpread(frontmatter, tags)) {
    return 'unproven';
  }
  const spreading = tags.filter((tag) => spreadsRest(tag, frontmatter));
  if (spreading.length === 0) {
    return 'drops';
  }
  if (spreading.some((tag) => !isElement(tag, frontmatter))) {
    return 'unproven';
  }
  if (spreading.some((tag) => tag.attributes.some((attribute) => attribute.name === 'style'))) {
    return 'overrides';
  }
  // A root that writes its own style while the instance's goes to an element inside is not the element selected.
  const root = tags[0];
  const rootStyled = root !== undefined && !spreading.includes(root) && root.attributes.some((attribute) => attribute.name === 'style');
  return rootStyled || spreading.some((tag) => !onlyRestSpread(tag, frontmatter)) ? 'unproven' : 'passes';
}

// The other props are followed only as `{...rest}`: read any other way, where `style` goes is not known.
function restReadOnlyBySpread(frontmatter: Frontmatter, tags: readonly Tag[]): boolean {
  if (frontmatter.restNames.some((name) => (frontmatter.uses.get(name) ?? 0) > 0)) {
    return false;
  }
  return tags.every((tag) =>
    tag.attributes.every((attribute) => {
      const value = attribute.code;
      if (value === undefined || isRestSpread(attribute, frontmatter)) {
        return true;
      }
      return ![...frontmatter.restNames, 'Astro.props'].some((name) => mentions(value, name));
    }),
  );
}

function isRestSpread(attribute: TagAttribute, frontmatter: Frontmatter): boolean {
  const value = attribute.code?.trim() ?? '';
  return attribute.name === '...' && (value === 'Astro.props' || frontmatter.restNames.includes(value));
}

function spreadsRest(tag: Tag, frontmatter: Frontmatter): boolean {
  return tag.attributes.some((attribute) => isRestSpread(attribute, frontmatter));
}

// Another object spread on the same element could bring a `style` of its own.
function onlyRestSpread(tag: Tag, frontmatter: Frontmatter): boolean {
  return tag.attributes.every((attribute) => attribute.name !== '...' || isRestSpread(attribute, frontmatter));
}

// An HTML element, or a tag chosen by a local value (`const { tag: Tag = "h2" } = Astro.props`).
function isElement(tag: Tag, frontmatter: Frontmatter): boolean {
  if (/^[a-z][a-z0-9-]*$/.test(tag.name)) {
    return true;
  }
  return /^[A-Z][\w$]*$/.test(tag.name) && tag.name !== 'Fragment' && !frontmatter.imports.has(tag.name);
}

/**
 * Whether the expression writes the instance's style after everything else, whatever the other values are:
 * `[a, b, style].filter(Boolean).join("; ")`, with or without `|| undefined`; a template literal ending
 * `…; ${style ?? ""}`; the style alone; or a `const` holding one of these.
 */
function combines(code: string, styleName: string, constants: ReadonlyMap<string, string>): boolean {
  let current = code;
  for (let depth = 0; depth <= CONST_DEPTH_MAX; depth += 1) {
    // An `!important` of the component's would beat the instance's declaration, whatever the order.
    if (/!\s*important/i.test(current)) {
      return false;
    }
    const source = `(${current}\n)`;
    const tree = typescript.parse(source);
    const expression = hasError(tree.topNode) ? undefined : unwrapped(tree.topNode.firstChild?.firstChild ?? undefined);
    if (expression === undefined) {
      return false;
    }
    const textOf = (part: SyntaxNode): string => source.slice(part.from, part.to);
    if (expression.name !== 'VariableName' || textOf(expression) === styleName) {
      return combinesExpression(expression, styleName, textOf);
    }
    const built = constants.get(textOf(expression));
    if (built === undefined) {
      return false;
    }
    current = built;
  }
  return false;
}

function combinesExpression(node: SyntaxNode, styleName: string, textOf: (part: SyntaxNode) => string): boolean {
  switch (node.name) {
    case 'VariableName':
      return textOf(node) === styleName;
    case 'BinaryExpression': {
      const parts = children(node);
      const [left, operator, right] = parts;
      if (left === undefined || operator === undefined || right === undefined || parts.length !== 3) {
        return false;
      }
      return textOf(operator) === '||' && textOf(right) === 'undefined' && joinsStyleLast(left, styleName, textOf);
    }
    case 'CallExpression':
      return joinsStyleLast(node, styleName, textOf);
    case 'TemplateString':
      return templateEndsWithStyle(textOf(node), styleName);
    default:
      return false;
  }
}

// `[…, style].filter(Boolean).join("; ")`.
function joinsStyleLast(node: SyntaxNode, styleName: string, textOf: (part: SyntaxNode) => string): boolean {
  const joined = node.name === 'CallExpression' ? methodCall(node, 'join', textOf) : undefined;
  if (joined === undefined || !/^(["'])\s*;\s*\1$/.test(joined.argument)) {
    return false;
  }
  const filtered = joined.object.name === 'CallExpression' ? methodCall(joined.object, 'filter', textOf) : undefined;
  if (filtered === undefined || filtered.argument !== 'Boolean' || filtered.object.name !== 'ArrayExpression') {
    return false;
  }
  const items = children(filtered.object).filter((item) => item.name !== '[' && item.name !== ']' && item.name !== ',');
  const last = items[items.length - 1];
  if (last === undefined || textOf(last) !== styleName) {
    return false;
  }
  // A nested array would join with commas; the style anywhere earlier would be a second copy under the component's.
  return items.slice(0, -1).every((item) => item.name !== 'ArrayExpression' && !mentions(textOf(item), styleName));
}

function methodCall(
  node: SyntaxNode,
  method: string,
  textOf: (part: SyntaxNode) => string,
): { readonly object: SyntaxNode; readonly argument: string } | undefined {
  const [callee, list] = children(node);
  if (callee?.name !== 'MemberExpression' || list?.name !== 'ArgList') {
    return undefined;
  }
  const [object, , property] = children(callee);
  if (object === undefined || property === undefined || textOf(property) !== method) {
    return undefined;
  }
  const argument = textOf(list).slice(1, -1).trim();
  return { object, argument };
}

// The literal ends `…;  ${style ?? ""}` (or `||`), with nothing but spaces and `;` after it.
function templateEndsWithStyle(literal: string, styleName: string): boolean {
  const name = styleName.replaceAll('$', '\\$');
  const ending = new RegExp(`\\$\\{\\s*${name}\\s*(\\?\\?|\\|\\|)\\s*(""|'')\\s*\\}[\\s;]*\`$`).exec(literal);
  if (ending === null) {
    return false;
  }
  const before = literal.slice(1, ending.index);
  return before.trimEnd().endsWith(';') && !mentions(before, styleName);
}

function readFrontmatter(script: string): Frontmatter | undefined {
  const tree = typescript.parse(script);
  if (hasError(tree.topNode)) {
    return undefined;
  }
  const textOf = (node: SyntaxNode): string => script.slice(node.from, node.to);
  let styleName: string | undefined;
  const restNames: string[] = [];
  const constants = new Map<string, string>();
  const imports = new Set<string>();
  const bindings = new Set<number>();
  for (const statement of children(tree.topNode)) {
    if (statement.name === 'ImportDeclaration') {
      for (const part of descendants(statement)) {
        if (part.name === 'VariableDefinition') {
          imports.add(textOf(part));
        }
      }
      continue;
    }
    if (statement.name !== 'VariableDeclaration') {
      continue;
    }
    const parts = children(statement);
    const equals = parts.findIndex((part) => part.name === 'Equals');
    const target = parts[equals - 1];
    const value = parts[equals + 1];
    if (equals < 1 || target === undefined || value === undefined) {
      continue;
    }
    const isConstant = textOf(parts[0] ?? statement) === 'const';
    if (isConstant && target.name === 'VariableDefinition') {
      constants.set(textOf(target), script.slice(value.from, value.to));
    }
    if (!/^Astro\s*\.\s*props(\s+(as|satisfies)\s[\s\S]*)?$/.test(script.slice(value.from, statementEnd(parts)).trim())) {
      continue;
    }
    if (target.name === 'VariableDefinition') {
      restNames.push(textOf(target));
      bindings.add(target.from);
      continue;
    }
    for (const property of children(target).filter((part) => part.name === 'PatternProperty')) {
      const inner = children(property);
      const binding = inner.find((part) => part.name === 'VariableDefinition');
      const key = inner.find((part) => part.name === 'PropertyName');
      if (inner.some((part) => part.name === 'Spread') && binding !== undefined) {
        restNames.push(textOf(binding));
        bindings.add(binding.from);
      } else if (key !== undefined && /^(["']?)style\1$/.test(textOf(key))) {
        // `let` could be assigned again before the template reads it.
        if (!isConstant) {
          return undefined;
        }
        styleName = textOf(binding ?? key);
        bindings.add((binding ?? key).from);
      }
    }
  }
  const uses = new Map<string, number>();
  for (const node of descendants(tree.topNode)) {
    if ((node.name === 'VariableName' || node.name === 'VariableDefinition') && !bindings.has(node.from)) {
      uses.set(textOf(node), (uses.get(textOf(node)) ?? 0) + 1);
    }
  }
  return { styleName, restNames, constants, imports, uses };
}

// Past the last part of a declaration, its `;` left out.
function statementEnd(parts: readonly SyntaxNode[]): number {
  const last = parts.filter((part) => part.name !== ';').at(-1);
  assert(last !== undefined, 'statementEnd: a declaration has parts');
  return last.to;
}

/** The template's tags in order, or undefined when one cannot be read. `<style>` and `<script>` contents are skipped. */
function templateTags(template: string): readonly Tag[] | undefined {
  const text = template.replace(/<!--[\s\S]*?-->|\{\s*\/\*[\s\S]*?\*\/\s*\}|<(style|script)\b[^>]*?(\/>|>[\s\S]*?<\/\1\s*>)/g, ' ');
  const opening = /<([A-Za-z][\w$.:-]*)(?=[\s/>])/g;
  const tags: Tag[] = [];
  let found = opening.exec(text);
  while (found !== null) {
    if (tags.length >= TEMPLATE_TAGS_MAX) {
      return undefined;
    }
    const attributes = tagAttributes(text, opening.lastIndex);
    if (attributes === undefined) {
      return undefined;
    }
    tags.push({ name: found[1] ?? '', attributes: attributes.list });
    assert(attributes.end >= opening.lastIndex, 'templateTags: the scan moves forward');
    opening.lastIndex = attributes.end;
    found = opening.exec(text);
  }
  return tags;
}

function tagAttributes(text: string, from: number): { readonly list: readonly TagAttribute[]; readonly end: number } | undefined {
  const list: TagAttribute[] = [];
  let index = from;
  for (let count = 0; count <= TAG_ATTRIBUTES_MAX; count += 1) {
    index = afterSpace(text, index);
    if (text.startsWith('/>', index) || text.startsWith('>', index)) {
      return { list, end: text.indexOf('>', index) + 1 };
    }
    if (text.charAt(index) === '{') {
      const close = matchingClose(text, index);
      if (close === undefined) {
        return undefined;
      }
      const inner = text.slice(index + 1, close).trim();
      list.push(inner.startsWith('...') ? { name: '...', code: inner.slice(3) } : { name: inner, code: inner });
      index = close + 1;
      continue;
    }
    const name = /^[^\s"'`<>/={}()]+/.exec(text.slice(index, index + 256))?.[0];
    if (name === undefined) {
      return undefined;
    }
    index = afterSpace(text, index + name.length);
    if (text.charAt(index) !== '=') {
      list.push({ name, code: undefined });
      continue;
    }
    const value = attributeValue(text, afterSpace(text, index + 1));
    if (value === undefined) {
      return undefined;
    }
    list.push({ name, code: value.code });
    index = value.end;
  }
  return undefined;
}

function attributeValue(text: string, from: number): { readonly code: string | undefined; readonly end: number } | undefined {
  const first = text.charAt(from);
  if (first === '{') {
    const close = matchingClose(text, from);
    return close === undefined ? undefined : { code: text.slice(from + 1, close), end: close + 1 };
  }
  if (first === '"' || first === "'") {
    const close = text.indexOf(first, from + 1);
    return close === -1 ? undefined : { code: undefined, end: close + 1 };
  }
  if (first === '`') {
    const close = stringEnd(text, from);
    return close === undefined ? undefined : { code: text.slice(from, close + 1), end: close + 1 };
  }
  const bare = /^[^\s"'`<>={}]+/.exec(text.slice(from, from + 1_024))?.[0];
  return bare === undefined ? undefined : { code: undefined, end: from + bare.length };
}

function afterSpace(text: string, index: number): number {
  let at = index;
  while (at < text.length && /\s/.test(text.charAt(at))) {
    at += 1;
  }
  return at;
}

// Whether the expression reads `name`.
function mentions(code: string, name: string): boolean {
  return countMentions(code, name) > 0;
}

/**
 * How often the expression reads `name`: as a name, not inside a string, nor as a property of something. An
 * expression the parser cannot read (markup inside it) is searched as text, so a doubt counts as a read.
 */
function countMentions(code: string, name: string): number {
  const source = `(${code}\n)`;
  const tree = typescript.parse(source);
  if (hasError(tree.topNode)) {
    return code.split(name).length - 1;
  }
  // A name read, or a shorthand property (`{ style }`), which reads the name it is called by.
  const read = descendants(tree.topNode).filter((node) => {
    if (node.name === 'VariableName') {
      return source.slice(node.from, node.to) === name;
    }
    const shorthand = node.name === 'PropertyDefinition' && node.parent?.name === 'Property' && node.nextSibling === null;
    return shorthand && source.slice(node.from, node.to) === name;
  });
  return read.length;
}

function unwrapped(node: SyntaxNode | undefined): SyntaxNode | undefined {
  let current = node;
  for (let round = 0; round < TAG_ATTRIBUTES_MAX && current?.name === 'ParenthesizedExpression'; round += 1) {
    current = children(current)[1];
  }
  return current;
}

function children(node: SyntaxNode): readonly SyntaxNode[] {
  const found: SyntaxNode[] = [];
  for (let child = node.firstChild; child !== null; child = child.nextSibling) {
    if (child.name !== 'LineComment' && child.name !== 'BlockComment') {
      found.push(child);
    }
  }
  return found;
}

// Every node under `node`, in no particular order. Bounded by the tree, which is bounded by the source's length.
function descendants(node: SyntaxNode): readonly SyntaxNode[] {
  const found: SyntaxNode[] = [];
  const cursor = node.cursor();
  while (cursor.next() && cursor.from < node.to) {
    found.push(cursor.node);
  }
  return found;
}

function hasError(node: SyntaxNode): boolean {
  return node.type.isError || descendants(node).some((part) => part.type.isError);
}
