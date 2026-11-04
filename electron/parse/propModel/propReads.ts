// How a component reads its props, on the TypeScript syntax tree of its
// frontmatter (and, for the template, its `Astro.props.x` reads): every
// destructure of `Astro.props` (or of a name that holds it, `const props =
// Astro.props`) with each entry's default, the names it reads directly, the
// `const x = xProp ?? "literal"` fallbacks, and whether the props object
// escapes whole (`{...Astro.props}`), which makes "unread" unknowable.

import ts from 'typescript';
import { assert } from '../../../shared/core/assert';
import { LIMITS } from '../../../shared/core/limits';
import type { PropDefault } from '../../../shared/properties/propSchema';
import { isAstroProps, syntaxNodes } from '../astroSyntax';
import type { PropsPattern } from './propDeclarations';
import { memberKey } from './propTypes';

/** One destructure entry: the prop it reads and its default, as written. */
export interface PropEntry {
  readonly name: string;
  readonly fallback: EntryFallback;
}

/** A destructure default: a literal is a value; anything else is kept as code. */
export type EntryFallback =
  | { readonly kind: 'none' }
  | { readonly kind: 'literal'; readonly value: PropDefault }
  | { readonly kind: 'expression'; readonly code: string; readonly shape: 'array' | 'object' | 'function' | 'other' };

/** What the component's code says about reading its props. */
export interface PropReads {
  readonly patterns: readonly PropsPattern[];
  // Destructured props in source order, the first entry for each name.
  readonly entries: readonly PropEntry[];
  // Props read by name (`Astro.props.label`, `props.year`), in source order.
  readonly direct: readonly string[];
  // True when the props object is used whole somewhere a name cannot be told.
  readonly escapes: boolean;
}

// A component reads its props in a handful of places; past this many reads the rest are not listed.
const READS_MAX = 512;

export function readProps(frontmatter: ts.SourceFile, template: string): PropReads {
  const nodes = [...syntaxNodes(frontmatter)].sort((first, second) => first.pos - second.pos || second.end - first.end);
  const holders = new Set<string>();
  for (const node of nodes) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && isAstroProps(node.initializer)) {
      holders.add(node.name.text);
    }
  }
  const patterns: PropsPattern[] = [];
  const direct: string[] = [];
  let escapes = false;
  for (const node of nodes) {
    const use = propsUse(node, holders);
    if (use === undefined) {
      continue;
    }
    const outer = unwrapped(node);
    const parent = outer.parent;
    if (ts.isPropertyAccessExpression(parent) && parent.expression === outer) {
      pushBounded(direct, parent.name.text);
    } else if (ts.isElementAccessExpression(parent) && parent.expression === outer && ts.isStringLiteralLike(parent.argumentExpression)) {
      pushBounded(direct, parent.argumentExpression.text);
    } else if (ts.isVariableDeclaration(parent) && parent.initializer === outer && ts.isObjectBindingPattern(parent.name)) {
      patterns.push({ pattern: parent.name, annotation: parent.type });
      escapes ||= parent.name.elements.some((element) => element.dotDotDotToken !== undefined);
    } else if (ts.isVariableDeclaration(parent) && parent.initializer === outer && ts.isIdentifier(parent.name) && use === 'astro') {
      // `const props = Astro.props`: the holder's own reads are found above.
    } else {
      escapes = true;
    }
  }
  const templateUse = templateReads(template, holders);
  const entries = destructureEntries(patterns, frontmatter);
  assert(entries.length <= LIMITS.propSchemaFieldsMax, 'readProps: entries are bounded');
  return { patterns, entries, direct: [...direct, ...templateUse.direct].slice(0, READS_MAX), escapes: escapes || templateUse.escapes };
}

function pushBounded(out: string[], name: string): void {
  if (out.length < READS_MAX && name !== '') {
    out.push(name);
  }
}

// Whether a node is `Astro.props` itself, or a name that holds it.
function propsUse(node: ts.Node, holders: ReadonlySet<string>): 'astro' | 'holder' | undefined {
  if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'Astro' && node.name.text === 'props') {
    return 'astro';
  }
  if (!ts.isIdentifier(node) || !holders.has(node.text)) {
    return undefined;
  }
  const parent = node.parent;
  // The holder's own declaration, and a member name that happens to match, are not uses.
  if (ts.isVariableDeclaration(parent) && parent.name === node) {
    return undefined;
  }
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) {
    return undefined;
  }
  if (ts.isBindingElement(parent) || ts.isPropertyAssignment(parent) || ts.isPropertySignature(parent)) {
    return undefined;
  }
  return 'holder';
}

// `(Astro.props as Props)` reads as Astro.props: wrappers are looked through, a bounded few.
const WRAPPERS_MAX = 16;
function unwrapped(node: ts.Node): ts.Node {
  let current = node;
  for (let step = 0; step < WRAPPERS_MAX; step++) {
    const parent = current.parent;
    if (ts.isParenthesizedExpression(parent) || ts.isAsExpression(parent) || ts.isSatisfiesExpression(parent) || ts.isNonNullExpression(parent)) {
      current = parent;
    } else {
      break;
    }
  }
  return current;
}

