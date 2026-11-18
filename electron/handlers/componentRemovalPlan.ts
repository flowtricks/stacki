// The plan for deleting a component file (or a folder of them) together with everything that names it: every text in
// the project that must change, worked out before anything is written (docs/components.md, "Deleting a component").
// A plan is only values: each file's text before and after, the counts the confirmation shows, and the places a person
// must review. componentOps.ts writes it all or none, and the component file goes last.
//
// What is rewritten (never a global search and replace):
//
//   instances   every `<Div …>` of the component in an .astro template, with everything inside it, the comment that
//               labels it and the whitespace that separated it: the same span Delete on the canvas takes
//               (shared/engine/planTree.ts, removalRange). An instance inside another instance goes with its parent.
//   imports     the import that binds the component, read by the TypeScript parser in an .astro frontmatter, a .ts/.js
//               file or an MDX import line: default (`import Div from`), `{ default as Div }`, side-effect imports, and
//               named imports through one barrel (`export { default as Div } from './Div.astro'` in an index file, whose
//               export is removed too). Specifiers resolve relative, through tsconfig `paths` and component sources, and
//               with the extension or `/index` left off. In `import { Div, Button } from` only `Div` goes.
//
// What refuses the deletion, listed by file and line (COMPONENT_REMOVAL_REVIEW_KINDS): a use Stacki cannot rewrite. The
// whole plan is computed either way, so the confirmation can show every place at once.
//
// Why imports are taken out even where nothing renders the component: an import of a file that is gone breaks
// `astro check` and every type check, and a page's import is what keeps the component's stylesheet modules in the
// dev server's graph.
import path from 'node:path';
import ts from 'typescript';
import type { AttributeNode, Node } from '@astrojs/compiler/types';
import { assert } from '../../shared/core/assert';
import { err, ok, type Result } from '../../shared/core/result';
import type { ComponentOpError } from '../../shared/properties/componentOps';
import {
  COMPONENT_REMOVAL_LIMITS,
  type ComponentRemovalFile,
  type ComponentRemovalReview,
  type ComponentRemovalReviewKind,
} from '../../shared/properties/componentRemoval';
import { aliasMap, resolveSpec, type Alias } from '../content/cmsRefs';
import { translateMain, translateMainDescribed } from '../lib/mainLocale';
import { comparablePath } from '../lib/platform';
import { projectSources, readBoundedSource } from '../properties/propertyConsumers';
import { lineAt, parseAstroTemplate } from '../properties/propertyReads';

/** One file's text before and after the deletion; `file` is absolute. */
export interface RemovalText {
  readonly file: string;
  readonly before: string;
  readonly after: string;
}

export interface ComponentReferencePlan {
  readonly texts: readonly RemovalText[];
  readonly instances: readonly ComponentRemovalFile[];
  readonly imports: readonly ComponentRemovalFile[];
  readonly reviews: readonly ComponentRemovalReview[];
}

export const COMPONENT_REMOVAL_PLAN_LIMITS = {
  /** Syntax nodes one file's walk visits; a file past it is not one Stacki can rewrite safely. */
  nodesMax: 2_000_000,
} as const satisfies Record<string, number>;

interface Context {
  readonly root: string;
  readonly targetKeys: ReadonlySet<string>;
  readonly targets: readonly string[];
  readonly aliases: readonly Alias[];
  /** Index files that re-export a target, keyed by comparable path, with the names they export it under. */
  readonly barrels: ReadonlyMap<string, ReadonlySet<string>>;
  /** Words one of which a file must contain to be read at all: a cheap filter before any parse. */
  readonly needles: readonly string[];
}

interface Edit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

interface Review {
  readonly kind: ComponentRemovalReviewKind;
  readonly offset: number;
}

/** What one code region holds of the component: its import edits, the names it binds, and what refuses. */
interface CodeAnalysis {
  readonly readable: boolean;
  readonly edits: readonly Edit[];
  /** Local names that stand for the component: default imports and named imports through a barrel. */
  readonly bindings: ReadonlySet<string>;
  /** `ns.Name` spellings that reach the component through a namespace import of a barrel. */
  readonly qualified: ReadonlySet<string>;
  readonly imports: number;
  readonly reviews: readonly Review[];
}

interface FileOutcome {
  readonly after: string;
  readonly instances: number;
  readonly imports: number;
  readonly reviews: readonly Review[];
}

type Resolution = { readonly kind: 'target' } | { readonly kind: 'barrel'; readonly names: ReadonlySet<string> } | undefined;

const CODE_FILE = /\.(?:[cm]?[jt]sx?)$/;
const ASTRO_FENCE = /^(\s*---[ \t]*\r?\n)([\s\S]*?)(\r?\n---[ \t]*(?:\r?\n|$))/;
const EXTENSIONS = ['.astro', '.ts', '.tsx', '.js', '.jsx', '.mjs'] as const;

