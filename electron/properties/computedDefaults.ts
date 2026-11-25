// The defaults a component computes from its other props, as an instance panel
// needs them to show what an unset prop will be for one instance's values
// (shared/properties/propSchema.ts ComputedDefault, weighed in
// src/features/props/propRules.ts). Two shapes say such a default:
//
// - A destructure default that is code reading other props:
//   `label = variant === "play" ? "Play" : "Close"`. It runs before anything
//   else reads the local, so it wins.
// - A fallback where the prop is read: `label ?? named[variant]` with
//   `const named = { play: pressed ? "Pause" : "Play", close: "Close" }`, or
//   any other `label ?? <code>` (read by variantDefaults.ts readVariantDefaults).
//
// Only code that reads a prop's local or a lookup table is a computed default:
// a literal is the schema's plain default, and a bare name (`SITE_TITLE`) is
// followed to its literal by propDefaults.ts. The code travels as written; the
// renderer reads it with the same reader the Value conditions use, and code it
// cannot read gives no placeholder rather than a wrong one.

import ts from 'typescript';
import { assert } from '../../shared/core/assert';
import { LIMITS } from '../../shared/core/limits';
import type { ComputedDefault } from '../../shared/properties/propSchema';
import type { SchemaField } from '../parse/astroParserTypes';
import { isAstroProps, propertyKey, readPropertySyntax, syntaxNodes } from './propertySyntax';
import type { PropertySyntax } from './propertySyntax';
import { constTables, destructuredLocals, readVariantDefaults, type TableSyntax } from './variantDefaults';

/** Each prop's computed default, by prop name; a prop with a literal default or none is absent. */
export function computedDefaultsOf(source: string): ReadonlyMap<string, ComputedDefault> {
  const document = readPropertySyntax(source);
  const locals = destructuredLocals(document.syntax);
  if (locals.size === 0) {
    return new Map();
  }
  const tables = constTables(document.syntax);
  const found = new Map<string, ComputedDefault>();
  for (const [prop, code] of destructureDefaults(document.syntax)) {
    const computed = computedDefault(code, locals, tables);
    if (computed !== undefined) {
      found.set(prop, computed);
    }
  }
  for (const [prop, code] of fallbackDefaults(document)) {
    if (found.has(prop)) {
      continue;
    }
    const computed = computedDefault(code, locals, tables);
    if (computed !== undefined) {
      found.set(prop, computed);
    }
  }
  assert(found.size <= locals.size, 'computedDefaultsOf: at most one default per destructured prop');
  return found;
}

/**
 * The schema with each computed default beside its field (computedDefaults.ts):
 * a field whose default is a literal keeps it as it is, since that is what runs;
 * an expression default reading other props, or none with a `??` fallback, gains the code.
 */
export function withComputedDefaults(schema: readonly SchemaField[], source: string): SchemaField[] {
  const computed = computedDefaultsOf(source);
  const fields = schema.map((field): SchemaField => {
    const found = computed.get(field.name);
    if (found === undefined) {
      return field;
    }
    if (field.default !== undefined && field.defaultExpr !== true) {
      return field;
    }
    return { ...field, computedDefault: found };
  });
  assert(fields.length === schema.length, 'withComputedDefaults: one field per field');
  return fields;
}

// `prop = <code>` in a destructure of `Astro.props`, for every default that is not a literal.
function destructureDefaults(syntax: ts.SourceFile): ReadonlyMap<string, string> {
  const defaults = new Map<string, string>();
  for (const node of syntaxNodes(syntax)) {
    if (!ts.isVariableDeclaration(node) || node.initializer === undefined || !ts.isObjectBindingPattern(node.name)) {
      continue;
    }
    if (!isAstroProps(node.initializer)) {
      continue;
    }
    for (const element of node.name.elements) {
      const prop = propertyKey(element.propertyName ?? element.name);
      if (prop === undefined || element.initializer === undefined || isLiteral(element.initializer)) {
        continue;
      }
      if (!defaults.has(prop)) {
        defaults.set(prop, element.initializer.getText().trim());
      }
    }
  }
  return defaults;
}

// The fallback each prop is read with: its lookup table when it has one, else its first other fallback.
function fallbackDefaults(document: PropertySyntax): ReadonlyMap<string, string> {
  const defaults = new Map<string, string>();
  const read = readVariantDefaults(document);
  for (const item of read) {
    if (item.kind === 'table' && !defaults.has(item.prop)) {
      defaults.set(item.prop, `${item.table}[${item.key}]`);
    }
  }
  for (const item of read) {
    if (item.kind === 'computed' && !defaults.has(item.prop)) {
      defaults.set(item.prop, item.code);
    }
  }
  assert(defaults.size <= read.length, 'fallbackDefaults: one default per prop read');
  return defaults;
}

// The default `code` is, when it reads a prop's local or a table: with every
// local's prop, and the tables it reaches (through the entries of the tables
// it indexes, as far as there are tables).
function computedDefault(code: string, locals: ReadonlyMap<string, string>, tables: ReadonlyMap<string, TableSyntax>): ComputedDefault | undefined {
  assert(code.length <= LIMITS.attrCharsMax, 'computedDefault: the code is bounded');
  const names = namesIn(code);
  if (names === undefined) {
    return undefined;
  }
  const reached = new Map<string, Readonly<Record<string, string>>>();
  const pending = [...names].filter((name) => tables.has(name));
  for (let index = 0; index < pending.length && index < tables.size; index++) {
    const name = pending[index];
    const table = name === undefined ? undefined : tables.get(name);
    if (name === undefined || table === undefined || reached.has(name)) {
      continue;
    }
    const entries: Record<string, string> = {};
    for (const [option, assignment] of table.entries) {
      const entry = assignment.initializer.getText().trim();
      entries[option] = entry;
      for (const inner of namesIn(entry) ?? []) {
        if (tables.has(inner) && !reached.has(inner)) {
          pending.push(inner);
        }
      }
    }
    reached.set(name, entries);
  }
  const readsProp = [...names].some((name) => locals.has(name));
  if (!readsProp && reached.size === 0) {
    return undefined;
  }
  assert(reached.size <= tables.size, 'computedDefault: only declared tables are reached');
  return { code, locals: Object.fromEntries(locals), tables: Object.fromEntries(reached) };
}

// The names an expression reads: identifiers, but not a member's name (`a.b`'s b) or an object key.
function namesIn(code: string): ReadonlySet<string> | undefined {
  const file = ts.createSourceFile('default.ts', `(${code});`, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const statement = file.statements[0];
  if (file.statements.length !== 1 || statement === undefined || !ts.isExpressionStatement(statement)) {
    return undefined;
  }
  const names = new Set<string>();
  for (const node of syntaxNodes(statement)) {
    if (!ts.isIdentifier(node)) {
      continue;
    }
    const parent = node.parent;
    if (ts.isPropertyAccessExpression(parent) && parent.name === node) {
      continue;
    }
    if (ts.isPropertyAssignment(parent) && parent.name === node) {
      continue;
    }
    names.add(node.text);
  }
  return names;
}

// A default the schema already states as a value: words, a number, a switch.
function isLiteral(node: ts.Expression): boolean {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isNumericLiteral(node)) {
    return true;
  }
  if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword) {
    return true;
  }
  return ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(node.operand);
}
