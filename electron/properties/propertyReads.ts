// Where a component's own code still reads a prop, by line. Deleting a prop
// takes out its declarations and its destructure; a read left behind would
// then name a variable nothing declares, so the deletion is refused and these
// lines are listed instead (docs/component-properties.md, "Deleting a prop").
//
// The scan is syntactic and deliberately conservative: any identifier spelled
// as the prop's local name counts, in the frontmatter and in every template
// expression and attribute, even one a loop variable shadows. A false positive
// costs a look at the listed line; a missed read would ship a broken page.
// Keys (`{ direction: 1 }`, `x.direction`) are not reads. CSS, client scripts,
// markup text and comments are never parsed as code, so `flex-direction` and a
// word in a paragraph do not count.
import { parse } from '@astrojs/compiler/sync';
import type { AttributeNode, Node } from '@astrojs/compiler/types';
import ts from 'typescript';
import { assert } from '../../shared/core/assert';
import { err, ok, type Result } from '../../shared/core/result';
import { PROPERTY_LIMITS } from '../../shared/properties/propertyEditing';
import { isAstroProps, readPropertySyntax, syntaxNodes, type SourceEdit } from './propertySyntax';

/**
 * What counts as a read: the prop's local name, its name on `Astro.props`, and
 * the names that hold the whole props object. Leaving `local` or `name` out
 * scans for the other kind alone: a read of the local can be kept working by a
 * constant, a read through the props object cannot (propertyDefinitions.ts).
 */
export interface PropertyReadTarget {
  readonly local: string | undefined;
  readonly name: string | undefined;
  readonly holders: ReadonlySet<string>;
}

/** Where a scanned source came from: the text before some ranges of it were taken out, so lines are counted as the person last saw them. */
export interface ReadOrigin {
  readonly source: string;
  /** The ranges taken out, in `source`'s offsets. */
  readonly removed: readonly SourceEdit[];
}

/**
 * The 1-based lines that read the prop, in order, once each; a syntax error
 * the template parser reports refuses the scan. With `origin`, the lines are
 * those of the text before the removal, which is the file on disk.
 */
export function propertyReadLines(source: string, target: PropertyReadTarget, origin?: ReadOrigin): Result<readonly number[]> {
  const document = readPropertySyntax(source);
  const offsets: number[] = readsInCode(document.syntax, target).map((position) => document.start + position);
  const template = templateReads(source, target);
  if (!template.ok) {
    return template;
  }
  offsets.push(...template.value);
  const original = origin ?? { source, removed: [] };
  const lines = [...new Set(offsets.map((position) => lineAt(original.source, originalOffset(position, original.removed))))].sort(
    (first, second) => first - second,
  );
  assert(
    lines.every((line) => line >= 1),
    'Read lines are 1-based',
  );
  assert(lines.length <= offsets.length, 'Each line is listed once');
  return ok(lines);
}

// An offset into the text left after `removed` was taken out, as an offset into the text before.
function originalOffset(position: number, removed: readonly SourceEdit[]): number {
  let offset = position;
  for (const edit of [...removed].sort((first, second) => first.start - second.start)) {
    assert(edit.text === '', 'Only removed ranges are mapped back');
    if (offset >= edit.start) {
      offset += edit.end - edit.start;
    }
  }
  return offset;
}

/** The 1-based line holding a UTF-16 offset. */
export function lineAt(source: string, position: number): number {
  assert(position >= 0, 'A line is asked for inside the source');
  assert(position <= source.length, 'A line is asked for inside the source');
  let line = 1;
  for (let index = source.indexOf('\n'); index >= 0 && index < position; index = source.indexOf('\n', index + 1)) {
    line += 1;
  }
  return line;
}

/** The Astro parser's UTF-8 byte offset of a node, as a UTF-16 offset into `source`. */
export function astroOffset(source: string, node: { readonly position?: Node['position'] }): number {
  const position = node.position?.start.offset;
  assert(position !== undefined, 'Astro parser supplies requested source positions');
  assert(position <= Buffer.byteLength(source), 'Astro source position is in bounds');
  return Buffer.from(source).subarray(0, position).toString('utf8').length;
}

/** The template's syntax tree, or the parser's first error. */
export function parseAstroTemplate(source: string): Result<Node> {
  try {
    const result = parse(source, { position: true });
    const diagnostic = result.diagnostics.find((entry) => entry.severity === 1);
    return diagnostic ? err({ code: 'syntax', message: diagnostic.text }) : ok(result.ast);
  } catch (error: unknown) {
    return err({ code: 'syntax', message: String(error) });
  }
}