/**
 * Every edit that deleting `targets` (absolute component files) needs, and every use that refuses it. Nothing is
 * written. A file that names a target but cannot be parsed is a review, not a guess; an edited file that would not parse
 * afterwards refuses the plan outright.
 */
export function planComponentReferences(root: string, targets: readonly string[]): Result<ComponentReferencePlan, ComponentOpError> {
  assert(path.isAbsolute(root), 'A removal plan starts from an absolute project root');
  assert(targets.length > 0, 'A removal plan names at least one component file');
  const sources = projectSources(root);
  if (!sources.ok) {
    return failure('too-large', translateMainDescribed(sources.error));
  }
  const targetKeys = new Set(targets.map((target) => comparablePath(target)));
  const files = sources.value.filter((file) => !targetKeys.has(comparablePath(file)));
  const aliases = aliasMap(root);
  const read = new Map<string, string>();
  for (const file of files) {
    const text = readBoundedSource(file);
    if (!text.ok) {
      return failure('too-large', translateMainDescribed(text.error));
    }
    read.set(file, text.value);
  }
  const base = { root, targetKeys, targets, aliases, barrels: new Map<string, ReadonlySet<string>>(), needles: [] };
  const barrels = findBarrels(read, base);
  const context: Context = { ...base, barrels, needles: needlesOf(targets, barrels) };
  return planFiles(read, context);
}

function planFiles(read: ReadonlyMap<string, string>, context: Context): Result<ComponentReferencePlan, ComponentOpError> {
  const texts: RemovalText[] = [];
  const instances: ComponentRemovalFile[] = [];
  const imports: ComponentRemovalFile[] = [];
  const reviews: ComponentRemovalReview[] = [];
  for (const [file, source] of read) {
    if (!context.needles.some((needle) => source.includes(needle))) {
      continue;
    }
    const outcome = planFile(file, source, context);
    const relative = toPosix(path.relative(context.root, file));
    for (const review of outcome.reviews) {
      if (reviews.length < COMPONENT_REMOVAL_LIMITS.reviewsMax) {
        reviews.push({ kind: review.kind, path: relative, line: lineAt(source, review.offset) });
      }
    }
    if (outcome.after === source) {
      continue;
    }
    if (outcome.reviews.length === 0 && !reparses(file, outcome.after)) {
      return failure('unsafe-file', translateMain('error.componentRemoval.wouldBreak', { file: relative }));
    }
    texts.push({ file, before: source, after: outcome.after });
    if (outcome.instances > 0) {
      instances.push({ path: relative, count: outcome.instances });
    }
    if (outcome.imports > 0) {
      imports.push({ path: relative, count: outcome.imports });
    }
  }
  assert(instances.length <= texts.length, 'Every file with instances taken out is a changed text');
  assert(imports.length <= texts.length, 'Every file with imports taken out is a changed text');
  const byPath = (left: ComponentRemovalFile, right: ComponentRemovalFile): number => left.path.localeCompare(right.path);
  return ok({ texts, instances: [...instances].sort(byPath), imports: [...imports].sort(byPath), reviews });
}

function planFile(file: string, source: string, context: Context): FileOutcome {
  if (file.endsWith('.astro')) {
    return planAstro(file, source, context);
  }
  if (file.endsWith('.mdx')) {
    return planMdx(file, source, context);
  }
  if (file.endsWith('.md')) {
    return { after: source, instances: 0, imports: 0, reviews: layoutReviews(file, source, context) };
  }
  if (CODE_FILE.test(file)) {
    const analysis = analyzeCode(file, source, 0, context);
    if (!analysis.readable) {
      return unreadable(source, context);
    }
    const uses = analysis.bindings.size > 0 || analysis.qualified.size > 0 ? valueUsesInCode(source, 0, analysis, file) : [];
    const reviews = [...analysis.reviews, ...uses];
    return { after: reviews.length === 0 ? applyEdits(source, analysis.edits) : source, instances: 0, imports: analysis.imports, reviews };
  }
  return { after: source, instances: 0, imports: 0, reviews: [] };
}

// ----- .astro -----

