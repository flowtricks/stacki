import type { NumericStyleBinding } from './numericStyleProtocol';
import ts from 'typescript';
import { frontmatterRange } from '../source/frontmatter';
import { flatten, parsePage } from '../source/source';
import { pathFor } from '../project/previewSelection';

const STYLE = /^([A-Za-z_$][\w$]*)\s*\?\s*`(--[\w-]+):\s*\$\{\1\}(ch|px|rem|em|%|vw|vh);\s*`\s*:\s*undefined$/;

// Recognize only a direct numeric prop -> CSS variable binding. Props used for
// HTML, computed expressions, aliases or default values stay server-rendered.
export function numericStyleBindings(source: string): readonly NumericStyleBinding[] {
  // Every supported binding contains this literal template prefix. Most
  // components have none; avoid parsing their entire page tree on each scan.
  if (!source.includes('`--')) {
    return [];
  }
  const frontmatter = frontmatterRange(source);
  if (!frontmatter) {
    return [];
  }
  const parsed = parsePage(source);
  if (!parsed.editable) {
    return [];
  }
  const syntax = ts.createSourceFile('component.ts', frontmatter.value, ts.ScriptTarget.Latest);
  const template = source.slice(frontmatter.end).replace(/<(style|script)\b[^>]*>[\s\S]*?<\/\1>/g, '');
  return flatten(parsed.model.nodes)
    .flatMap((node) => {
      const style = node.props?.['style'];
      const match = style?.type === 'expr' ? STYLE.exec(style.value.trim()) : null;
      const [, prop, variable, unit] = match ?? [];
      if (!prop || !variable || !unit || !node.id || !directProp(syntax, prop) || template.match(new RegExp(`\\b${prop}\\b`, 'g'))?.length !== 2) {
        return [];
      }
      return [{ prop, variable, unit, marker: pathFor(node.id) }];
    })
    .slice(0, 20);
}
function directProp(syntax: ts.SourceFile, prop: string): boolean {
  let identifiers = 0;
  let propsAccesses = 0;
  let bound = false;
  const visit = (node: ts.Node) => {
    if (
      ((ts.isPropertyAccessExpression(node) && node.name.text === 'props') ||
        (ts.isElementAccessExpression(node) && (!ts.isStringLiteral(node.argumentExpression) || node.argumentExpression.text === 'props'))) &&
      node.expression.getText(syntax) === 'Astro'
    ) {
      propsAccesses++;
    }
    if (ts.isIdentifier(node) && node.text === prop) {
      identifiers++;
    }
    if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer?.getText(syntax) === 'Astro.props') {
      bound ||= node.name.elements.some((item) => !item.propertyName && !item.initializer && ts.isIdentifier(item.name) && item.name.text === prop);
    }
    ts.forEachChild(node, visit);
  };
  visit(syntax);
  return bound && identifiers === 2 && propsAccesses === 1;
}
