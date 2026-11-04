// TypeScript owns syntax; source-range edits retain code outside the edited declaration.
import ts from 'typescript';
import { assert } from '../../shared/core/assert';
import { PROPERTY_LIMITS } from '../../shared/properties/propertyEditing';
import { err, ok, type Result } from '../../shared/core/result';
import { isAstroProps, syntaxNodes } from '../parse/astroSyntax';

export interface SourceEdit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}
export interface PropertySyntax {
  readonly source: string;
  readonly start: number;
  readonly end: number;
  readonly frontmatter: string;
  readonly syntax: ts.SourceFile;
}

export function readPropertySyntax(source: string): PropertySyntax {
  assert(source.length <= PROPERTY_LIMITS.sourceCharsMax, 'Component source is bounded');
  const match = /^(?:\uFEFF)?---[^\S\r\n]*\r?\n([\s\S]*?)^---[^\S\r\n]*(?:\r?\n|$)/m.exec(source);
  const found = match?.index === 0 ? match : undefined;
  const frontmatter = found?.[1] ?? '';
  const start = found ? found[0].indexOf('\n') + 1 : 0;
  assert(start >= 0, 'Frontmatter starts inside source');
  return {
    source,
    start,
    end: start + frontmatter.length,
    frontmatter,
    syntax: ts.createSourceFile('component.ts', frontmatter, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS),
  };
}

export function replaceFrontmatter(document: PropertySyntax, frontmatter: string): string {
  assert(document.end <= document.source.length, 'Frontmatter ends inside source');
  assert(frontmatter.length <= PROPERTY_LIMITS.sourceCharsMax, 'New frontmatter is bounded');
  if (document.start === 0) {
    return `---\n${frontmatter}\n---\n${document.source}`;
  }
  return document.source.slice(0, document.start) + frontmatter + document.source.slice(document.end);
}

export function applySourceEdits(source: string, edits: readonly SourceEdit[]): string {
  assert(edits.length <= PROPERTY_LIMITS.nodesMax, 'Source edits are bounded');
  // The owning edit pass mutates only its local output; callers retain their original source.
  let output = source;
  let boundary = source.length;
  for (const edit of [...edits].sort((first, second) => second.start - first.start)) {
    assert(edit.start >= 0, 'Source edit starts inside source');
    assert(edit.end >= edit.start, 'Source edit has a positive range');
    assert(edit.end <= boundary, 'Source edits never overlap');
    output = output.slice(0, edit.start) + edit.text + output.slice(edit.end);
    boundary = edit.start;
  }
  return output;
}

export function syntaxError(source: string): string | undefined {
  const result = ts.transpileModule(source, {
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      isolatedModules: true,
      jsx: ts.JsxEmit.Preserve,
    },
  });
  const diagnostic = result.diagnostics?.find((item) => item.category === ts.DiagnosticCategory.Error);
  return diagnostic ? ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n') : undefined;
}

export function validatePropertyCode(type: string, expression: string): Result<void> {
  if (!type.trim()) {
    return err({ code: 'type', message: 'Enter a TypeScript type.' });
  }
  const typeSource = `type PropertyType = ${type};`;
  const typeFile = ts.createSourceFile('type.ts', typeSource, ts.ScriptTarget.Latest, true);
  const declaration = typeFile.statements[0];
  if (typeFile.statements.length !== 1 || !declaration || !ts.isTypeAliasDeclaration(declaration)) {
    return err({ code: 'type', message: 'Enter one TypeScript type, without declarations.' });
  }
  const typeError = syntaxError(typeSource);
  if (typeError) {
    return err({ code: 'type', message: typeError });
  }
  if (expression.trim()) {
    const expressionSource = `const value = (${expression});`;
    const expressionFile = ts.createSourceFile('default.ts', expressionSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    if (expressionFile.statements.length !== 1) {
      return err({
        code: 'default',
        message: 'Enter one default expression, without declarations.',
      });
    }
    const expressionError = syntaxError(expressionSource);
    if (expressionError) {
      return err({ code: 'default', message: expressionError });
    }
  }
  return ok(undefined);
}

// The syntax walk and the `Astro.props` test live with the parsers, which read props too.
export { isAstroProps, syntaxNodes };
export function propertyKey(node: ts.PropertyName | ts.BindingName | undefined): string | undefined {
  if (!node) {
    return undefined;
  }
  if (ts.isIdentifier(node) || ts.isStringLiteral(node)) {
    return node.text;
  }
  return undefined;
}

export function defaultExpression(source: string): string {
  const syntax = ts.createSourceFile('default.ts', `const value = (${source});`, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const comma = syntaxNodes(syntax).some((node) => ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.CommaToken);
  return comma ? `(${source})` : source;
}