function planAstro(file: string, source: string, context: Context): FileOutcome {
  const fence = ASTRO_FENCE.exec(source);
  const frontmatterStart = fence === null ? 0 : (fence[1]?.length ?? 0);
  const frontmatter = fence?.[2] ?? '';
  const analysis = analyzeCode(file, frontmatter, frontmatterStart, context, 'astro');
  if (!analysis.readable) {
    return unreadable(source, context);
  }
  const root = parseAstroTemplate(source);
  if (!root.ok) {
    return unreadable(source, context);
  }
  const reviews: Review[] = [...analysis.reviews];
  if (analysis.bindings.size > 0 || analysis.qualified.size > 0) {
    reviews.push(...valueUsesInCode(frontmatter, frontmatterStart, analysis, file));
  }
  const template = analysis.bindings.size > 0 || analysis.qualified.size > 0 ? templateUses(source, root.value, analysis) : undefined;
  if (template !== undefined) {
    reviews.push(...template.reviews);
  }
  const edits = [...analysis.edits, ...(template?.edits ?? [])];
  // A frontmatter left empty closes up (`---` over `---`) rather than keeping a blank line between its fences.
  const after = reviews.length === 0 ? applyEdits(source, mergeEdits(edits)).replace(/^(\s*---[ \t]*)(\r?\n)[ \t]*\r?\n(---)/, '$1$2$3') : source;
  return { after, instances: template?.instances ?? 0, imports: analysis.imports, reviews };
}

interface TemplateUses {
  readonly edits: readonly Edit[];
  readonly instances: number;
  readonly reviews: readonly Review[];
}

// The instances of the component in a template, and every other use of its names there.
function templateUses(source: string, root: Node, analysis: CodeAnalysis): TemplateUses {
  const offsets = utf8Offsets(source);
  const edits: Edit[] = [];
  const reviews: Review[] = [];
  let instances = 0;
  const pending: { readonly node: Node; readonly inExpression: boolean; readonly removed: boolean }[] = [{ node: root, inExpression: false, removed: false }];
  for (let visited = 0; pending.length > 0; visited += 1) {
    assert(visited <= COMPONENT_REMOVAL_PLAN_LIMITS.nodesMax, 'A template walk is bounded');
    const entry = pending.pop();
    assert(entry !== undefined, 'A non-empty list has a last entry');
    const { node } = entry;
    let removed = entry.removed;
    const start = node.position === undefined ? 0 : offsets(node.position.start.offset);
    if (node.type === 'component' && analysis.bindings.has(node.name)) {
      instances += 1;
      if (!removed) {
        const span = instanceSpan(source, start, node.name);
        if (entry.inExpression || span === undefined) {
          reviews.push({ kind: entry.inExpression ? 'expression' : 'unreadable', offset: start });
        } else {
          edits.push({ ...removalRange(source, span.start, span.end), text: '' });
        }
        removed = true;
      }
    } else if ((node.type === 'component' || node.type === 'custom-element') && namesValue(node.name, analysis)) {
      reviews.push({ kind: 'value', offset: start });
    }
    if (node.type === 'text' && entry.inExpression && mentionsAny(node.value, analysis)) {
      reviews.push({ kind: 'value', offset: start });
    }
    if ('attributes' in node) {
      for (const attribute of node.attributes) {
        if (attributeMentions(attribute, analysis)) {
          reviews.push({ kind: 'value', offset: attribute.position === undefined ? start : offsets(attribute.position.start.offset) });
        }
      }
    }
    if (!('children' in node)) {
      continue;
    }
    if (node.type === 'element' && (node.name === 'script' || node.name === 'style')) {
      continue;
    }
    const inExpression = entry.inExpression || node.type === 'expression';
    for (const child of node.children) {
      pending.push({ node: child, inExpression, removed });
    }
  }
  return { edits, instances, reviews };
}

/**
 * The instance's own text, `<Div …>` through its closing `</Div>` (or its own `/>`); undefined when the text there is not
 * that tag. The parser's position only says where to look: its offsets are not exact for tags (a self-closing tag at the
 * top of a template starts one past its `<` and has no end; one with attributes ends inside them), so the tag is read
 * from the text itself, quotes and `{…}` included.
 */
export function instanceSpan(source: string, approximate: number, name: string): { readonly start: number; readonly end: number } | undefined {
  const opener = `<${name}`;
  let start = -1;
  for (const candidate of [approximate, approximate - 1, approximate - 2]) {
    if (candidate >= 0 && source.startsWith(opener, candidate) && /[\s/>]/.test(source.charAt(candidate + opener.length))) {
      start = candidate;
      break;
    }
  }
  if (start < 0) {
    return undefined;
  }
  const open = tagEnd(source, start + opener.length);
  if (open === undefined) {
    return undefined;
  }
  if (open.selfClosing) {
    return { start, end: open.end };
  }
  let depth = 1;
  let index = open.end;
  for (let steps = 0; index < source.length && steps <= source.length; steps += 1) {
    const next = source.indexOf('<', index);
    if (next < 0) {
      return undefined;
    }
    if (source.startsWith(`</${name}`, next) && /[\s>]/.test(source.charAt(next + name.length + 2))) {
      const close = source.indexOf('>', next);
      if (close < 0) {
        return undefined;
      }
      depth -= 1;
      index = close + 1;
      if (depth === 0) {
        assert(start < index, 'An instance spans at least its tag');
        return { start, end: index };
      }
    } else if (source.startsWith(opener, next) && /[\s/>]/.test(source.charAt(next + opener.length))) {
      const nested = tagEnd(source, next + opener.length);
      if (nested === undefined) {
        return undefined;
      }
      depth += nested.selfClosing ? 0 : 1;
      index = nested.end;
    } else {
      index = next + 1;
    }
  }
  return undefined;
}

