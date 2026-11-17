// Defaults a component computes from another prop instead of declaring them in
// its destructure: `label ?? named[variant]` with
// `const named = { play: pressed ? "Pause" : "Play", close: "Close" }`, the
// Lumos Button's accessible label. The Properties panel shows such a default
// as conditions on the prop the table is indexed by, and edits it as values in
// that table (shared/properties/variantRules.ts, VariantDefault), so the
// component's own shape and every other byte stay as they were.
//
// Read: each `local ?? table[key]` the frontmatter or the template holds, where
// `local` and `key` are props' destructured locals and `table` is a `const`
// object literal of the frontmatter whose keys are plain names or strings and
// whose values are plain property assignments. Any other `local ?? <code>` is
// a `computed` default, shown read-only. A prop read with two different
// fallbacks keeps only its first table (and its first code).
//
// Write (`setDefaultTable`): an entry whose code is unchanged keeps its bytes,
// a changed one has its value replaced, a missing one goes with its comma, a
// new one is appended in the table's own layout. An entry another line reads
// directly (`named.play`) is never removed.
import ts from 'typescript';
import { assert } from '../../shared/core/assert';
import { err, ok, type Result } from '../../shared/core/result';
import { refusal } from '../../shared/properties/propertyErrors';
import { VARIANT_LIMITS } from '../../shared/properties/variantRules';
import type { VariantDefault, VariantDefaultEntry } from '../../shared/properties/variantRules';
import { applySourceEdits, isAstroProps, propertyKey, readPropertySyntax, replaceFrontmatter, syntaxError, syntaxNodes } from './propertySyntax';
import type { PropertySyntax, SourceEdit } from './propertySyntax';

/** A table as the writer needs it: the object literal, and each entry's node. */
interface TableSyntax {
  readonly object: ts.ObjectLiteralExpression;
  readonly entries: ReadonlyMap<string, ts.PropertyAssignment>;
}

/** The default each prop is computed with, in prop order of first mention. */
export function readVariantDefaults(document: PropertySyntax): readonly VariantDefault[] {
  const locals = destructuredLocals(document.syntax);
  if (locals.size === 0) {
    return [];
  }
  const tables = constTables(document.syntax);
  const defaults: VariantDefault[] = [];
  const seen = new Set<string>();
  for (const mention of fallbackMentions(document)) {
    const prop = locals.get(mention.local);
    if (prop === undefined || defaults.length >= VARIANT_LIMITS.propsMax) {
      continue;
    }
    const table = tableMention(mention.fallback, tables, locals);
    const kind = table === undefined ? 'computed' : 'table';
    if (seen.has(`${kind}:${prop}`)) {
      continue;
    }
    seen.add(`${kind}:${prop}`);
    if (table === undefined) {
      defaults.push({ kind: 'computed', prop, code: mention.fallback.trim() });
    } else {
      defaults.push({ kind: 'table', prop, ...table });
    }
  }
  assert(defaults.length <= VARIANT_LIMITS.propsMax, 'readVariantDefaults: defaults are bounded');
  return defaults;
}

/** The source with the default table of `prop` (keyed by `controller`) holding exactly `entries`. */
export function editVariantDefaultTable(source: string, controller: string, prop: string, entries: readonly VariantDefaultEntry[]): Result<string> {
  const document = readPropertySyntax(source);
  const current = readVariantDefaults(document).find((item) => item.kind === 'table' && item.prop === prop && item.controller === controller);
  if (current === undefined || current.kind !== 'table') {
    return err(refusal('missing', 'componentProps.defaults.missingTable', { name: prop }));
  }
  const table = constTables(document.syntax).get(current.table);
  assert(table !== undefined, 'editVariantDefaultTable: a read table is declared');
  for (const entry of entries) {
    const problem = syntaxError(`const value = (${entry.code});`);
    if (problem !== undefined || entry.code.trim() === '') {
      return err(refusal('default', 'componentProps.defaults.badCode', { value: entry.option }));
    }
  }
  const frontmatter = document.frontmatter;
  const edits: SourceEdit[] = [];
  const wanted = new Map(entries.map((entry) => [entry.option, entry.code.trim()]));
  for (const [option, assignment] of table.entries) {
    const code = wanted.get(option);
    if (code === undefined) {
      if (readsEntryDirectly(document, current.table, option)) {
        return err(refusal('in-use', 'componentProps.defaults.entryRead', { value: option, name: current.table }));
      }
      edits.push(entryRemoval(frontmatter, table.object, assignment));
    } else if (code !== assignment.initializer.getText().trim()) {
      edits.push({ start: assignment.initializer.getStart(), end: assignment.initializer.end, text: code });
    }
  }
  const added = entries.filter((entry) => !table.entries.has(entry.option));
  if (added.length > 0) {
    edits.push(entriesInsert(frontmatter, table.object, added));
  }
  if (edits.length === 0) {
    return ok(source);
  }
  const written = applySourceEdits(frontmatter, edits);
  const error = syntaxError(written);
  if (error !== undefined) {
    return err({ code: 'syntax', message: error });
  }
  const output = replaceFrontmatter(document, written);
  verifyTable(output, controller, prop, entries);
  return ok(output);
}

