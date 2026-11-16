// The plan for renaming a component file, or moving it to another folder under the components root: every text in the
// project that must change, worked out before anything is written. A plan is only values (texts before and after,
// witnesses, notices); componentRenameApply.ts writes it all or none.
//
// What is a reference, and how it is found (never a global search and replace):
//
//   module specifiers   the TypeScript parser reads every code region (an .astro frontmatter, a .ts/.tsx/.js/.jsx file, an .mdx
//                       import line): `import`, `import type`, side-effect imports, `export ... from` (barrels and re-exports),
//                       dynamic `import()` and `require()`. A relative specifier is recalculated from the importing file; an alias
//                       (`@/`, `~/`, tsconfig `paths`, component sources) keeps the alias the file used; `?raw` and `?url` suffixes stay.
//                       The moved file's own relative specifiers are re-aimed from its new folder.
//   the local binding   when a file imports the component under its own name (`import Old from ...`) and the name changes, the
//                       binding and every use of it in that file take the new name, and so do the template's tags, in an .astro or
//                       .mdx file: `<Old>`, `</Old>`, `<Old />`, and `{Old}` in an expression. An alias (`import Foo`) keeps its local
//                       name, so only its specifier changes. A name that file already uses keeps the old local name instead (a notice).
//   `.stacki`           the recipe key and every nested `component` reference in components.json (relinkDefaults), and each role's
//                       rules in roles.json (moveComponentRules).
//   layout paths        a `layout:` line in a markdown or MDX file's frontmatter.
//
// What is only reported (a notice, nothing written): a file that still names the old path or file name as text (CSS, JSON, config
// strings), a namespace tag (`<Forms.Old>`), and a file that would not parse and does not mention the component. A file that
// would not parse and DOES mention it refuses the whole rename: it cannot be edited safely, and a half rename is worse than none.
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { assert } from '../../shared/core/assert';
import { err, ok, type Result } from '../../shared/core/result';
import { aliasMap, type Alias } from '../content/cmsRefs';
import { parseComponentDefaults, parseDefaultsSource, relinkDefaults } from '../../shared/properties/componentDefaults';
import { moveComponentRules } from '../../shared/properties/componentAccess';
import {
  isComponentName,
  type ComponentRenameRequest,
  type ComponentRenameSummary,
  type RenameFileKind,
  type RenameNotice,
} from '../../shared/properties/componentRename';
import { parseProjectRolesSource, serializeProjectRoles } from '../../shared/properties/projectRoles';
import { isRenameTextCandidate, pageRenameInventoryWork, readRenameText } from '../project/pageRenameInventory';
import { renameDigest, type RenameText, type RenameWitness } from '../project/pageRenamePlan';
import { translateMain } from '../lib/mainLocale';
import { projectFoldersFor } from '../lib/projectFolders';
import type { SlicedWork } from '../lib/slicedWork';

export interface ComponentRenamePlan {
  readonly root: string;
  readonly change: ComponentRenameRequest;
  readonly texts: readonly RenameText[];
  readonly witnesses: readonly RenameWitness[];
  readonly summary: ComponentRenameSummary;
}

export interface ComponentRenameFailure {
  readonly code: 'invalid' | 'exists' | 'missing' | 'unsafe-file' | 'defaults-taken' | 'filesystem';
  readonly message: string;
}

interface Context {
  readonly root: string;
  readonly change: ComponentRenameRequest;
  readonly oldName: string;
  readonly newName: string;
  readonly aliases: readonly Alias[];
}

interface Edit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/** What one file's rewrite found: its edits, and whether the code could be read. */
interface Rewrite {
  readonly edits: readonly Edit[];
  readonly readable: boolean;
  /** The file imports the component under its own name and that name now changes. */
  readonly renamedBinding: boolean;
  readonly keptLocalName: boolean;
}

const CODE_FILE = /\.(?:[cm]?[jt]sx?)$/;