function destructureEntries(patterns: readonly PropsPattern[], file: ts.SourceFile): readonly PropEntry[] {
  const entries = new Map<string, PropEntry>();
  for (const { pattern } of patterns) {
    for (const element of pattern.elements) {
      if (element.dotDotDotToken !== undefined || entries.size >= LIMITS.propSchemaFieldsMax) {
        continue;
      }
      const name = memberKey(element.propertyName ?? element.name);
      if (name === undefined || entries.has(name)) {
        continue;
      }
      entries.set(name, { name, fallback: element.initializer === undefined ? { kind: 'none' } : entryFallback(element.initializer, file) });
    }
  }
  return [...entries.values()];
}

/** What a default's code says: a literal is its value, anything else stays code. */
export function entryFallback(initializer: ts.Expression, file: ts.SourceFile): EntryFallback {
  const literal = literalValue(initializer);
  if (literal !== undefined) {
    return { kind: 'literal', value: literal };
  }
  const code = initializer.getText(file);
  const inner = ts.isParenthesizedExpression(initializer) ? initializer.expression : initializer;
  if (ts.isArrayLiteralExpression(inner)) {
    return { kind: 'expression', code, shape: 'array' };
  }
  if (ts.isObjectLiteralExpression(inner)) {
    return { kind: 'expression', code, shape: 'object' };
  }
  if (ts.isArrowFunction(inner) || ts.isFunctionExpression(inner)) {
    return { kind: 'expression', code, shape: 'function' };
  }
  return { kind: 'expression', code, shape: 'other' };
}

/**
 * A literal expression's value: a whole string (a template only when it has no
 * `${}`: `` `${SITE}:` `` is an expression), `true`/`false`, or a number in any
 * of the ways JS writes one (`-2`, `0.5`, `1e3`, `0x10`, `1_000`).
 */
export function literalValue(node: ts.Expression): PropDefault | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  if (node.kind === ts.SyntaxKind.TrueKeyword) {
    return true;
  }
  if (node.kind === ts.SyntaxKind.FalseKeyword) {
    return false;
  }
  if (ts.isNumericLiteral(node)) {
    const value = Number(node.text);
    return Number.isFinite(value) ? value : undefined;
  }
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(node.operand)) {
    const value = -Number(node.operand.text);
    return Number.isFinite(value) ? value : undefined;
  }
  return undefined;
}

// The template's reads: `Astro.props.label`, `Astro.props["label"]`, and a
// holder's `props.label`. The template is markup, not TypeScript, so it is
// read as text; any other mention of the props object (`{...Astro.props}`)
// is an escape. A name read as a member (`item.props`) is not a mention.
function templateReads(template: string, holders: ReadonlySet<string>): { readonly direct: readonly string[]; readonly escapes: boolean } {
  const direct: string[] = [];
  let escapes = false;
  const owners = ['Astro\\.props', ...[...holders].map((name) => name.replace(/\$/g, '\\$'))];
  const mention = new RegExp(
    String.raw`(?<![\w$])(?<![^.]\.)(?:${owners.join('|')})(?![\w$])(\s*\.\s*([A-Za-z_$][\w$]*)|\s*\[\s*(?:"([^"\n]+)"|'([^'\n]+)')\s*\])?`,
    'g',
  );
  let reads = 0;
  for (const match of template.matchAll(mention)) {
    reads++;
    if (reads > READS_MAX) {
      break;
    }
    const name = match[2] ?? match[3] ?? match[4];
    if (name === undefined) {
      escapes = true;
    } else {
      pushBounded(direct, name);
    }
  }
  return { direct, escapes };
}

/**
 * The literals renamed props fall back to, by the name declared:
 * `const alt = altProp ?? ""`, `const year = Astro.props.year ?? 2026`. The
 * first such declaration of each name in the frontmatter; read once per file.
 */
export function nullishFallbacks(frontmatter: ts.SourceFile): ReadonlyMap<string, PropDefault> {
  const out = new Map<string, PropDefault>();
  const declarations = syntaxNodes(frontmatter)
    .filter(ts.isVariableDeclaration)
    .sort((first, second) => first.pos - second.pos);
  for (const declaration of declarations) {
    const initializer = declaration.initializer;
    if (!ts.isIdentifier(declaration.name) || (declaration.parent.flags & (ts.NodeFlags.Const | ts.NodeFlags.Let)) === 0 || out.has(declaration.name.text)) {
      continue;
    }
    if (initializer === undefined || !ts.isBinaryExpression(initializer) || initializer.operatorToken.kind !== ts.SyntaxKind.QuestionQuestionToken) {
      continue;
    }
    const value = isNameChain(initializer.left) ? literalValue(initializer.right) : undefined;
    if (value !== undefined) {
      out.set(declaration.name.text, value);
    }
  }
  assert(out.size <= declarations.length, 'nullishFallbacks: one fallback per declaration at most');
  return out;
}

// `altProp`, `props.alt`, `Astro.props.alt`: a name or a chain of member reads.
const CHAIN_DEPTH_MAX = 8;
function isNameChain(node: ts.Expression): boolean {
  let current = node;
  for (let depth = 0; depth < CHAIN_DEPTH_MAX; depth++) {
    if (ts.isIdentifier(current)) {
      return true;
    }
    if (!ts.isPropertyAccessExpression(current)) {
      return false;
    }
    current = current.expression;
  }
  return false;
}
