// Registering EmDash in an Astro config, the way EmDash's existing-project guide shows it: the Node adapter, React and
// `emdash()` in `integrations`, `output: "server"`, and the imports they need. The edit is a set of small insertions at
// positions the TypeScript parser reports, so every byte of the user's own code, comments and formatting stays as it was;
// nothing is reprinted. A config this cannot read with certainty is left untouched and said so (`unusualShape`), and a config
// that already has a different adapter is never changed (`otherAdapter`): the person decides which adapter serves the site.
// The result is parsed again and must still hold each expected piece exactly once before anything is written.

import ts from 'typescript';
import { assert } from '../../shared/core/assert';

export type EmDashConfigResult =
  | { readonly kind: 'merged'; readonly text: string; /** `output` was static or unset: the site now renders on request. */ readonly onDemand: boolean }
  | { readonly kind: 'unchanged' }
  | { readonly kind: 'otherAdapter' }
  | { readonly kind: 'unusualShape' };

const EMDASH_DATABASE = 'sqlite({ url: "file:./data.db" })';
const EMDASH_STORAGE = 'local({ directory: "./uploads", baseUrl: "/_emdash/api/media/file" })';
/** A config is a few kilobytes; one larger than this is not an Astro config Stacki should rewrite. */
const CONFIG_CHARS_MAX = 512 * 1024;

/** The complete config for a project that has none: the guide's own example. */
export function newEmDashConfig(): string {
  return [
    'import node from "@astrojs/node";',
    'import react from "@astrojs/react";',
    'import { defineConfig } from "astro/config";',
    'import emdash, { local } from "emdash/astro";',
    'import { sqlite } from "emdash/db";',
    '',
    'export default defineConfig({',
    '  output: "server",',
    '  adapter: node({ mode: "standalone" }),',
    '  integrations: [',
    '    react(),',
    '    emdash({',
    `      database: ${EMDASH_DATABASE},`,
    `      storage: ${EMDASH_STORAGE},`,
    '    }),',
    '  ],',
    '});',
    '',
  ].join('\n');
}

/** Replace `source[start, end)` with `text`; an insertion has start equal to end. */
interface Edit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

interface Bindings {
  readonly node: string;
  readonly react: string;
  readonly emdash: string;
}

/** Merges EmDash into `source`. Total: every input is one of the four results; none throws for a config it cannot read. */
export function mergeEmDashConfig(source: string): EmDashConfigResult {
  assert(source.length <= CONFIG_CHARS_MAX, 'The Astro config is a size Stacki edits');
  const file = ts.createSourceFile('astro.config.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  if (syntaxErrors(source).length > 0) {
    return { kind: 'unusualShape' };
  }
  const options = defaultExportObject(file);
  if (options === undefined) {
    return { kind: 'unusualShape' };
  }
  const imports = planImports(file);
  if (imports === undefined) {
    return { kind: 'unusualShape' };
  }
  const edits: Edit[] = [...imports.edits];
  const quote = quoteOf(file);
  const output = planOutput(options, quote);
  const adapter = planAdapter(options, file, imports.bindings);
  if (output === 'unusual' || adapter === 'unusual') {
    return { kind: 'unusualShape' };
  }
  if (adapter === 'other') {
    return { kind: 'otherAdapter' };
  }
  const integrations = planIntegrations(source, options, imports.bindings);
  if (integrations === 'unusual') {
    return { kind: 'unusualShape' };
  }
  const indent = indentOf(source, options);
  const added: string[] = [];
  if (output.kind === 'add') {
    added.push(`output: ${quote}server${quote}`);
  }
  if (output.kind === 'replace') {
    edits.push(output.edit);
  }
  if (adapter.kind === 'add') {
    added.push(`adapter: ${imports.bindings.node}({ mode: ${quote}standalone${quote} })`);
  }
  if (integrations.kind === 'add') {
    const entries = integrationLines(imports.bindings, { react: true, emdash: true }, `,\n${indent}${indent}`);
    added.push(`integrations: [\n${indent}${indent}${entries}\n${indent}]`);
  }
  if (integrations.kind === 'append') {
    const entries = integrationLines(imports.bindings, { react: integrations.needsReact, emdash: integrations.needsEmDash }, integrations.separator);
    edits.push({ start: integrations.at, end: integrations.at, text: `${integrations.leading}${entries}` });
  }
  if (added.length > 0) {
    edits.push(
      propertyInsertion(
        options,
        added.map((property) => `${indent}${property}`),
      ),
    );
  }
  if (edits.length === 0) {
    return { kind: 'unchanged' };
  }
  const text = apply(source, edits);
  return verify(text) ? { kind: 'merged', text, onDemand: output.kind !== 'ok' } : { kind: 'unusualShape' };
}

