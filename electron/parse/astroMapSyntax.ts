// JavaScript owns callback syntax. Keep its statements verbatim and expose only
// JSX roots, so early returns and nested scopes never need to be rewritten.
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
  const body =
    ts.isArrowFunction(callback) || ts.isFunctionExpression(callback) ? callback.body : callback;
  const markup = mapMarkup(body, syntax);
  if (markup === undefined) {
    return undefined;
  }
  if (!mapDiagnosticsAccepted(syntax, markup)) {
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
    return ts.createSourceFile(
      'callback.tsx',
      `(${source})`,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
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
  if (ts.isJsxElement(body) || ts.isJsxSelfClosingElement(body) || ts.isJsxFragment(body)) {
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
  if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node)) {
    return 1;
  }
  if (ts.isConditionalExpression(node)) {
    return (
      conditionalMarkupCount(node.whenTrue, depth + 1) +
      conditionalMarkupCount(node.whenFalse, depth + 1)
    );
  }
  if (ts.isBinaryExpression(node)) {
    if (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
      return conditionalMarkupCount(node.right, depth + 1);
    }
  }
  return 0;
}

function mapDiagnosticsAccepted(syntax: ts.SourceFile, markup: MapSyntax['markup']): boolean {
  // Astro allows HTML comments and raw scripts inside JSX. TypeScript only
  // owns the surrounding JavaScript; parseTemplate validates every markup hole.
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
    return markup.some((span) => start - 1 >= span.start && start + length - 1 <= span.end);
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
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node)) {
      roots.push({ start: node.getStart(syntax) - 1, end: node.end - 1 });
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
