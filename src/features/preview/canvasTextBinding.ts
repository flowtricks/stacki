// Resolve only statically owned string literals. Never evaluate project JavaScript
// or replace an expression with its rendered result: that would sever its binding.
import { parser } from '@lezer/javascript';
import type { SyntaxNode } from '@lezer/common';
import type { CanvasSourceNode } from './canvasTextSource';

interface StringBinding {
  readonly start: number;
  readonly end: number;
  readonly value: string;
}
const typescript = parser.configure({ dialect: 'ts' });

export function canvasTextBinding(source: string, node: CanvasSourceNode): StringBinding | undefined {
  if (node.start === undefined || node.end === undefined) {
    return undefined;
  }
  const expression = source.slice(node.start + 1, node.end - 1).trim();
  const direct = readString(expression, node.start + 1 + source.slice(node.start + 1, node.end - 1).indexOf(expression));
  if (direct) {
    return direct;
  }
  if (!/^[A-Za-z_$][\w$]*$/.test(expression)) {
    return undefined;
  }
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source);
  const code = frontmatter?.[1];
  if (!code || code.length > 100_000) {
    return undefined;
  }
  const offset = source.indexOf(code);
  const tree = typescript.parse(code);
  let definitions = 0;
  let invalid = false;
  let result: StringBinding | undefined;
  tree.iterate({
    enter: (entry) => {
      if (entry.type.isError) {
        invalid = true;
      }
      if (entry.name === 'VariableDefinition' && code.slice(entry.from, entry.to) === expression) {
        definitions++;
        const declaration = entry.node.parent;
        if (declaration?.name === 'VariableDeclaration') {
          result = declarationString(code, declaration, offset);
        }
      }
    },
  });
  return definitions === 1 && !invalid ? result : undefined;
}

function declarationString(code: string, declaration: SyntaxNode, offset: number) {
  if (declaration.firstChild?.name !== 'const' || declaration.parent?.name !== 'Script') {
    return undefined;
  }
  const children = declaration.getChildren('String');
  if (children.length !== 1 || declaration.getChildren('VariableDefinition').length !== 1) {
    return undefined;
  }
  const literal = children[0];
  if (!literal || literal.prevSibling?.name !== 'Equals') {
    return undefined;
  }
  return readString(code.slice(literal.from, literal.to), offset + literal.from);
}

function readString(raw: string, start: number): StringBinding | undefined {
  // JSON strings cover escaped double quotes; simple single quotes need no evaluation.
  if (/^"(?:[^"\\\r\n]|\\.)*"$/.test(raw)) {
    try {
      const value: unknown = JSON.parse(raw);
      return typeof value === 'string' ? { start, end: start + raw.length, value } : undefined;
    } catch {
      return undefined;
    }
  }
  if (/^'[^'\\\r\n]*'$/.test(raw)) {
    return { start, end: start + raw.length, value: raw.slice(1, -1) };
  }
  return undefined;
}
