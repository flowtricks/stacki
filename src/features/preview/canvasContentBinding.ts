import { parser } from '@lezer/javascript';
import type { SyntaxNode } from '@lezer/common';
import type { CanvasSourceNode } from './canvasTextSource';

export interface CanvasContentBinding {
  readonly collection: string;
  readonly entry: string;
  readonly fields: readonly string[];
}

// Only an explicit Astro getEntry import with literal collection and ID proves
// ownership. Never infer a CMS record by matching a rendered title or array index.
export function canvasContentBinding(source: string, node: CanvasSourceNode): CanvasContentBinding | undefined {
  if (node.kind !== 'expr' || node.start === undefined || node.end === undefined) {
    return undefined;
  }
  const expression = source.slice(node.start + 1, node.end - 1).trim();
  if (!/^[A-Za-z_$][\w$]*\.data(?:\.[A-Za-z_$][\w$]*){1,8}$/.test(expression)) {
    return undefined;
  }
  const [name, , ...fields] = expression.split('.');
  const code = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source)?.[1];
  if (!code || code.length > 100_000) {
    return undefined;
  }
  const tree = parser.configure({ dialect: 'ts' }).parse(code);
  let imported = false;
  let invalid = false;
  let definitions = 0;
  let binding: CanvasContentBinding | undefined;
  tree.iterate({
    enter: (entry) => {
      if (entry.type.isError) {
        invalid = true;
      }
      if (entry.name === 'ImportDeclaration') {
        imported ||= /^import\s*\{\s*getEntry\s*\}\s*from\s*['"]astro:content['"];?$/.test(code.slice(entry.from, entry.to).trim());
      }
      if (entry.name === 'VariableDefinition' && code.slice(entry.from, entry.to) === name) {
        definitions++;
        const declaration = entry.node.parent;
        if (declaration?.name === 'VariableDeclaration' && declaration.parent?.name === 'Script') {
          binding = declaredEntry(code, declaration, fields);
        }
      }
    },
  });
  return imported && !invalid && definitions === 1 ? binding : undefined;
}

function declaredEntry(code: string, declaration: SyntaxNode, fields: readonly string[]) {
  if (declaration.firstChild?.name !== 'const') {
    return undefined;
  }
  const call = declaration.getChild('AwaitExpression')?.getChild('CallExpression');
  if (!call || code.slice(call.firstChild?.from, call.firstChild?.to) !== 'getEntry') {
    return undefined;
  }
  const argumentsNode = call.getChild('ArgList');
  const raw = argumentsNode ? code.slice(argumentsNode.from, argumentsNode.to) : '';
  const literal = /^\(\s*(['"])([\w-]+)\1\s*,\s*(['"])([\w/.-]+)\3\s*\)$/.exec(raw);
  const collection = literal?.[2];
  const entry = literal?.[4];
  return collection && entry ? { collection, entry, fields } : undefined;
}