// Where an opening tag ends: after its `>`, outside quotes and `{…}`, and whether it closed itself.
function tagEnd(source: string, from: number): { readonly end: number; readonly selfClosing: boolean } | undefined {
  let braces = 0;
  for (let index = from; index < source.length; index += 1) {
    const char = source.charAt(index);
    if (char === '"' || char === "'" || char === '`') {
      const close = source.indexOf(char, index + 1);
      if (close < 0) {
        return undefined;
      }
      index = close;
    } else if (char === '{') {
      braces += 1;
    } else if (char === '}') {
      braces = Math.max(0, braces - 1);
    } else if (char === '>' && braces === 0) {
      return { end: index + 1, selfClosing: source.slice(from, index).trimEnd().endsWith('/') };
    }
  }
  return undefined;
}

/**
 * What deleting a node on the canvas takes (shared/engine/planTree.ts, removalRange): the node with the comment that
 * labels it, and the whitespace before it; when nothing but the node is on its line start, the whitespace after it
 * through the first line break, so no blank line is left; otherwise the node alone.
 */
export function removalRange(source: string, start: number, end: number): { readonly start: number; readonly end: number } {
  assert(start >= 0, 'A removal starts inside the text');
  assert(end <= source.length, 'A removal ends inside the text');
  let first = start;
  const gap = whitespaceBefore(source, start);
  if (source.slice(0, gap).endsWith('-->')) {
    const open = source.lastIndexOf('<!--', gap - 3);
    if (open >= 0) {
      first = open;
    }
  }
  const before = whitespaceBefore(source, first);
  if (before < first) {
    return { start: before, end };
  }
  let after = end;
  while (after < source.length && /[ \t\r]/.test(source.charAt(after))) {
    after += 1;
  }
  if (source.charAt(after) === '\n') {
    return { start: first, end: after + 1 };
  }
  return { start: first, end };
}

function whitespaceBefore(source: string, position: number): number {
  let index = position;
  while (index > 0 && /\s/.test(source.charAt(index - 1))) {
    index -= 1;
  }
  return index;
}

function namesValue(name: string, analysis: CodeAnalysis): boolean {
  if (analysis.qualified.has(name)) {
    return true;
  }
  const head = name.split('.')[0] ?? '';
  return name.includes('.') && analysis.bindings.has(head);
}

function attributeMentions(attribute: AttributeNode, analysis: CodeAnalysis): boolean {
  switch (attribute.kind) {
    case 'expression':
    case 'spread':
    case 'shorthand':
    case 'template-literal':
      return mentionsAny(attribute.kind === 'shorthand' ? attribute.name : attribute.value, analysis);
    case 'quoted':
    case 'empty':
      return false;
    default: {
      const exhaustive: never = attribute.kind;
      return exhaustive;
    }
  }
}

function mentionsAny(code: string, analysis: CodeAnalysis): boolean {
  for (const name of [...analysis.bindings, ...analysis.qualified]) {
    if (new RegExp(`(^|[^\\w$.])${escapeRegExp(name)}(?![\\w$])`).test(code)) {
      return true;
    }
  }
  return false;
}

// ----- MDX and Markdown -----