export function* planComponentRenameWork(root: string, change: ComponentRenameRequest): SlicedWork<Result<ComponentRenamePlan, ComponentRenameFailure>> {
  assert(path.isAbsolute(root), 'A rename plan starts from an absolute project root');
  const valid = validate(root, change);
  if (!valid.ok) {
    return valid;
  }
  let inventory;
  try {
    inventory = yield* pageRenameInventoryWork(root);
  } catch (error: unknown) {
    return failure('filesystem', error instanceof Error ? error.message : String(error));
  }
  const context: Context = {
    root,
    change,
    oldName: baseName(change.from),
    newName: baseName(change.to),
    aliases: aliasMap(root),
  };
  const texts: RenameText[] = [];
  const witnesses: RenameWitness[] = [];
  const files: { file: string; kind: RenameFileKind }[] = [];
  const notices: RenameNotice[] = [];
  const candidates = inventory.files.filter(isRenameTextCandidate);
  for (const candidate of candidates) {
    const read = readRenameText(root, candidate);
    if (read === undefined) {
      yield;
      continue;
    }
    witnesses.push({ file: read.file, digest: renameDigest(read.source) });
    const rewritten = rewriteFile(read.file, read.source, context);
    if (!rewritten.ok) {
      return rewritten;
    }
    for (const notice of rewritten.value.notices) {
      notices.push(notice);
    }
    if (rewritten.value.after !== read.source) {
      texts.push({ file: read.file, before: read.source, after: rewritten.value.after });
      files.push({ file: read.file, kind: kindOf(read.file, change) });
    }
    yield;
  }
  assert(texts.length <= witnesses.length, 'Every changed text was witnessed');
  const ordered = [...files].sort(
    (left, right) => Number(right.file === change.from) - Number(left.file === change.from) || left.file.localeCompare(right.file),
  );
  return ok({ root, change, texts, witnesses, summary: { from: change.from, to: change.to, files: ordered, notices } });
}

function validate(root: string, change: ComponentRenameRequest): Result<true, ComponentRenameFailure> {
  const folders = projectFoldersFor(root, 'components');
  const source = folders.find((folder) => change.from.startsWith(`${folder}/`));
  const target = folders.find((folder) => change.to.startsWith(`${folder}/`));
  if (source === undefined || target === undefined) {
    return failure('invalid', translateMain('error.componentRename.outside'));
  }
  if (change.from === change.to) {
    return failure('invalid', translateMain('error.componentRename.same'));
  }
  if (!isComponentName(baseName(change.to))) {
    return failure('invalid', translateMain('error.componentRename.name', { name: baseName(change.to) }));
  }
  const sourceFile = path.join(root, ...change.from.split('/'));
  const targetFile = path.join(root, ...change.to.split('/'));
  return validateOnDisk({ sourceFile, targetFile, change });
}

function validateOnDisk(input: {
  readonly sourceFile: string;
  readonly targetFile: string;
  readonly change: ComponentRenameRequest;
}): Result<true, ComponentRenameFailure> {
  const { sourceFile, targetFile, change } = input;
  let metadata;
  try {
    metadata = fs.lstatSync(sourceFile);
  } catch {
    return failure('missing', translateMain('error.componentRename.missing', { name: baseName(change.from) }));
  }
  if (!metadata.isFile()) {
    return failure('invalid', translateMain('error.componentRename.outside'));
  }
  // A target that exists is a clash, except a case-only change of this same file (one file under two spellings on a case-insensitive disk).
  if (fs.existsSync(targetFile)) {
    const sameFile = change.from.toLowerCase() === change.to.toLowerCase() && fs.statSync(targetFile).ino === metadata.ino;
    if (!sameFile) {
      return failure('exists', translateMain('error.componentRename.exists', { file: change.to }));
    }
  }
  const sibling = fs.existsSync(path.dirname(targetFile))
    ? fs
        .readdirSync(path.dirname(targetFile))
        .find((entry) => entry.toLowerCase() === baseName(change.to).toLowerCase() + '.astro' && path.join(path.dirname(targetFile), entry) !== sourceFile)
    : undefined;
  if (sibling !== undefined) {
    return failure('exists', translateMain('error.componentRename.exists', { file: sibling }));
  }
  return ok(true);
}