// --- Reading ---

interface FallbackMention {
  readonly local: string;
  readonly fallback: string;
}

// `local` to the prop it holds, for every destructure of `Astro.props`.
function destructuredLocals(syntax: ts.SourceFile): ReadonlyMap<string, string> {
  const locals = new Map<string, string>();
  for (const node of syntaxNodes(syntax)) {
    if (!ts.isVariableDeclaration(node) || node.initializer === undefined || !ts.isObjectBindingPattern(node.name)) {
      continue;
    }
    if (!isAstroProps(node.initializer)) {
      continue;
    }
    for (const element of node.name.elements) {
      const key = propertyKey(element.propertyName ?? element.name);
      if (element.dotDotDotToken === undefined && key !== undefined && ts.isIdentifier(element.name)) {
        locals.set(element.name.text, key);
      }
    }
  }
  return locals;
}

// Top-level `const name = { … }` whose every entry is `key: value` with a plain key.
function constTables(syntax: ts.SourceFile): ReadonlyMap<string, TableSyntax> {
  const tables = new Map<string, TableSyntax>();
  for (const statement of syntax.statements) {
    if (!ts.isVariableStatement(statement) || (statement.declarationList.flags & ts.NodeFlags.Const) === 0) {
      continue;
    }
    for (const declaration of statement.declarationList.declarations) {
      const object = declaration.initializer;
      if (!ts.isIdentifier(declaration.name) || object === undefined || !ts.isObjectLiteralExpression(object) || declaration.type !== undefined) {
        continue;
      }
      const entries = new Map<string, ts.PropertyAssignment>();
      const plain = object.properties.every((property) => {
        if (!ts.isPropertyAssignment(property)) {
          return false;
        }
        const key = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ? property.name.text : undefined;
        if (key === undefined || entries.has(key)) {
          return false;
        }
        entries.set(key, property);
        return true;
      });
      if (plain && entries.size <= VARIANT_LIMITS.optionsMax) {
        tables.set(declaration.name.text, { object, entries });
      }
    }
  }
  return tables;
}

// Every `local ?? fallback` with a plain local on the left: in the frontmatter's
// code (types left out), then in the template with `<style>` and `<script>` blanked.
function fallbackMentions(document: PropertySyntax): readonly FallbackMention[] {
  const mentions: FallbackMention[] = [];
  for (const node of syntaxNodes(document.syntax)) {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken && ts.isIdentifier(node.left)) {
      mentions.push({ local: node.left.text, fallback: node.right.getText() });
    }
  }
  const template = document.source.slice(document.end).replace(/<(style|script)\b[\s\S]*?<\/\1\s*>/gi, (block) => ' '.repeat(block.length));
  for (const expression of templateExpressions(template)) {
    const file = ts.createSourceFile('template.ts', `(${expression});`, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    for (const node of syntaxNodes(file)) {
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken && ts.isIdentifier(node.left)) {
        mentions.push({ local: node.left.text, fallback: node.right.getText() });
      }
    }
  }
  assert(mentions.length <= document.source.length, 'fallbackMentions: mentions are bounded by the source');
  return mentions;
}

// The `{…}` expressions of a template, balanced by braces and skipping strings,
// that hold a `??`: the only ones a fallback can be in.
function templateExpressions(template: string): readonly string[] {
  const found: string[] = [];
  let depth = 0;
  let start = -1;
  let quote = '';
  for (let index = 0; index < template.length; index += 1) {
    const char = template[index];
    if (quote !== '') {
      if (char === '\\') {
        index += 1;
      } else if (char === quote) {
        quote = '';
      }
      continue;
    }
    if (depth > 0 && (char === '"' || char === "'" || char === '`')) {
      quote = char;
    } else if (char === '{') {
      if (depth === 0) {
        start = index + 1;
      }
      depth += 1;
    } else if (char === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0) {
        const expression = template.slice(start, index);
        if (expression.includes('??')) {
          found.push(expression);
        }
      }
    }
  }
  return found;
}