/** True when `text` parses and holds each piece of the guide's setup exactly once with server output and an adapter. */
export function emDashConfigIsWired(text: string): boolean {
  return verify(text);
}

function verify(text: string): boolean {
  if (syntaxErrors(text).length > 0) {
    return false;
  }
  const file = ts.createSourceFile('astro.config.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const options = defaultExportObject(file);
  if (options === undefined) {
    return false;
  }
  const modules = file.statements
    .filter(ts.isImportDeclaration)
    .map((statement) => (ts.isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : ''));
  const once = (name: string): boolean => modules.filter((module) => module === name).length === 1;
  if (!once('emdash/astro') || !once('emdash/db') || !once('@astrojs/react')) {
    return false;
  }
  const output = property(options, 'output');
  if (output === undefined || !ts.isStringLiteral(output.initializer) || output.initializer.text !== 'server') {
    return false;
  }
  if (property(options, 'adapter') === undefined) {
    return false;
  }
  const list = property(options, 'integrations')?.initializer;
  if (list === undefined || !ts.isArrayLiteralExpression(list)) {
    return false;
  }
  const calls = list.elements.filter(ts.isCallExpression).map((call) => call.expression.getText(file));
  const bindings = importedBindings(file);
  return calls.filter((name) => name === bindings.emdash).length === 1 && calls.filter((name) => name === bindings.react).length === 1;
}

function syntaxErrors(text: string): readonly ts.Diagnostic[] {
  const compiled = ts.transpileModule(text, {
    reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.Latest, module: ts.ModuleKind.ESNext },
    fileName: 'astro.config.ts',
  });
  return compiled.diagnostics ?? [];
}

// `export default defineConfig({ ... })` or `export default { ... }`.
function defaultExportObject(file: ts.SourceFile): ts.ObjectLiteralExpression | undefined {
  const exported = file.statements.find((statement): statement is ts.ExportAssignment => ts.isExportAssignment(statement) && statement.isExportEquals !== true);
  const expression = exported?.expression;
  if (expression === undefined) {
    return undefined;
  }
  if (ts.isObjectLiteralExpression(expression)) {
    return expression;
  }
  if (ts.isCallExpression(expression) && ts.isIdentifier(expression.expression) && expression.expression.text === 'defineConfig') {
    const [first] = expression.arguments;
    return first !== undefined && ts.isObjectLiteralExpression(first) ? first : undefined;
  }
  return undefined;
}

function property(options: ts.ObjectLiteralExpression, name: string): ts.PropertyAssignment | undefined {
  return options.properties.find(
    (candidate): candidate is ts.PropertyAssignment =>
      ts.isPropertyAssignment(candidate) && (ts.isIdentifier(candidate.name) || ts.isStringLiteral(candidate.name)) && candidate.name.text === name,
  );
}

function importedBindings(file: ts.SourceFile): Bindings {
  const bound = (module: string, fallback: string): string => {
    const found = file.statements
      .filter(ts.isImportDeclaration)
      .find((statement) => ts.isStringLiteral(statement.moduleSpecifier) && statement.moduleSpecifier.text === module);
    return found?.importClause?.name?.text ?? fallback;
  };
  return { node: bound('@astrojs/node', 'node'), react: bound('@astrojs/react', 'react'), emdash: bound('emdash/astro', 'emdash') };
}

