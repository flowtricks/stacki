// JavaScript owns callback syntax. Keep its statements verbatim and expose only
// JSX roots, so early returns and nested scopes never need to be rewritten.
//
// Astro is not JSX: a callback may return sibling elements with no wrapper,
// `(<Img /> <img />)`, and the serializer writes exactly that for a loop with
// several children. TypeScript reads such a run as elements chained by a
// zero-width comma and reports "JSX expressions must have one parent element".
// Every reader here accepts that run as markup; refusing it turned a loop the
// editor itself had written into an opaque code block.
import ts from 'typescript';
import { assert } from '../../shared/core/assert';
import { LIMITS } from '../../shared/core/limits';

export interface MapSyntax {
  readonly form: 'markup' | 'conditional' | 'block' | 'general';
  readonly head: string;
  readonly parts: readonly string[];
  readonly markup: readonly { readonly start: number; readonly end: number }[];
}

export function readMapSyntax(source: string): MapSyntax | undefined {
  if (!source.includes('map')) {
    if (!source.includes('flatMap')) {
      return undefined;
    }
  }
  assert(source.length <= LIMITS.ipcFieldCharsMax, 'Map source is bounded by its template');
  const syntax = mapSourceFile(source);
  if (syntax === undefined) {
    return undefined;
  }
  const statement = syntax.statements[0];
  if (!statement || !ts.isExpressionStatement(statement)) {
    return undefined;
  }
  const call = unwrapExpression(statement.expression);
  if (!ts.isCallExpression(call)) {
    return undefined;
  }
  const method = mapAccessName(call.expression);
  if (method !== 'map') {
    if (method !== 'flatMap') {
      return undefined;
    }
  }
  const argument = call.arguments[0];
  if (!argument) {
    return undefined;
  }
  const callback = unwrapExpression(argument);
  const body = ts.isArrowFunction(callback) || ts.isFunctionExpression(callback) ? callback.body : callback;
  const markup = mapMarkup(body, syntax);
  if (markup === undefined) {
    return undefined;
  }
  if (!mapDiagnosticsAccepted(syntax, markup, siblingRunSpans(body, syntax))) {
    return undefined;
  }
  const bodyStart = body.getStart(syntax) - 1;
  assert(bodyStart >= 0, 'Callback body follows the synthetic opening parenthesis');
  if (bodyStart + 1 > LIMITS.attrCharsMax) {
    return undefined;
  }
  const parts: string[] = [];
  let position = bodyStart;
  for (const span of markup) {
    assert(span.start >= position, 'Callback markup roots are ordered and disjoint');
    parts.push(source.slice(position, span.start));
    position = span.end;
  }
  parts.push(source.slice(position) + '}');
  return {
    // Compact readers own map syntax only. Preserve flatMap's callback scopes
    // verbatim, including nested map calls that must not become the outer head.
    form: method === 'map' ? mapForm(callback, markup.length) : 'general',
    head: source.slice(0, bodyStart) + '(',
    parts,
    markup,
  };
}