function planMdx(file: string, source: string, context: Context): FileOutcome {
  const edits: Edit[] = [];
  const reviews: Review[] = [...layoutReviews(file, source, context)];
  const bindings = new Set<string>();
  const qualified = new Set<string>();
  let imports = 0;
  const statements = /^import\b[^\n]*?(?:from\s*)?(['"])[^'"\n]+\1[^\n]*$/gm;
  let body = source;
  for (const match of source.matchAll(statements)) {
    const analysis = analyzeCode(file, match[0], match.index, context);
    if (!analysis.readable) {
      return unreadable(source, context);
    }
    edits.push(...analysis.edits);
    reviews.push(...analysis.reviews);
    imports += analysis.imports;
    analysis.bindings.forEach((name) => bindings.add(name));
    analysis.qualified.forEach((name) => qualified.add(name));
    body = body.slice(0, match.index) + ' '.repeat(match[0].length) + body.slice(match.index + match[0].length);
  }
  // An instance in Markdown is prose and JSX at once; it is never rewritten here, only listed.
  for (const name of [...bindings, ...qualified]) {
    const use = new RegExp(`(^|[^\\w$.])${escapeRegExp(name)}(?![\\w$])`, 'm').exec(body);
    if (use !== null) {
      reviews.push({ kind: 'content', offset: use.index + (use[1]?.length ?? 0) });
    }
  }
  const after = reviews.length === 0 ? applyEdits(source, mergeEdits(edits)) : source;
  return { after, instances: 0, imports, reviews };
}

function layoutReviews(file: string, source: string, context: Context): readonly Review[] {
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source);
  if (block === null) {
    return [];
  }
  const line = /^layout:\s*['"]?([^'"\s]+)/m.exec(block[1] ?? '');
  if (line === null) {
    return [];
  }
  const resolved = resolveSpecifier(line[1] ?? '', file, context);
  return resolved?.kind === 'target' ? [{ kind: 'layout', offset: block[0].indexOf(line[0]) }] : [];
}

// ----- code -----

/**
 * The imports and re-exports of a code region that reach a target, read by the TypeScript parser. `kind` is where the
 * code lives: in an .astro frontmatter a re-export is a review (Astro pages do not re-export), in a code file the export
 * of a target is the barrel's own and goes.
 */
function analyzeCode(file: string, code: string, offset: number, context: Context, kind: 'astro' | 'code' = 'code'): CodeAnalysis {
  const empty = { readable: true, edits: [], bindings: new Set<string>(), qualified: new Set<string>(), imports: 0, reviews: [] };
  if (!/\b(?:import|export|require|glob)\b/.test(code)) {
    return empty;
  }
  const tsx = /\.(?:[jt]sx|js|mjs|cjs)$/.test(file);
  const fileName = tsx ? 'source.tsx' : 'source.ts';
  const diagnostics =
    ts.transpileModule(code, {
      reportDiagnostics: true,
      fileName,
      compilerOptions: { jsx: ts.JsxEmit.Preserve, target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
    }).diagnostics ?? [];
  if (diagnostics.length > 0) {
    return { ...empty, readable: false };
  }
  const syntax = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true, tsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const edits: Edit[] = [];
  const reviews: Review[] = [];
  const bindings = new Set<string>();
  const qualified = new Set<string>();
  let imports = 0;
  for (const statement of syntax.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const resolved = resolveSpecifier(statement.moduleSpecifier.text, file, context);
      if (resolved !== undefined) {
        const plan = importEdit(code, offset, statement, resolved, syntax);
        plan.bindings.forEach((name) => bindings.add(name));
        plan.qualified.forEach((name) => qualified.add(name));
        if (plan.edit !== undefined) {
          edits.push(plan.edit);
          imports += 1;
        }
      }
    } else if (ts.isExportDeclaration(statement) && statement.moduleSpecifier !== undefined && ts.isStringLiteral(statement.moduleSpecifier)) {
      const resolved = resolveSpecifier(statement.moduleSpecifier.text, file, context);
      const edit = resolved === undefined ? undefined : exportEdit(code, offset, statement, resolved, syntax, kind);
      if (edit === 'review') {
        reviews.push({ kind: 're-export', offset: offset + statement.getStart(syntax) });
      } else if (edit !== undefined) {
        edits.push(edit);
        imports += 1;
      }
    }
  }
  reviews.push(...callReviews(file, syntax, offset, context));
  assert(edits.length <= syntax.statements.length, 'At most one edit per statement');
  return { readable: true, edits, bindings, qualified, imports, reviews };
}

interface ImportPlan {
  readonly edit: Edit | undefined;
  readonly bindings: ReadonlySet<string>;
  readonly qualified: ReadonlySet<string>;
}

// One import statement: the names that stand for the component, and the statement without them.
function importEdit(code: string, offset: number, statement: ts.ImportDeclaration, resolved: NonNullable<Resolution>, syntax: ts.SourceFile): ImportPlan {
  const clause = statement.importClause;
  const whole = { ...statementRange(code, statement, syntax), text: '' };
  const shift = (edit: Edit): Edit => ({ start: edit.start + offset, end: edit.end + offset, text: edit.text });
  if (clause === undefined) {
    // `import './Div.astro'`: a side-effect import of the file, or of the barrel that re-exports it, which stays.
    return { edit: resolved.kind === 'target' ? shift(whole) : undefined, bindings: new Set(), qualified: new Set() };
  }
  const bindings = new Set<string>();
  const qualified = new Set<string>();
  const kept: string[] = [];
  const named = clause.namedBindings;
  const component = (exported: string): boolean => (resolved.kind === 'target' ? exported === 'default' : resolved.names.has(exported));
  let defaultKept: string | undefined;
  if (clause.name !== undefined) {
    if (component('default')) {
      bindings.add(clause.name.text);
    } else {
      defaultKept = clause.name.getText(syntax);
    }
  }
  if (named !== undefined && ts.isNamespaceImport(named)) {
    if (resolved.kind === 'target') {
      // `import * as Div from './Div.astro'`: `Div.default` is the component; any use of `Div` refuses.
      bindings.add(named.name.text);
    } else {
      resolved.names.forEach((name) => qualified.add(`${named.name.text}.${name}`));
      kept.push(named.getText(syntax));
    }
  } else if (named !== undefined) {
    const elements: string[] = [];
    for (const element of named.elements) {
      const exported = (element.propertyName ?? element.name).text;
      if (component(exported)) {
        bindings.add(element.name.text);
      } else {
        elements.push(element.getText(syntax));
      }
    }
    if (elements.length > 0) {
      kept.push(`{ ${elements.join(', ')} }`);
    }
  }
  if (bindings.size === 0) {
    return { edit: undefined, bindings, qualified };
  }
  const parts = [...(defaultKept === undefined ? [] : [defaultKept]), ...kept];
  if (parts.length === 0) {
    return { edit: shift(whole), bindings, qualified };
  }
  const prefix = clause.isTypeOnly ? 'type ' : '';
  return { edit: shift({ start: clause.getStart(syntax), end: clause.getEnd(), text: `${prefix}${parts.join(', ')}` }), bindings, qualified };
}

// One `export … from` statement: a barrel's export of a target goes; anything that passes a barrel's name on refuses.
function exportEdit(
  code: string,
  offset: number,
  statement: ts.ExportDeclaration,
  resolved: NonNullable<Resolution>,
  syntax: ts.SourceFile,
  kind: 'astro' | 'code',
): Edit | 'review' | undefined {
  const clause = statement.exportClause;
  if (resolved.kind === 'barrel') {
    if (clause === undefined || ts.isNamespaceExport(clause)) {
      return 'review';
    }
    return clause.elements.some((element) => resolved.names.has((element.propertyName ?? element.name).text)) ? 'review' : undefined;
  }
  if (kind === 'astro') {
    return 'review';
  }
  if (clause === undefined) {
    // `export * from './Div.astro'` re-exports nothing an .astro file has but its default, which `*` leaves out.
    return { ...statementRange(code, statement, syntax), text: '' };
  }
  if (ts.isNamespaceExport(clause)) {
    return 'review';
  }
  const kept = clause.elements.filter((element) => (element.propertyName ?? element.name).text !== 'default').map((element) => element.getText(syntax));
  if (kept.length === clause.elements.length) {
    return undefined;
  }
  const edit =
    kept.length === 0
      ? { ...statementRange(code, statement, syntax), text: '' }
      : { start: clause.getStart(syntax), end: clause.getEnd(), text: `{ ${kept.join(', ')} }` };
  return { start: edit.start + offset, end: edit.end + offset, text: edit.text };
}

// Dynamic imports, `require()` and glob patterns that reach a target: none of them can be rewritten safely.
function callReviews(file: string, syntax: ts.SourceFile, offset: number, context: Context): readonly Review[] {
  const reviews: Review[] = [];
  const pending: ts.Node[] = [syntax];
  for (let visited = 0; pending.length > 0; visited += 1) {
    assert(visited <= COMPONENT_REMOVAL_PLAN_LIMITS.nodesMax, 'A code walk is bounded');
    const node = pending.pop();
    assert(node !== undefined, 'A non-empty list has a last entry');
    node.forEachChild((child) => {
      pending.push(child);
    });
    if (!ts.isCallExpression(node)) {
      continue;
    }
    const argument = node.arguments[0];
    if (argument === undefined) {
      continue;
    }
    const dynamic = node.expression.kind === ts.SyntaxKind.ImportKeyword;
    const required = ts.isIdentifier(node.expression) && node.expression.text === 'require';
    if (dynamic || required) {
      if (ts.isStringLiteralLike(argument) && resolveSpecifier(argument.text, file, context) !== undefined) {
        reviews.push({ kind: 'dynamic-import', offset: offset + node.getStart(syntax) });
      }
      continue;
    }
    if (isGlobCall(node) && globPatterns(argument).some((pattern) => globMatchesTarget(pattern, file, context))) {
      reviews.push({ kind: 'glob', offset: offset + node.getStart(syntax) });
    }
  }
  return reviews;
}

function isGlobCall(node: ts.CallExpression): boolean {
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'glob') {
    return false;
  }
  if (ts.isIdentifier(callee.expression)) {
    return callee.expression.text === 'Astro';
  }
  return ts.isMetaProperty(callee.expression) && callee.expression.keywordToken === ts.SyntaxKind.ImportKeyword;
}

function globPatterns(argument: ts.Expression): readonly string[] {
  if (ts.isStringLiteralLike(argument)) {
    return [argument.text];
  }
  if (ts.isArrayLiteralExpression(argument)) {
    return argument.elements.flatMap((element) => (ts.isStringLiteralLike(element) ? [element.text] : []));
  }
  return [];
}

/** Whether a glob pattern, as Vite reads it from `file` (`/` is the project root), matches a target. */
export function globMatchesTarget(pattern: string, file: string, context: Pick<Context, 'root' | 'targets'>): boolean {
  if (pattern.startsWith('!')) {
    return false;
  }
  const base = pattern.startsWith('/') ? context.root : path.dirname(file);
  const absolute = toPosix(path.resolve(base, pattern.startsWith('/') ? `.${pattern}` : pattern));
  const expression = globExpression(absolute);
  return context.targets.some((target) => expression.test(toPosix(target)));
}

function globExpression(pattern: string): RegExp {
  let source = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern.charAt(index);
    if (char === '*' && pattern.charAt(index + 1) === '*') {
      source += '.*';
      index += pattern.charAt(index + 2) === '/' ? 2 : 1;
    } else if (char === '*') {
      source += '[^/]*';
    } else if (char === '?') {
      source += '[^/]';
    } else if (char === '{') {
      source += '(?:';
    } else if (char === '}') {
      source += ')';
    } else if (char === ',') {
      source += '|';
    } else {
      source += escapeRegExp(char);
    }
  }
  return new RegExp(`^${source}$`, process.platform === 'win32' ? 'i' : '');
}