function quoteOf(file: ts.SourceFile): '"' | "'" {
  const first = file.statements.find(ts.isImportDeclaration);
  return first !== undefined && first.moduleSpecifier.getText(file).startsWith("'") ? "'" : '"';
}

// The imports the guide needs and the file lacks, inserted after the last existing import (or at the top).
function planImports(file: ts.SourceFile): { readonly edits: readonly Edit[]; readonly bindings: Bindings } | undefined {
  const quote = quoteOf(file);
  const quoted = (name: string): string => `${quote}${name}${quote}`;
  const imports = file.statements.filter(ts.isImportDeclaration);
  const from = (module: string): ts.ImportDeclaration | undefined =>
    imports.find((statement) => ts.isStringLiteral(statement.moduleSpecifier) && statement.moduleSpecifier.text === module);
  const lines: string[] = [];
  const named = (statement: ts.ImportDeclaration, name: string): boolean => {
    const bindings = statement.importClause?.namedBindings;
    return bindings !== undefined && ts.isNamedImports(bindings) && bindings.elements.some((element) => element.name.text === name);
  };
  if (from('@astrojs/node') === undefined) {
    lines.push(`import node from ${quoted('@astrojs/node')};`);
  }
  if (from('@astrojs/react') === undefined) {
    lines.push(`import react from ${quoted('@astrojs/react')};`);
  }
  const emdash = from('emdash/astro');
  if (emdash === undefined) {
    lines.push(`import emdash, { local } from ${quoted('emdash/astro')};`);
  } else if (emdash.importClause?.name === undefined || !named(emdash, 'local')) {
    return undefined;
  }
  const database = from('emdash/db');
  if (database === undefined) {
    lines.push(`import { sqlite } from ${quoted('emdash/db')};`);
  } else if (!named(database, 'sqlite')) {
    return undefined;
  }
  const last = imports.at(-1);
  const at = last === undefined ? 0 : last.getEnd();
  const text = lines.length === 0 ? '' : last === undefined ? `${lines.join('\n')}\n` : `\n${lines.join('\n')}`;
  return { edits: text === '' ? [] : [{ start: at, end: at, text }], bindings: importedBindings(file) };
}

type OutputPlan = { readonly kind: 'ok' } | { readonly kind: 'add' } | { readonly kind: 'replace'; readonly edit: Edit } | 'unusual';

function planOutput(options: ts.ObjectLiteralExpression, quote: string): OutputPlan {
  const existing = property(options, 'output');
  if (existing === undefined) {
    return { kind: 'add' };
  }
  if (!ts.isStringLiteral(existing.initializer)) {
    return 'unusual';
  }
  if (existing.initializer.text === 'server') {
    return { kind: 'ok' };
  }
  if (existing.initializer.text === 'static') {
    return { kind: 'replace', edit: { start: existing.initializer.getStart(), end: existing.initializer.getEnd(), text: `${quote}server${quote}` } };
  }
  return 'unusual';
}

type AdapterPlan = { readonly kind: 'ok' } | { readonly kind: 'add' } | 'other' | 'unusual';

function planAdapter(options: ts.ObjectLiteralExpression, file: ts.SourceFile, bindings: Bindings): AdapterPlan {
  const existing = property(options, 'adapter');
  if (existing === undefined) {
    return { kind: 'add' };
  }
  const value = existing.initializer;
  if (ts.isCallExpression(value) && ts.isIdentifier(value.expression)) {
    return value.expression.text === bindings.node &&
      file.statements.filter(ts.isImportDeclaration).some((statement) => statement.moduleSpecifier.getText(file).includes('@astrojs/node'))
      ? { kind: 'ok' }
      : 'other';
  }
  return 'unusual';
}