// Offsets, into `code`, of every read in a piece of TypeScript.
function readsInCode(syntax: ts.Node, target: PropertyReadTarget): readonly number[] {
  const offsets: number[] = [];
  for (const node of syntaxNodes(syntax)) {
    if (ts.isIdentifier(node) && node.text === target.local && identifierReads(node)) {
      offsets.push(node.getStart());
    } else if (ts.isPropertyAccessExpression(node) && node.name.text === target.name && holdsProps(node.expression, target)) {
      offsets.push(node.getStart());
    } else if (target.name !== undefined && ts.isElementAccessExpression(node) && holdsProps(node.expression, target)) {
      const key = node.argumentExpression;
      // A computed key may be any prop, this one included.
      if (!ts.isStringLiteralLike(key) || key.text === target.name) {
        offsets.push(node.getStart());
      }
    }
  }
  return offsets;
}

function holdsProps(expression: ts.Expression, target: PropertyReadTarget): boolean {
  if (isAstroProps(expression)) {
    return true;
  }
  return ts.isIdentifier(expression) && target.holders.has(expression.text);
}

// An identifier is a read unless it is a key or a member name in some other object.
function identifierReads(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (ts.isPropertyAccessExpression(parent)) {
    return parent.expression === node;
  }
  if (ts.isQualifiedName(parent)) {
    return parent.left === node;
  }
  if (ts.isPropertyAssignment(parent) || ts.isPropertySignature(parent) || ts.isPropertyDeclaration(parent) || ts.isMethodDeclaration(parent)) {
    return parent.name !== node;
  }
  if (ts.isBindingElement(parent)) {
    return parent.propertyName !== node && parent.name !== node;
  }
  if (ts.isJsxAttribute(parent)) {
    return parent.name !== node;
  }
  return true;
}

// Offsets, into `source`, of every read in the template: expressions and the attributes of elements and components.
function templateReads(source: string, target: PropertyReadTarget): Result<readonly number[]> {
  const root = parseAstroTemplate(source);
  if (!root.ok) {
    return root;
  }
  const offsets: number[] = [];
  const pending: { readonly node: Node; readonly expression: boolean }[] = [{ node: root.value, expression: false }];
  for (let index = 0; index < pending.length; index += 1) {
    assert(pending.length <= PROPERTY_LIMITS.nodesMax, 'Astro read scan node budget');
    const entry = pending[index];
    assert(entry !== undefined, 'Queued Astro node exists');
    const node = entry.node;
    if ('attributes' in node) {
      for (const attribute of node.attributes) {
        offsets.push(...attributeReads(source, attribute, target));
      }
    }
    if (entry.expression && node.type === 'text') {
      offsets.push(...fragmentReads(node.value, astroOffset(source, node), target));
    }
    if ('children' in node) {
      // A client script and a style sheet never see the frontmatter's names.
      if (node.type === 'element' && ['script', 'style'].includes(node.name)) {
        continue;
      }
      for (const child of node.children) {
        pending.push({ node: child, expression: node.type === 'expression' });
      }
    }
  }
  return ok(offsets);
}

function attributeReads(source: string, attribute: AttributeNode, target: PropertyReadTarget): readonly number[] {
  const start = astroOffset(source, attribute);
  switch (attribute.kind) {
    case 'shorthand':
      return attribute.name === target.local ? [start] : [];
    case 'spread':
      return fragmentReads(attribute.name, start, target);
    case 'expression':
    case 'template-literal': {
      const position = source.indexOf(attribute.value, start + attribute.name.length);
      // A value the parser placed where the text does not hold it is read as the whole attribute: listed, never missed.
      if (position < 0) {
        return [start];
      }
      // A template literal's value is written without its backticks; they are put back so it parses as one.
      return attribute.kind === 'template-literal'
        ? fragmentReads(`\`${attribute.value}\``, position - 1, target)
        : fragmentReads(attribute.value, position, target);
    }
    case 'quoted':
    case 'empty':
      return [];
    default: {
      const exhaustive: never = attribute.kind;
      return exhaustive;
    }
  }
}

// A template expression is often a fragment (`{open && (`); TypeScript still finds its identifiers.
function fragmentReads(code: string, start: number, target: PropertyReadTarget): readonly number[] {
  const local = target.local !== undefined && code.includes(target.local);
  const named = target.name !== undefined && code.includes(target.name);
  if (!local && !named) {
    return [];
  }
  const syntax = ts.createSourceFile('fragment.tsx', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  return readsInCode(syntax, target).map((position) => start + position);
}