interface FileResult {
  readonly after: string;
  readonly notices: readonly RenameNotice[];
}

function rewriteFile(file: string, source: string, context: Context): Result<FileResult, ComponentRenameFailure> {
  const { change } = context;
  if (file === '.stacki/components.json') {
    return rewriteDefaults(source, context);
  }
  if (file === '.stacki/roles.json') {
    return rewriteRoles(source, context);
  }
  const notices: RenameNotice[] = [];
  const mentions = mentionsComponent(source, context);
  let after = source;
  if (/\.astro$/.test(file)) {
    const result = rewriteAstro(file, source, context);
    if (!result.readable) {
      return mentions ? failure('unsafe-file', translateMain('error.componentRename.unreadable', { file })) : unreadable(source, file);
    }
    after = applyEdits(source, result.edits);
    if (result.keptLocalName) {
      notices.push({ file, kind: 'kept-local-name' });
    }
  } else if (CODE_FILE.test(file)) {
    const result = rewriteCode(file, source, 0, context);
    if (!result.readable) {
      return mentions ? failure('unsafe-file', translateMain('error.componentRename.unreadable', { file })) : unreadable(source, file);
    }
    after = applyEdits(source, result.edits);
    if (result.keptLocalName) {
      notices.push({ file, kind: 'kept-local-name' });
    }
  } else if (/\.mdx$/.test(file)) {
    const result = rewriteMdx(file, source, context);
    if (!result.readable) {
      return mentions ? failure('unsafe-file', translateMain('error.componentRename.unreadable', { file })) : unreadable(source, file);
    }
    after = applyEdits(source, result.edits);
    if (result.keptLocalName) {
      notices.push({ file, kind: 'kept-local-name' });
    }
  } else if (/\.md$/.test(file)) {
    after = applyEdits(source, layoutEdits(file, source, 0, context));
  }
  if (new RegExp(`<[A-Za-z_$][\\w$]*\\.${context.oldName}(?![\\w$])`).test(after)) {
    notices.push({ file, kind: 'namespace' });
  }
  if (stillNames(after, context) && !(file === change.from)) {
    notices.push({ file, kind: 'mention' });
  }
  return ok({ after, notices });

  function unreadable(text: string, name: string): Result<FileResult, ComponentRenameFailure> {
    return ok({ after: text, notices: [{ file: name, kind: 'unparsed' }] });
  }
}

// The text a leftover mention is looked for with: the new file name replaced the old one, or the path's last two segments.
function mentionNeedle(context: Context): string {
  return context.oldName === context.newName ? context.change.from.split('/').slice(-2).join('/') : `${context.oldName}.astro`;
}

function stillNames(text: string, context: Context): boolean {
  return text.includes(mentionNeedle(context));
}

function mentionsComponent(source: string, context: Context): boolean {
  return source.includes(`${context.oldName}.astro`);
}

function rewriteDefaults(source: string, context: Context): Result<FileResult, ComponentRenameFailure> {
  const parsed = parseDefaultsSource(source);
  if (!parsed.ok) {
    return failure('unsafe-file', translateMain('error.componentRename.unreadable', { file: '.stacki/components.json' }));
  }
  const { from, to } = context.change;
  if (!(from in parsed.value.components)) {
    // Only nested references can name it; relinking still renames them.
    const nested = relinkDefaults(parsed.value, from, to);
    return nested.ok ? ok({ after: serializeDefaults(source, parsed.value, nested.value), notices: [] }) : defaultsTaken();
  }
  const relinked = relinkDefaults(parsed.value, from, to);
  return relinked.ok ? ok({ after: serializeDefaults(source, parsed.value, relinked.value), notices: [] }) : defaultsTaken();
}

function defaultsTaken(): Result<never, ComponentRenameFailure> {
  return failure('defaults-taken', translateMain('error.componentRename.defaultsTaken'));
}