// `table[key]`: a table the frontmatter declares, indexed by a prop's local.
function tableMention(
  fallback: string,
  tables: ReadonlyMap<string, TableSyntax>,
  locals: ReadonlyMap<string, string>,
): Omit<Extract<VariantDefault, { readonly kind: 'table' }>, 'kind' | 'prop'> | undefined {
  const match = /^\s*\(?\s*([A-Za-z_$][\w$]*)\s*\[\s*([A-Za-z_$][\w$]*)\s*\]\s*\)?\s*$/.exec(fallback);
  const name = match?.[1];
  const key = match?.[2];
  if (name === undefined || key === undefined) {
    return undefined;
  }
  const table = tables.get(name);
  const controller = locals.get(key);
  if (table === undefined || controller === undefined) {
    return undefined;
  }
  const entries = [...table.entries].map(([option, assignment]) => ({ option, code: assignment.initializer.getText().trim() }));
  const valid = entries.every((entry) => entry.option.trim() === entry.option && entry.option !== '' && !/["'`\\\u0000-\u001f]/.test(entry.option));
  return valid ? { controller, key, table: name, entries } : undefined;
}

// `named.play`, `named["play"]` anywhere but the table itself: removing that entry would break it.
function readsEntryDirectly(document: PropertySyntax, table: string, option: string): boolean {
  const name = table.replace(/[$]/g, '\\$&');
  const key = option.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(?<![\\w$.])${name}\\s*(?:\\?\\.|\\.)\\s*${key}(?![\\w$])|(?<![\\w$.])${name}\\s*\\[\\s*(["'])${key}\\1\\s*\\]`);
  return pattern.test(document.source);
}

// --- Writing ---

// An entry and one separator: the comma after it, else the one before it.
function entryRemoval(frontmatter: string, object: ts.ObjectLiteralExpression, assignment: ts.PropertyAssignment): SourceEdit {
  const index = object.properties.indexOf(assignment);
  assert(index >= 0, 'entryRemoval: the entry is in its table');
  const next = object.properties[index + 1];
  const previous = object.properties[index - 1];
  if (next !== undefined) {
    return {
      start: lineStartOrToken(frontmatter, assignment.getFullStart(), assignment.getStart()),
      end: lineStartOrToken(frontmatter, next.getFullStart(), next.getStart()),
      text: '',
    };
  }
  if (previous !== undefined) {
    // The last entry: from the end of the one before, keeping a trailing comma if the table had one.
    const trailing = frontmatter
      .slice(assignment.end, object.end - 1)
      .trimStart()
      .startsWith(',');
    return { start: previous.end, end: assignment.end + (trailing ? frontmatter.slice(assignment.end).indexOf(',') + 1 : 0), text: trailing ? ',' : '' };
  }
  return { start: object.getStart() + 1, end: object.end - 1, text: '' };
}

// Where an entry's own text begins for removal: its line's start when it opens its line, else its first token.
function lineStartOrToken(text: string, fullStart: number, tokenStart: number): number {
  const lineStart = text.lastIndexOf('\n', tokenStart - 1) + 1;
  return lineStart > fullStart && text.slice(lineStart, tokenStart).trim() === '' ? lineStart : tokenStart;
}

// New entries after the last, on their own lines at its indent when the table is
// written over lines, else on the same line; with its separator.
function entriesInsert(frontmatter: string, object: ts.ObjectLiteralExpression, added: readonly VariantDefaultEntry[]): SourceEdit {
  const texts = added.map((entry) => `${entryKey(entry.option)}: ${entry.code.trim()}`);
  const last = object.properties.at(-1);
  if (last === undefined) {
    return { start: object.getStart() + 1, end: object.end - 1, text: ` ${texts.join(', ')} ` };
  }
  const multiline = frontmatter.slice(object.getStart(), object.end).includes('\n');
  const after = frontmatter.slice(last.end, object.end - 1);
  const trailing = after.trimStart().startsWith(',');
  if (multiline) {
    const lineStart = frontmatter.lastIndexOf('\n', last.getStart() - 1) + 1;
    const indent = /^[ \t]*/.exec(frontmatter.slice(lineStart, last.getStart()))?.[0] ?? '';
    const insertAt = trailing ? last.end + after.indexOf(',') + 1 : last.end;
    const body = texts.map((text) => `\n${indent}${text},`).join('');
    return { start: insertAt, end: insertAt, text: trailing ? body : `,${body.slice(0, -1)}` };
  }
  return { start: last.end, end: last.end, text: `, ${texts.join(', ')}` };
}

function entryKey(option: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(option) ? option : JSON.stringify(option);
}

function verifyTable(output: string, controller: string, prop: string, entries: readonly VariantDefaultEntry[]): void {
  const read = readVariantDefaults(readPropertySyntax(output)).find((item) => item.kind === 'table' && item.prop === prop && item.controller === controller);
  assert(read !== undefined, 'verifyTable: the table reads back');
  assert(read.kind === 'table', 'verifyTable: the table reads back as a table');
  const written = new Map(read.entries.map((entry) => [entry.option, entry.code]));
  assert(written.size === entries.length, 'verifyTable: one entry per option asked for');
  for (const entry of entries) {
    assert(written.get(entry.option) === entry.code.trim(), 'verifyTable: each entry reads back as written');
  }
}