type IntegrationsPlan =
  | { readonly kind: 'ok' }
  | { readonly kind: 'add' }
  | {
      readonly kind: 'append';
      readonly at: number;
      readonly leading: string;
      readonly separator: string;
      readonly needsReact: boolean;
      readonly needsEmDash: boolean;
    }
  | 'unusual';

function planIntegrations(source: string, options: ts.ObjectLiteralExpression, bindings: Bindings): IntegrationsPlan {
  const existing = property(options, 'integrations');
  if (existing === undefined) {
    return { kind: 'add' };
  }
  const list = existing.initializer;
  if (
    !ts.isArrayLiteralExpression(list) ||
    list.elements.some((element) => !ts.isCallExpression(element) && !ts.isIdentifier(element) && !ts.isSpreadElement(element))
  ) {
    return 'unusual';
  }
  const names = list.elements.filter(ts.isCallExpression).map((call) => call.expression.getText());
  const needsReact = !names.includes(bindings.react);
  const needsEmDash = !names.includes(bindings.emdash);
  if (!needsReact && !needsEmDash) {
    return { kind: 'ok' };
  }
  const last = list.elements.at(-1);
  if (last === undefined) {
    return { kind: 'append', at: list.getStart() + 1, leading: '', separator: ', ', needsReact, needsEmDash };
  }
  // A list written over several lines gets each new entry on a line of its own, at the last entry's indentation, before any
  // trailing comma (which then stays after the new last entry); a list on one line gets them after a comma and a space.
  if (source.slice(list.getStart(), last.getEnd()).includes('\n')) {
    const lineStart = source.lastIndexOf('\n', last.getStart() - 1) + 1;
    const lineIndent = /^[ \t]*/.exec(source.slice(lineStart, last.getStart()))?.[0] ?? '';
    return { kind: 'append', at: last.getEnd(), leading: `,\n${lineIndent}`, separator: `,\n${lineIndent}`, needsReact, needsEmDash };
  }
  const trailing = list.elements.hasTrailingComma;
  return { kind: 'append', at: trailing ? last.getEnd() + 1 : last.getEnd(), leading: trailing ? '' : ', ', separator: ', ', needsReact, needsEmDash };
}

function integrationLines(bindings: Bindings, include: { readonly react: boolean; readonly emdash: boolean }, separator: string): string {
  const parts: string[] = [];
  if (include.react) {
    parts.push(`${bindings.react}()`);
  }
  if (include.emdash) {
    parts.push(`${bindings.emdash}({ database: ${EMDASH_DATABASE}, storage: ${EMDASH_STORAGE} })`);
  }
  return parts.join(separator);
}

function indentOf(source: string, options: ts.ObjectLiteralExpression): string {
  const first = options.properties.at(0);
  if (first === undefined) {
    return '  ';
  }
  const lineStart = source.lastIndexOf('\n', first.getStart() - 1) + 1;
  const indent = /^[ \t]*/.exec(source.slice(lineStart, first.getStart()))?.[0] ?? '  ';
  return indent.length > 0 ? indent : '  ';
}

// New properties go after the last one: after its comma when the list ends with a comma, else with a comma of their own.
function propertyInsertion(options: ts.ObjectLiteralExpression, lines: readonly string[]): Edit {
  const last = options.properties.at(-1);
  const body = lines.join(',\n');
  if (last === undefined) {
    const at = options.getStart() + 1;
    return { start: at, end: at, text: `\n${body},\n` };
  }
  const trailing = options.properties.hasTrailingComma;
  const at = trailing ? last.getEnd() + 1 : last.getEnd();
  return { start: at, end: at, text: trailing ? `\n${body},` : `,\n${body}` };
}

// Applied from the end of the file backwards, so each edit's position is still the parser's.
function apply(source: string, edits: readonly Edit[]): string {
  let text = source;
  for (const edit of [...edits].sort((left, right) => right.start - left.start)) {
    text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
  }
  return text;
}