// The file as the app writes it, only when something changed: an untouched file keeps its bytes.
function serializeDefaults(source: string, before: unknown, after: unknown): string {
  return JSON.stringify(before) === JSON.stringify(after) ? source : `${JSON.stringify(parseComponentDefaults(after), undefined, 2)}\n`;
}

function rewriteRoles(source: string, context: Context): Result<FileResult, ComponentRenameFailure> {
  let roles;
  try {
    roles = parseProjectRolesSource(source);
  } catch {
    return failure('unsafe-file', translateMain('error.componentRename.unreadable', { file: '.stacki/roles.json' }));
  }
  let touched = false;
  const next = roles.roles.map((role) => {
    const rules = moveComponentRules(role.componentRules, { kind: 'component', path: context.change.from }, context.change.to);
    const changed = rules.length !== role.componentRules.length || rules.some((rule, index) => rule.path !== role.componentRules[index]?.path);
    touched = touched || changed;
    return changed ? { ...role, componentRules: rules } : role;
  });
  return ok({ after: touched ? serializeProjectRoles({ ...roles, roles: next }) : source, notices: [] });
}

// ----- code regions -----

function rewriteAstro(file: string, source: string, context: Context): Rewrite {
  const fence = /^(\s*---[ \t]*\r?\n)([\s\S]*?)(\r?\n---[ \t]*(?:\r?\n|$))/.exec(source);
  const frontmatterStart = fence === null ? 0 : (fence[1]?.length ?? 0);
  const frontmatter = fence?.[2] ?? '';
  const templateStart = fence === null ? 0 : fence[0].length;
  const code = rewriteCode(file, frontmatter, frontmatterStart, context, { scriptKind: ts.ScriptKind.TS });
  if (!code.readable) {
    return code;
  }
  const edits = [...code.edits];
  if (code.renamedBinding) {
    edits.push(...renameInTemplate(source, templateStart, context));
  }
  if (source.slice(templateStart).length > 0) {
    edits.push(...layoutEdits(file, source.slice(templateStart), templateStart, context));
  }
  return { ...code, edits };
}