function mapSourceFile(source: string): ts.SourceFile | undefined {
  // Parser recursion is a resource failure caused by external source. Only
  // that library call is caught; our own assertions must remain loud.
  try {
    return ts.createSourceFile('callback.tsx', `(${source})`, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  } catch (error: unknown) {
    if (error instanceof RangeError) {
      return undefined;
    }
    throw error;
  }
}

function mapForm(callback: ts.Expression, markupCount: number): MapSyntax['form'] {
  if (!ts.isArrowFunction(callback)) {
    return 'general';
  }
  if (ts.isBlock(callback.body)) {
    return 'block';
  }
  const body = unwrapExpression(callback.body);
  if (isMarkup(body)) {
    return 'markup';
  }
  if (markupCount > 0 && conditionalMarkupCount(body, 0) === markupCount) {
    return 'conditional';
  }
  return 'general';
}

function conditionalMarkupCount(expression: ts.Expression, depth: number): number {
  if (depth >= LIMITS.treeDepthMax) {
    return 0;
  }
  const node = unwrapExpression(expression);
  if (isJsxRoot(node)) {
    return 1;
  }
  const run = siblingRun(node);
  if (run !== undefined) {
    return run.length;
  }
  if (ts.isConditionalExpression(node)) {
    return conditionalMarkupCount(node.whenTrue, depth + 1) + conditionalMarkupCount(node.whenFalse, depth + 1);
  }
  if (ts.isBinaryExpression(node)) {
    if (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
      return conditionalMarkupCount(node.right, depth + 1);
    }
  }
  return 0;
}

function mapDiagnosticsAccepted(syntax: ts.SourceFile, markup: MapSyntax['markup'], runs: MapSyntax['markup']): boolean {
  // Astro allows HTML comments, raw scripts and sibling roots inside JSX.
  // TypeScript only owns the surrounding JavaScript; parseTemplate validates
  // every markup hole, so a diagnostic inside one root or one sibling run is
  // Astro syntax TypeScript does not know.
  const holes = [...markup, ...runs];
  const diagnostics: unknown = Reflect.get(syntax, 'parseDiagnostics');
  if (!Array.isArray(diagnostics) || diagnostics.length > LIMITS.treeNodesMax) {
    return false;
  }
  return diagnostics.every((diagnostic: unknown) => {
    if (typeof diagnostic !== 'object' || diagnostic === null) {
      return false;
    }
    const start: unknown = Reflect.get(diagnostic, 'start');
    const length: unknown = Reflect.get(diagnostic, 'length');
    if (typeof start !== 'number' || typeof length !== 'number') {
      return false;
    }
    return holes.some((span) => start - 1 >= span.start && start + length - 1 <= span.end);
  });
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  for (let depth = 0; depth <= LIMITS.treeDepthMax; depth++) {
    if (!ts.isParenthesizedExpression(current)) {
      return current;
    }
    current = current.expression;
  }
  return current;
}

function mapAccessName(expression: ts.Expression): string | undefined {
  if (ts.isPropertyAccessExpression(expression)) {
    return expression.name.text;
  }
  if (ts.isElementAccessExpression(expression)) {
    const name = expression.argumentExpression;
    if (ts.isStringLiteral(name)) {
      return name.text;
    }
  }
  return undefined;
}

function mapMarkup(body: ts.Node, syntax: ts.SourceFile): MapSyntax['markup'] | undefined {
  const pending = [{ node: body, depth: 0 }];
  const roots: Array<{ readonly start: number; readonly end: number }> = [];
  for (let index = 0; index < pending.length; index++) {
    const entry = pending[index];
    assert(entry !== undefined, 'Syntax traversal index is in bounds');
    if (entry.depth > LIMITS.treeDepthMax) {
      return undefined;
    }
    const node = entry.node;
    if (isJsxRoot(node)) {
      roots.push({ start: node.getStart(syntax) - 1, end: node.end - 1 });
    } else if (ts.isExpression(node) && siblingRun(node) !== undefined) {
      // Each sibling is its own root; the whitespace between them becomes a
      // code part, so a general callback writes back exactly as it was read.
      for (const sibling of required(siblingRun(node))) {
        roots.push({ start: sibling.getStart(syntax) - 1, end: sibling.end - 1 });
      }
    } else {
      const overflow = node.forEachChild((child) => {
        if (pending.length === LIMITS.treeNodesMax) {
          return true;
        }
        pending.push({ node: child, depth: entry.depth + 1 });
        return undefined;
      });
      if (overflow) {
        return undefined;
      }
    }
  }
  assert(roots.length <= LIMITS.treeNodesMax, 'Markup roots are bounded by syntax nodes');
  return roots.sort((left, right) => left.start - right.start);
}

type JsxRoot = ts.JsxElement | ts.JsxSelfClosingElement | ts.JsxFragment;

function isJsxRoot(node: ts.Node): node is JsxRoot {
  return ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node);
}

function isMarkup(expression: ts.Expression): boolean {
  if (isJsxRoot(expression)) {
    return true;
  }
  return siblingRun(expression) !== undefined;
}

// The elements of `<a /> <b /> <c />` as TypeScript recovers it: a right-leaning
// chain of comma expressions whose comma token has zero width, because no comma
// was written. A written comma, `(<a />, <b />)`, is a JavaScript sequence and
// is not a run.
function siblingRun(expression: ts.Expression): readonly JsxRoot[] | undefined {
  const siblings: JsxRoot[] = [];
  let current: ts.Expression = expression;
  for (let index = 0; index < LIMITS.treeNodesMax; index++) {
    if (!ts.isBinaryExpression(current)) {
      break;
    }
    if (current.operatorToken.kind !== ts.SyntaxKind.CommaToken) {
      return undefined;
    }
    if (current.operatorToken.pos !== current.operatorToken.end) {
      return undefined;
    }
    if (!isJsxRoot(current.left)) {
      return undefined;
    }
    siblings.push(current.left);
    current = current.right;
  }
  if (siblings.length === 0) {
    return undefined;
  }
  if (!isJsxRoot(current)) {
    return undefined;
  }
  siblings.push(current);
  assert(siblings.length >= 2, 'A sibling run has at least two roots');
  return siblings;
}

function siblingRunSpans(body: ts.Node, syntax: ts.SourceFile): MapSyntax['markup'] {
  const spans: Array<{ readonly start: number; readonly end: number }> = [];
  const pending = [{ node: body, depth: 0 }];
  for (let index = 0; index < pending.length; index++) {
    const entry = pending[index];
    assert(entry !== undefined, 'Sibling-run traversal index is in bounds');
    if (entry.depth > LIMITS.treeDepthMax) {
      continue;
    }
    const run = ts.isExpression(entry.node) ? siblingRun(entry.node) : undefined;
    if (run !== undefined) {
      const first = required(run[0]);
      const last = required(run[run.length - 1]);
      spans.push({ start: first.getStart(syntax) - 1, end: last.end - 1 });
    } else {
      entry.node.forEachChild((child) => {
        if (pending.length < LIMITS.treeNodesMax) {
          pending.push({ node: child, depth: entry.depth + 1 });
        }
      });
    }
  }
  return spans;
}

function required<T>(value: T | undefined): T {
  assert(value !== undefined, 'A sibling run index is in bounds');
  return value;
}
