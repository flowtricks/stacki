// A destructure default may read the props destructured before it, never one
// after: `{ label = variant === "play" ? "Play" : undefined, variant }` throws
// at runtime (the local is not yet initialised). A conditional default the
// panel writes (`Set by conditions`) can read any prop, so when its save leaves
// the default reading a later entry, this moves the prop's own entry to just
// after the last entry it reads, keeping its text and the list's separators.
// Nothing else in the destructure moves; a destructure the move cannot keep
// valid (the entry would pass `...rest`) is left as it is and refused.
import ts from 'typescript';
import { assert } from '../../shared/core/assert';
import { err, ok, type Result } from '../../shared/core/result';
import { refusal } from '../../shared/properties/propertyErrors';
import { applySourceEdits, isAstroProps, propertyKey, readPropertySyntax, replaceFrontmatter, syntaxNodes } from './propertySyntax';

/**
 * The source with `prop`'s destructure entry after every entry its default
 * reads; the same source when it already is. A prop of `props` the default
 * reads but the destructure does not take yet is taken, just before the entry
 * (a condition on `variant` needs a `variant` local).
 */
export function orderDefaultReads(source: string, prop: string, props: readonly string[]): Result<string> {
  const taken = takeDefaultReads(source, prop, props);
  return taken === source ? orderTaken(source, prop) : orderTaken(taken, prop);
}

function takeDefaultReads(source: string, prop: string, props: readonly string[]): string {
  const document = readPropertySyntax(source);
  const pattern = astroPropsPattern(document.syntax);
  const element = pattern?.elements.find((item) => item.dotDotDotToken === undefined && propertyKey(item.propertyName ?? item.name) === prop);
  if (pattern === undefined || element?.initializer === undefined) {
    return source;
  }
  const bound = new Set(
    pattern.elements.flatMap((item) => (ts.isIdentifier(item.name) ? [item.name.text, propertyKey(item.propertyName ?? item.name) ?? ''] : [])),
  );
  const missing = [...readLocals(element.initializer)].filter((name) => props.includes(name) && name !== prop && !bound.has(name));
  if (missing.length === 0) {
    return source;
  }
  assert(missing.length <= props.length, 'takeDefaultReads: the props taken are bounded');
  const at = element.getStart();
  return replaceFrontmatter(document, applySourceEdits(document.frontmatter, [{ start: at, end: at, text: missing.map((name) => `${name}, `).join('') }]));
}

function orderTaken(source: string, prop: string): Result<string> {
  const document = readPropertySyntax(source);
  const pattern = astroPropsPattern(document.syntax);
  if (pattern === undefined) {
    return ok(source);
  }
  const elements = pattern.elements;
  const index = elements.findIndex((element) => element.dotDotDotToken === undefined && propertyKey(element.propertyName ?? element.name) === prop);
  const element = elements[index];
  if (element === undefined || element.initializer === undefined) {
    return ok(source);
  }
  const reads = readLocals(element.initializer);
  const later = elements.flatMap((other, at) => (at > index && ts.isIdentifier(other.name) && reads.has(other.name.text) ? [at] : []));
  const target = later.at(-1);
  if (target === undefined) {
    return ok(source);
  }
  const after = elements[target];
  assert(after !== undefined, 'orderDefaultReads: the last read entry exists');
  if (after.dotDotDotToken !== undefined) {
    return err(refusal('default-order', 'props.rename.defaultOrder'));
  }
  const next = elements[index + 1];
  assert(next !== undefined, 'orderDefaultReads: an entry read later has one after it');
  const frontmatter = document.frontmatter;
  // The entry leaves with the gap up to the next entry, and arrives after the
  // read one with the same gap, so `,\n  ` layouts and `, ` layouts both hold.
  const leave = { start: element.getStart(), end: next.getStart(), text: '' };
  const gap = frontmatter.slice(element.end, next.getStart());
  const arrive = { start: after.end, end: after.end, text: `${gap}${frontmatter.slice(element.getStart(), element.end)}` };
  const written = applySourceEdits(frontmatter, [leave, arrive]);
  const output = replaceFrontmatter(document, written);
  const moved = astroPropsPattern(readPropertySyntax(output).syntax)?.elements.map((item) => item.getText()) ?? [];
  assert(moved.length === elements.length, 'orderDefaultReads: the destructure keeps every entry');
  assert(moved.indexOf(element.getText()) === target, 'orderDefaultReads: the entry sits after the last one it reads');
  return ok(output);
}

function astroPropsPattern(syntax: ts.SourceFile): ts.ObjectBindingPattern | undefined {
  const patterns = syntax.statements
    .filter(ts.isVariableStatement)
    .flatMap((statement) => statement.declarationList.declarations)
    .filter((declaration) => declaration.initializer !== undefined && isAstroProps(declaration.initializer) && ts.isObjectBindingPattern(declaration.name));
  const [only] = patterns;
  return patterns.length === 1 && only !== undefined && ts.isObjectBindingPattern(only.name) ? only.name : undefined;
}

// The plain names an expression reads (`variant`, `pressed`), property names after a dot left out.
function readLocals(expression: ts.Expression): ReadonlySet<string> {
  const names = new Set<string>();
  for (const node of [expression, ...syntaxNodes(expression)]) {
    if (ts.isIdentifier(node) && !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)) {
      names.add(node.text);
    }
  }
  return names;
}