function rewriteMdx(file: string, source: string, context: Context): Rewrite {
  const edits: Edit[] = [];
  let renamedBinding = false;
  let keptLocalName = false;
  const statements = /^import\b[^\n]*?(?:from\s*)?(['"])[^'"\n]+\1[^\n]*$/gm;
  for (const match of source.matchAll(statements)) {
    const result = rewriteCode(file, match[0], match.index, context, { scriptKind: ts.ScriptKind.TS });
    if (!result.readable) {
      return result;
    }
    edits.push(...result.edits);
    renamedBinding = renamedBinding || result.renamedBinding;
    keptLocalName = keptLocalName || result.keptLocalName;
  }
  if (renamedBinding) {
    edits.push(...renameInTemplate(source, 0, context));
  }
  edits.push(...layoutEdits(file, source, 0, context));
  return { edits, readable: true, renamedBinding, keptLocalName };
}

function rewriteCode(file: string, code: string, offset: number, context: Context, options: { readonly scriptKind?: ts.ScriptKind } = {}): Rewrite {
  if (!code.includes('import') && !code.includes('export') && !code.includes('require')) {
    return { edits: [], readable: true, renamedBinding: false, keptLocalName: false };
  }
  const scriptKind = options.scriptKind ?? (/\.[jt]sx$|\.js$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const parsedOk =
    (
      ts.transpileModule(code, {
        reportDiagnostics: true,
        fileName: scriptKind === ts.ScriptKind.TSX ? 'source.tsx' : 'source.ts',
        compilerOptions: { jsx: ts.JsxEmit.Preserve, target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
      }).diagnostics ?? []
    ).length === 0;
  if (!parsedOk) {
    return { edits: [], readable: false, renamedBinding: false, keptLocalName: false };
  }
  const source = ts.createSourceFile(scriptKind === ts.ScriptKind.TSX ? 'source.tsx' : 'source.ts', code, ts.ScriptTarget.Latest, true, scriptKind);
  const importer = { old: file, next: file === context.change.from ? context.change.to : file };
  const edits: Edit[] = [];
  const bindings: string[] = [];
  let kept = false;
  // An explicit work list: a file's syntax tree can be as deep as its author made it, and the walk must not depend on the stack.
  const pending: ts.Node[] = [source];
  for (let visited = 0; pending.length > 0 && visited < 10_000_000; visited += 1) {
    const node = pending.pop();
    assert(node !== undefined, 'A non-empty list has a last entry');
    const specifier = moduleSpecifierOf(node);
    if (specifier !== undefined) {
      const next = rewriteSpecifier(specifier.text, importer, context);
      if (next !== specifier.text) {
        edits.push({ start: offset + specifier.getStart(source) + 1, end: offset + specifier.getEnd() - 1, text: next });
      }
      if (ts.isImportDeclaration(node) && node.importClause?.name !== undefined && node.importClause.isTypeOnly === false) {
        if (resolvesToSource(specifier.text, importer.old, context) && node.importClause.name.text === context.oldName && context.oldName !== context.newName) {
          bindings.push(node.importClause.name.text);
        }
      }
    }
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  let renamedBinding = false;
  if (bindings.length > 0) {
    if (usesIdentifier(code, context.newName, source)) {
      kept = true;
    } else {
      renamedBinding = true;
      edits.push(...identifierEdits(source, offset, context));
    }
  }
  assert(edits.length <= code.length + 1, 'Edits are bounded by the text');
  return { edits, readable: true, renamedBinding, keptLocalName: kept };
}

function moduleSpecifierOf(node: ts.Node): ts.StringLiteralLike | undefined {
  if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)) {
    return node.moduleSpecifier;
  }
  if (ts.isCallExpression(node) && node.arguments.length >= 1) {
    const argument = node.arguments[0];
    const dynamic = node.expression.kind === ts.SyntaxKind.ImportKeyword;
    const required = ts.isIdentifier(node.expression) && node.expression.text === 'require';
    if ((dynamic || required) && argument !== undefined && ts.isStringLiteralLike(argument)) {
      return argument;
    }
  }
  return undefined;
}

function usesIdentifier(code: string, name: string, source: ts.SourceFile): boolean {
  if (!new RegExp(`(^|[^\\w$])${name}([^\\w$]|$)`).test(code)) {
    return false;
  }
  const pending: ts.Node[] = [source];
  for (let visited = 0; pending.length > 0 && visited < 10_000_000; visited += 1) {
    const node = pending.pop();
    assert(node !== undefined, 'A non-empty list has a last entry');
    if (ts.isIdentifier(node) && node.text === name) {
      return true;
    }
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}

// Every use of the old local name as a value, not as a property name or key, renamed.
function identifierEdits(source: ts.SourceFile, offset: number, context: Context): readonly Edit[] {
  const edits: Edit[] = [];
  const pending: ts.Node[] = [source];
  for (let visited = 0; pending.length > 0 && visited < 10_000_000; visited += 1) {
    const node = pending.pop();
    assert(node !== undefined, 'A non-empty list has a last entry');
    node.forEachChild((child) => {
      pending.push(child);
    });
    if (!ts.isIdentifier(node) || node.text !== context.oldName) {
      continue;
    }
    const parent = node.parent;
    const start = offset + node.getStart(source);
    const end = offset + node.getEnd();
    if (ts.isPropertyAccessExpression(parent) && parent.name === node) {
      continue;
    }
    if (ts.isQualifiedName(parent) && parent.right === node) {
      continue;
    }
    if (
      (ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent) || ts.isMethodDeclaration(parent) || ts.isPropertySignature(parent)) &&
      parent.name === node
    ) {
      continue;
    }
    if (ts.isBindingElement(parent) && parent.propertyName === node) {
      continue;
    }
    if (ts.isShorthandPropertyAssignment(parent)) {
      edits.push({ start, end, text: `${context.oldName}: ${context.newName}` });
      continue;
    }
    if (ts.isExportSpecifier(parent) && parent.propertyName === undefined) {
      edits.push({ start, end, text: `${context.newName} as ${context.oldName}` });
      continue;
    }
    edits.push({ start, end, text: context.newName });
  }
  return edits;
}

// ----- the specifier -----

function resolvesToSource(specifier: string, importerFile: string, context: Context): boolean {
  return resolveTarget(specifier, importerFile, context)?.target === context.change.from;
}

interface Resolved {
  readonly target: string;
  readonly relative: boolean;
  readonly alias: Alias | undefined;
  readonly suffix: string;
}

function resolveTarget(specifier: string, importerFile: string, context: Context): Resolved | undefined {
  const cut = specifier.search(/[?#]/);
  const bare = cut < 0 ? specifier : specifier.slice(0, cut);
  const suffix = cut < 0 ? '' : specifier.slice(cut);
  if (bare.startsWith('./') || bare.startsWith('../')) {
    return { target: path.posix.normalize(path.posix.join(path.posix.dirname(importerFile), bare)), relative: true, alias: undefined, suffix };
  }
  for (const alias of context.aliases) {
    const matches = alias.wildcard ? bare.startsWith(alias.prefix) : bare === alias.prefix;
    const base = alias.targets[0];
    if (matches && base !== undefined) {
      const absolute = path.resolve(base, bare.slice(alias.prefix.length));
      return { target: toPosix(path.relative(context.root, absolute)), relative: false, alias, suffix };
    }
  }
  return undefined;
}

function rewriteSpecifier(specifier: string, importer: { readonly old: string; readonly next: string }, context: Context): string {
  const resolved = resolveTarget(specifier, importer.old, context);
  if (resolved === undefined) {
    return specifier;
  }
  const isSource = resolved.target === context.change.from;
  const importerMoved = importer.old !== importer.next;
  if (!isSource && !(importerMoved && resolved.relative)) {
    return specifier;
  }
  const target = isSource ? context.change.to : resolved.target;
  if (resolved.relative) {
    const relative = path.posix.relative(path.posix.dirname(importer.next), target);
    return (relative.startsWith('.') ? relative : `./${relative}`) + resolved.suffix;
  }
  const alias = resolved.alias;
  const base = alias?.targets[0];
  if (alias !== undefined && base !== undefined) {
    const inside = path.posix.relative(toPosix(path.relative(context.root, base)), target);
    if (!inside.startsWith('..')) {
      return alias.prefix + inside + resolved.suffix;
    }
  }
  const fallback = path.posix.relative(path.posix.dirname(importer.next), target);
  return (fallback.startsWith('.') ? fallback : `./${fallback}`) + resolved.suffix;
}

// A markdown or MDX `layout:` line in the frontmatter block.
function layoutEdits(file: string, text: string, offset: number, context: Context): readonly Edit[] {
  if (!/\.mdx?$/.test(file)) {
    return [];
  }
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (block === null) {
    return [];
  }
  const edits: Edit[] = [];
  const line = /^(layout:\s*['"]?)([^'"\s]+)(['"]?\s*)$/m.exec(block[1] ?? '');
  if (line !== null) {
    const specifier = line[2] ?? '';
    const next = rewriteSpecifier(specifier, { old: file, next: file }, context);
    if (next !== specifier) {
      const start = offset + block[0].indexOf(block[1] ?? '') + line.index + (line[1]?.length ?? 0);
      edits.push({ start, end: start + specifier.length, text: next });
    }
  }
  return edits;
}

// ----- the template -----

/**
 * The tags and expressions of an Astro or MDX template that name the old local binding. A small scanner, not a search:
 * HTML comments, `<script>` and `<style>` bodies, fenced code and every string literal are skipped; prose is never touched.
 */
function renameInTemplate(text: string, from: number, context: Context): readonly Edit[] {
  const edits: Edit[] = [];
  const name = context.oldName;
  const isWord = (char: string | undefined): boolean => char !== undefined && /[\w$]/.test(char);
  let index = from;
  let braces = 0;
  let tag = false;
  for (let steps = 0; index < text.length && steps <= text.length * 4 + 8; steps += 1) {
    const char = text.charAt(index);
    if (braces === 0 && !tag) {
      if (text.startsWith('<!--', index)) {
        const end = text.indexOf('-->', index + 4);
        index = end < 0 ? text.length : end + 3;
        continue;
      }
      if (/^<(script|style)[\s>]/i.test(text.slice(index, index + 9))) {
        const close = text.slice(index).search(/<\/(script|style)\s*>/i);
        index = close < 0 ? text.length : index + close + 1;
        continue;
      }
      if (text.startsWith('```', index) && (index === 0 || text.charAt(index - 1) === '\n')) {
        const end = text.indexOf('\n```', index + 3);
        index = end < 0 ? text.length : end + 4;
        continue;
      }
      if (char === '<') {
        const closing = text.charAt(index + 1) === '/';
        const nameAt = index + (closing ? 2 : 1);
        if (text.startsWith(name, nameAt) && !isWord(text.charAt(nameAt + name.length)) && text.charAt(nameAt + name.length) !== '.') {
          edits.push({ start: nameAt, end: nameAt + name.length, text: context.newName });
        }
        tag = true;
        index = nameAt;
        continue;
      }
      if (char === '{') {
        braces = 1;
      }
      index += 1;
      continue;
    }
    // Inside a tag or an expression: strings are skipped, braces nest, identifiers are checked.
    if (char === '"' || char === "'" || char === '`') {
      index = skipString(text, index);
      continue;
    }
    if (char === '{') {
      braces += 1;
    } else if (char === '}') {
      braces = Math.max(0, braces - 1);
    } else if (char === '>' && braces === 0) {
      tag = false;
    } else if (
      braces > 0 &&
      text.startsWith(name, index) &&
      !isWord(text.charAt(index - 1)) &&
      text.charAt(index - 1) !== '.' &&
      !isWord(text.charAt(index + name.length))
    ) {
      edits.push({ start: index, end: index + name.length, text: context.newName });
      index += name.length;
      continue;
    }
    index += 1;
  }
  assert(index >= text.length || edits.length >= 0, 'The scan ended inside the template');
  return edits;
}

function skipString(text: string, start: number): number {
  const quote = text.charAt(start);
  for (let index = start + 1; index < text.length; index += 1) {
    const char = text.charAt(index);
    if (char === '\\') {
      index += 1;
    } else if (char === quote) {
      return index + 1;
    }
  }
  return text.length;
}

// ----- helpers -----

/** The edits applied from the end, so earlier offsets stay true. Overlapping edits would corrupt the file, so they assert. */
export function applyEdits(source: string, edits: readonly Edit[]): string {
  const ordered = [...edits].sort((left, right) => right.start - left.start);
  let result = source;
  let limit = source.length;
  for (const edit of ordered) {
    assert(edit.start <= edit.end, 'An edit starts before it ends');
    assert(edit.end <= limit, 'Edits do not overlap and stay inside the text');
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
    limit = edit.start;
  }
  return result;
}

function kindOf(file: string, change: ComponentRenameRequest): RenameFileKind {
  if (file === change.from) {
    return 'component';
  }
  if (file.startsWith('.stacki/')) {
    return 'settings';
  }
  if (file.startsWith('src/pages/')) {
    return 'page';
  }
  if (file.startsWith('src/layouts/')) {
    return 'layout';
  }
  if (/\.(?:md|mdx)$/.test(file)) {
    return 'content';
  }
  return file.endsWith('.astro') ? 'component' : 'code';
}

function baseName(file: string): string {
  return path.posix.basename(file, '.astro');
}

function toPosix(file: string): string {
  return file.split(path.sep).join('/');
}

function failure(code: ComponentRenameFailure['code'], message: string): Result<never, ComponentRenameFailure> {
  return err({ code, message });
}