// Every identifier that names the component outside its own import: a use as a value, which no rewrite can keep working.
function valueUsesInCode(code: string, offset: number, analysis: CodeAnalysis, file: string): readonly Review[] {
  const reviews: Review[] = [];
  const tsx = /\.(?:[jt]sx|js|mjs|cjs)$/.test(file);
  const syntax = ts.createSourceFile(tsx ? 'source.tsx' : 'source.ts', code, ts.ScriptTarget.Latest, true, tsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const heads = new Set([...analysis.qualified].map((name) => name.split('.')[0] ?? ''));
  const pending: ts.Node[] = [...syntax.statements.filter((statement) => !ts.isImportDeclaration(statement))];
  for (let visited = 0; pending.length > 0; visited += 1) {
    assert(visited <= COMPONENT_REMOVAL_PLAN_LIMITS.nodesMax, 'A code walk is bounded');
    const node = pending.pop();
    assert(node !== undefined, 'A non-empty list has a last entry');
    node.forEachChild((child) => {
      pending.push(child);
    });
    if (ts.isIdentifier(node) && analysis.bindings.has(node.text) && isValueIdentifier(node)) {
      reviews.push({ kind: 'value', offset: offset + node.getStart(syntax) });
    }
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && heads.has(node.expression.text)) {
      if (analysis.qualified.has(`${node.expression.text}.${node.name.text}`)) {
        reviews.push({ kind: 'value', offset: offset + node.getStart(syntax) });
      }
    }
  }
  return reviews;
}

function isValueIdentifier(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) {
    return false;
  }
  if (ts.isQualifiedName(parent) && parent.right === node) {
    return false;
  }
  if (
    (ts.isPropertyAssignment(parent) || ts.isPropertySignature(parent) || ts.isPropertyDeclaration(parent) || ts.isMethodDeclaration(parent)) &&
    parent.name === node
  ) {
    return false;
  }
  return !(ts.isBindingElement(parent) && parent.propertyName === node);
}

// ----- barrels and specifiers -----

// Index files that re-export a target (`export { default as Div } from './Div.astro'`), with the names they use.
function findBarrels(read: ReadonlyMap<string, string>, context: Context): ReadonlyMap<string, ReadonlySet<string>> {
  const barrels = new Map<string, ReadonlySet<string>>();
  for (const [file, source] of read) {
    if (!CODE_FILE.test(file) || !source.includes('export')) {
      continue;
    }
    const syntax = ts.createSourceFile('source.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const names = new Set<string>();
    for (const statement of syntax.statements) {
      if (!ts.isExportDeclaration(statement) || statement.moduleSpecifier === undefined || !ts.isStringLiteral(statement.moduleSpecifier)) {
        continue;
      }
      if (resolveSpecifier(statement.moduleSpecifier.text, file, context)?.kind !== 'target') {
        continue;
      }
      const clause = statement.exportClause;
      if (clause !== undefined && ts.isNamedExports(clause)) {
        for (const element of clause.elements) {
          if ((element.propertyName ?? element.name).text === 'default') {
            names.add(element.name.text);
          }
        }
      }
    }
    if (names.size > 0) {
      barrels.set(comparablePath(file), names);
    }
  }
  return barrels;
}

function needlesOf(targets: readonly string[], barrels: ReadonlyMap<string, ReadonlySet<string>>): readonly string[] {
  const needles = new Set<string>(['glob']);
  for (const target of targets) {
    needles.add(path.basename(target, '.astro'));
  }
  for (const [barrel, names] of barrels) {
    const stem = path.basename(barrel).replace(/\.[^.]+$/, '');
    needles.add(stem === 'index' ? path.basename(path.dirname(barrel)) : stem);
    names.forEach((name) => needles.add(name));
  }
  return [...needles].filter((needle) => needle.length > 0);
}

/** What a module specifier written in `file` reaches: a target, a barrel of one, or neither. */
function resolveSpecifier(specifier: string, file: string, context: Context): Resolution {
  const cut = specifier.search(/[?#]/);
  const bare = cut < 0 ? specifier : specifier.slice(0, cut);
  let barrel: ReadonlySet<string> | undefined;
  for (const base of resolveSpec(bare, file, context.aliases)) {
    for (const candidate of candidatesOf(base)) {
      const key = comparablePath(candidate);
      if (context.targetKeys.has(key)) {
        return { kind: 'target' };
      }
      barrel = barrel ?? context.barrels.get(key);
    }
  }
  return barrel === undefined ? undefined : { kind: 'barrel', names: barrel };
}

function candidatesOf(base: string): readonly string[] {
  if (/\.[A-Za-z]+$/.test(path.basename(base))) {
    return [base];
  }
  return [base, ...EXTENSIONS.map((extension) => `${base}${extension}`), ...EXTENSIONS.map((extension) => path.join(base, `index${extension}`))];
}

// ----- text helpers -----

// A statement with its indentation and the line break after it, so taking it out leaves no blank line.
function statementRange(code: string, statement: ts.Statement, syntax: ts.SourceFile): { readonly start: number; readonly end: number } {
  let start = statement.getStart(syntax);
  while (start > 0 && /[ \t]/.test(code.charAt(start - 1))) {
    start -= 1;
  }
  let end = statement.getEnd();
  while (end < code.length && /[ \t]/.test(code.charAt(end))) {
    end += 1;
  }
  if (code.startsWith('\r\n', end)) {
    end += 2;
  } else if (code.charAt(end) === '\n') {
    end += 1;
  } else if (code.slice(0, start).endsWith('\r\n')) {
    // The region's last line: its break before goes instead, as the fence's own break follows.
    start -= 2;
  } else if (code.charAt(start - 1) === '\n') {
    start -= 1;
  }
  return { start, end };
}

/** Overlapping or touching removals become one, so applying them never cuts a span twice. */
function mergeEdits(edits: readonly Edit[]): readonly Edit[] {
  const ordered = [...edits].sort((left, right) => left.start - right.start);
  const merged: Edit[] = [];
  for (const edit of ordered) {
    const last = merged[merged.length - 1];
    if (last !== undefined && edit.start < last.end) {
      assert(last.text === '', 'Only removals overlap');
      assert(edit.text === '', 'Only removals overlap');
      merged[merged.length - 1] = { start: last.start, end: Math.max(last.end, edit.end), text: '' };
    } else {
      merged.push(edit);
    }
  }
  return merged;
}

/** The edits applied from the end, so earlier offsets stay true. */
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

// The post-edit check: what would be written must parse as cleanly as the file did.
function reparses(file: string, after: string): boolean {
  if (file.endsWith('.astro')) {
    const fence = ASTRO_FENCE.exec(after);
    return parseAstroTemplate(after).ok && transpiles(fence?.[2] ?? '', 'source.ts');
  }
  if (CODE_FILE.test(file)) {
    return transpiles(after, /\.(?:[jt]sx|js|mjs|cjs)$/.test(file) ? 'source.tsx' : 'source.ts');
  }
  return true;
}

function transpiles(code: string, fileName: string): boolean {
  const result = ts.transpileModule(code, {
    reportDiagnostics: true,
    fileName,
    compilerOptions: { jsx: ts.JsxEmit.Preserve, target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
  });
  return (result.diagnostics ?? []).length === 0;
}

// A file that does not parse: a review where it names a target, left alone where it does not.
function unreadable(source: string, context: Context): FileOutcome {
  const names = context.targets.map((target) => path.basename(target));
  const at = names.map((name) => source.indexOf(name)).find((index) => index >= 0);
  return { after: source, instances: 0, imports: 0, reviews: at === undefined ? [] : [{ kind: 'unreadable', offset: at }] };
}

/** The Astro parser's UTF-8 byte offsets as UTF-16 offsets into `source`, for any number of lookups on one file. */
function utf8Offsets(source: string): (bytes: number) => number {
  const encoded = Buffer.from(source, 'utf8');
  if (encoded.length === source.length) {
    return (bytes) => bytes;
  }
  return (bytes) => {
    assert(bytes <= encoded.length, 'An Astro position is inside the file');
    return encoded.subarray(0, bytes).toString('utf8').length;
  };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function toPosix(file: string): string {
  return file.split(path.sep).join('/');
}

function failure(code: ComponentOpError['code'], message: string): Result<never, ComponentOpError> {
  return err({ code, message });
}
