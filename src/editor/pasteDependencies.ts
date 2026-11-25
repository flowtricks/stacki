// What a piece of markup needs when it is pasted (or duplicated, or dropped) into another file,
// and how it gets it: the context-aware paste.
//
// Markup is not only markup. `<div class="stat_wrap">{title}<Button/></div>` copied from inside
// a component reads `title` from that component's props, renders `Button` through its import
// and is styled by its scoped `<style>`. Pasted into a page body as bare markup it names three
// things the page does not have, and the page stops compiling or throws while rendering. The
// person did nothing wrong; the paste did.
//
// So a paste across files carries the markup's dependency closure:
//
// 1. Imports the markup uses, components and helpers (the host rebases relative specifiers for
//    the target folder and keeps the target's alias style). An import the target already has,
//    same name and module, is reused; one whose name the target binds otherwise is renamed.
// 2. Frontmatter the markup reads, transitively and in source order: the scope reader shared
//    with "Create component" (extractFrontmatter.ts readStatements) says what each statement
//    binds and reads, so a shadowing callback parameter or a word in a string is not a read.
//    Only code that means the same in the target is copied: literals, objects, arrays, plain
//    functions, content-collection reads. A name the target already binds is renamed in the
//    copied code and in the markup.
// 3. Props. `const { title, items } = Astro.props` means "what the instance passes", and a page
//    is nobody's instance. Each prop the markup reads becomes a `const` with the prop's default
//    when the destructure gives a self-contained one, or a placeholder (`[]` for a list, `''`
//    otherwise) that the summary names, so nothing is left undefined. `Astro.props.x` in the
//    markup is read the same way.
// 4. `<slot />` means nothing outside a component: in a page it is replaced by its fallback
//    content, and the summary says so.
// 5. The scoped `<style>` rules that style the copy (pasteStyles.ts), and `define:vars`.
//
// What cannot be copied safely is never copied silently: a statement that waits on a request,
// runs for its effect, reads `Astro.request`/`Astro.locals`, `import.meta` or `process.env`,
// or is changed by other code. The plan is then a choice, put to the person in plain words by
// the host: paste a component instance, paste the markup with values filled in (each such value
// becomes a placeholder, named in the summary), or cancel.
//
// Inside one file nothing changes: every name the markup reads is already there.
//
// Pure: no I/O, no clock. The host reads the clipboard, rebases import specifiers and writes.

import { assert } from '../../shared/core/assert';
import { LIMITS } from '../../shared/core/limits';
import type { ImportDecl } from '../../shared/page/pageNode';
import { readModuleScope, type JsAnalysis } from '../../shared/engine/jsScope';
import { renamedFrontmatter } from '../../shared/engine/variableRename';
import { readStatements, type FrontmatterStatement } from './extractFrontmatter';
import { parseDestructures } from './dataSource';
import { identifiersIn, namesUsedIn } from './frontmatterMove';
import { renamedLoopVar } from './loopBindings';
import type { EditorNode } from './pageView';
import { carriedStyles, styleSubjectOf, type CarriedStyles, type PasteStyleSource } from './pasteStyles';

export type PasteFileRole = 'page' | 'component';

/** The file the markup was copied from, as it was at copy time. */
export interface PasteSource {
  readonly path: string | undefined;
  readonly role: PasteFileRole;
  /** The component's name, when the source is a component: what option (a) inserts. */
  readonly componentName: string | undefined;
  readonly frontmatter: string;
  readonly imports: readonly ImportDecl[];
  readonly styles: readonly PasteStyleSource[];
  /** Whether the copied node is the component's only rendered root, so an instance renders just it. */
  readonly copiedRoot: boolean;
}

/** The file being pasted into, as shown now. */
export interface PasteTarget {
  readonly path: string | undefined;
  readonly role: PasteFileRole;
  readonly frontmatter: string;
  readonly imports: readonly ImportDecl[];
  /** The CSS of every `<style>` the target already has: carried rules it holds are not written twice. */
  readonly styles: readonly string[];
}

/** One thing a paste did beyond placing the markup, for the summary's "What changed". */
export type PasteChange =
  | { readonly kind: 'import'; readonly name: string; readonly path: string }
  | { readonly kind: 'variable'; readonly name: string }
  | { readonly kind: 'prop-default'; readonly name: string; readonly value: string }
  | { readonly kind: 'prop-placeholder'; readonly name: string; readonly value: string }
  | { readonly kind: 'filled'; readonly name: string; readonly value: string }
  | { readonly kind: 'renamed'; readonly from: string; readonly to: string }
  | { readonly kind: 'slot'; readonly count: number }
  | { readonly kind: 'style'; readonly selector: string }
  | { readonly kind: 'style-left'; readonly selector: string };

/** Why a statement the markup reads cannot be copied; the host words it for a designer. */
export type PasteBlockReason = 'awaits' | 'effect' | 'exported' | 'astro' | 'import-meta' | 'environment' | 'changed' | 'volatile' | 'unreadable';

export interface PasteBlocker {
  readonly name: string;
  readonly reason: PasteBlockReason;
}

/** What the target gains so the markup works there. Import paths are still the source's. */
export interface PasteBundle {
  readonly node: EditorNode;
  readonly imports: readonly ImportDecl[];
  /** Statements for the end of the target's frontmatter, in dependency order. */
  readonly statements: readonly string[];
  readonly styles: CarriedStyles;
  readonly changes: readonly PasteChange[];
}

export type PastePlan =
  /** Same file: today's paste, nothing to bring. */
  | { readonly kind: 'same-file' }
  | { readonly kind: 'ready'; readonly bundle: PasteBundle }
  /**
   * Some of what the markup reads cannot be copied. `filled` is the bundle with those values
   * filled in as placeholders; `instance` is the source component, when pasting one of it is
   * an option (the source is a component and the target is another file).
   */
  | {
      readonly kind: 'choose';
      readonly blockers: readonly PasteBlocker[];
      readonly filled: PasteBundle;
      readonly instance: { readonly name: string; readonly recommended: boolean } | undefined;
    };

/** The plan for pasting `node`, copied from `source`, into `target`. */
export function planPaste(node: EditorNode, source: PasteSource, target: PasteTarget): PastePlan {
  if (source.path !== undefined && source.path === target.path) {
    return { kind: 'same-file' };
  }
  const read = readSource(source);
  const walk = dependencyWalk(node, source, read);
  const bundle = bundleOf({ node, source, target, read, walk, fill: walk.blockers.map((blocker) => blocker.name) });
  assert(
    bundle.statements.every((statement) => statement.trim() !== ''),
    'Every carried statement has code',
  );
  if (walk.blockers.length === 0) {
    return { kind: 'ready', bundle };
  }
  const instance =
    source.role === 'component' && source.componentName !== undefined ? { name: source.componentName, recommended: source.copiedRoot } : undefined;
  assert(
    bundle.changes.some((change) => change.kind === 'filled'),
    'A filled bundle names what it filled',
  );
  return { kind: 'choose', blockers: walk.blockers, filled: bundle, instance };
}

// --- Reading the source ----------------------------------------------------------------

interface SourceRead {
  /** The frontmatter the statements' offsets index. */
  readonly code: string;
  readonly valid: boolean;
  readonly statements: readonly FrontmatterStatement[];
  readonly declaredBy: ReadonlyMap<string, readonly number[]>;
  readonly typesDeclaredBy: ReadonlyMap<string, readonly number[]>;
  /** Props the source reads off `Astro.props`, with the default its destructure gives. */
  readonly props: ReadonlyMap<string, string | undefined>;
}

function readSource(source: PasteSource): SourceRead {
  const analysis: JsAnalysis = readModuleScope(source.frontmatter);
  const statements = analysis.valid ? readStatements(source.frontmatter, analysis) : [];
  const props = new Map<string, string | undefined>();
  for (const destructure of parseDestructures(source.frontmatter)) {
    if (destructure.from.replace(/\s+/g, '') === 'Astro.props') {
      props.set(destructure.name, destructure.defaultText);
    }
  }
  return {
    code: source.frontmatter,
    valid: analysis.valid,
    statements,
    declaredBy: indexed(statements, (statement) => statement.declares),
    typesDeclaredBy: indexed(statements, (statement) => statement.typeNames),
    props,
  };
}

function indexed(statements: readonly FrontmatterStatement[], keys: (statement: FrontmatterStatement) => readonly string[]): ReadonlyMap<string, number[]> {
  const index = new Map<string, number[]>();
  statements.forEach((statement, position) => {
    for (const key of new Set(keys(statement))) {
      index.set(key, [...(index.get(key) ?? []), position]);
    }
  });
  return index;
}

// --- Walking what the markup reads -----------------------------------------------------

interface Walk {
  readonly imports: ReadonlySet<string>;
  readonly statements: ReadonlySet<number>;
  /** Props the markup reads, in the order first read. */
  readonly props: readonly string[];
  readonly blockers: readonly PasteBlocker[];
}

// The members of `Astro` that answer the same in any file of the site. `slots` is here because a page has one
// too: `Astro.slots.has('x')` answers false there, which renders and never throws.
const PORTABLE_ASTRO_MEMBERS: ReadonlySet<string> = new Set(['slots', 'url', 'site', 'currentLocale', 'generator', 'preferredLocale', 'preferredLocaleList']);

const COLLECTION_READ = /\bawait\s+(getCollection|getEntry|getEntries)\s*\(/;

function dependencyWalk(node: EditorNode, source: PasteSource, read: SourceRead): Walk {
  const imports = new Set<string>();
  const statements = new Set<number>();
  const props: string[] = [];
  const blockers: PasteBlocker[] = [];
  const blocked = new Set<string>();
  const pending = [...markupReads(node, source)];
  const seen = new Set<string>();
  // Each name is visited once and the names are bounded by the code they come from.
  while (pending.length > 0) {
    assert(seen.size <= LIMITS.scanEntriesMax, 'dependencyWalk: names within limit');
    const name = pending.shift();
    assert(name !== undefined, 'A non-empty list has a first name');
    if (seen.has(name)) {
      continue;
    }
    seen.add(name);
    if (source.imports.some((entry) => entry.name === name)) {
      imports.add(name);
      continue;
    }
    if (read.props.has(name)) {
      props.push(name);
      continue;
    }
    const held = read.declaredBy.get(name);
    if (held === undefined) {
      if (!read.valid && declaredByText(source.frontmatter, name)) {
        blockers.push({ name, reason: 'unreadable' });
      }
      continue; // A global, or a loop's own parameter: the same wherever it is pasted.
    }
    for (const index of held) {
      const statement = read.statements[index];
      assert(statement !== undefined, 'An index points at a statement');
      const reason = blockReason(statement, read, index);
      if (reason !== undefined) {
        if (!blocked.has(name)) {
          blocked.add(name);
          blockers.push({ name, reason });
        }
        continue;
      }
      statements.add(index);
      pending.push(...statement.reads);
      addTypes(read, statement, { statements, imports, source });
    }
  }
  assert(
    props.every((prop) => read.props.has(prop)),
    'Every prop the walk found is a prop of the source',
  );
  return { imports, statements, props, blockers };
}

// Names the markup reads: the scope-generous reader of frontmatterMove.ts (a word that is no
// declaration is simply not found), component tags by their root, and `Astro.props.x`.
function markupReads(node: EditorNode, source: PasteSource): readonly string[] {
  const names = new Set<string>();
  for (const name of namesUsedIn([node])) {
    names.add(name.split('.')[0] ?? name);
  }
  for (const code of codeOf(node)) {
    for (const match of code.matchAll(/\bAstro\.props\.([A-Za-z_$][\w$]*)/g)) {
      const prop = match[1];
      if (prop !== undefined) {
        names.add(prop);
      }
    }
  }
  for (const style of source.styles) {
    if (style.defineVars !== undefined) {
      for (const name of identifiersIn(style.defineVars)) {
        names.add(name);
      }
    }
  }
  return [...names];
}

function blockReason(statement: FrontmatterStatement, read: SourceRead, index: number): PasteBlockReason | undefined {
  if (statement.kind === 'effect') {
    return 'effect';
  }
  if (statement.kind === 'export') {
    return 'exported';
  }
  for (const member of statement.astroMembers) {
    if (member === undefined || !PORTABLE_ASTRO_MEMBERS.has(member)) {
      return 'astro';
    }
  }
  if (statement.readsImportMeta) {
    return 'import-meta';
  }
  if (statement.reads.includes('process')) {
    return 'environment';
  }
  if (statement.volatile) {
    return 'volatile';
  }
  if (statement.awaits && !COLLECTION_READ.test(statementCode(statement, read))) {
    return 'awaits';
  }
  const changed = read.statements.some((other, position) => position !== index && other.writes.some((name) => statement.declares.includes(name)));
  return changed ? 'changed' : undefined;
}

// Types erase at build, so they never block; a type the carried code names comes with it.
function addTypes(
  read: SourceRead,
  statement: FrontmatterStatement,
  into: { readonly statements: Set<number>; readonly imports: Set<string>; readonly source: PasteSource },
): void {
  const pending = [...statement.typeReads];
  const seen = new Set<string>();
  while (pending.length > 0) {
    assert(seen.size <= LIMITS.scanEntriesMax, 'addTypes: names within limit');
    const name = pending.pop();
    assert(name !== undefined, 'A non-empty list has a last name');
    if (seen.has(name)) {
      continue;
    }
    seen.add(name);
    if (into.source.imports.some((entry) => entry.name === name)) {
      into.imports.add(name);
    }
    for (const index of read.typesDeclaredBy.get(name) ?? []) {
      const declared = read.statements[index];
      assert(declared !== undefined, 'An index points at a statement');
      into.statements.add(index);
      pending.push(...declared.typeReads);
    }
  }
}

// --- Building the bundle ---------------------------------------------------------------

interface BundleInput {
  readonly node: EditorNode;
  readonly source: PasteSource;
  readonly target: PasteTarget;
  readonly read: SourceRead;
  readonly walk: Walk;
  /** Names to fill in with a placeholder rather than copy. */
  readonly fill: readonly string[];
}

function bundleOf(input: BundleInput): PasteBundle {
  const { source, target, read, walk } = input;
  const changes: PasteChange[] = [];
  const taken = targetNames(target);
  const renames = new Map<string, string>();
  const rename = (name: string): string => {
    const to = freeName(name, taken);
    taken.add(to);
    if (to !== name) {
      renames.set(name, to);
      changes.push({ kind: 'renamed', from: name, to });
    }
    return to;
  };
  // Imports first: one the target has, same module, is the same thing and is reused.
  const imports: ImportDecl[] = [];
  for (const entry of source.imports) {
    if (walk.imports.has(entry.name)) {
      const same = target.imports.find((existing) => existing.name === entry.name);
      if (same === undefined || !sameImport(same, entry)) {
        const name = same === undefined && !taken.has(entry.name) ? entry.name : rename(entry.name);
        taken.add(name);
        imports.push({ ...entry, name, ...(entry.named === true && entry.imported === undefined ? { imported: entry.name } : {}) });
        changes.push({ kind: 'import', name, path: entry.path });
      }
    }
  }
  // Props and filled values: a const each, with a value that renders and never throws.
  const code = codeOf(input.node).join('\n');
  const declared: string[] = [];
  for (const prop of walk.props) {
    const given = read.props.get(prop);
    const portable = given !== undefined && selfContained(given);
    const value = portable ? given : placeholderFor(prop, code);
    const name = taken.has(prop) ? rename(prop) : prop;
    taken.add(name);
    declared.push(`const ${name} = ${value};`);
    changes.push(portable ? { kind: 'prop-default', name, value } : { kind: 'prop-placeholder', name, value });
  }
  for (const name of input.fill) {
    const value = placeholderFor(name, code);
    const local = taken.has(name) ? rename(name) : name;
    taken.add(local);
    declared.push(`const ${local} = ${value};`);
    changes.push({ kind: 'filled', name: local, value });
  }
  // Statements, in the order the source wrote them, deduped against the target word for word.
  const targetCode = target.frontmatter.replace(/\s+/g, ' ');
  const statements: string[] = [...declared];
  for (const index of [...walk.statements].sort((first, second) => first - second)) {
    const statement = read.statements[index];
    assert(statement !== undefined, 'An index points at a statement');
    const text = statementCode(statement, read);
    if (targetCode.includes(text.replace(/\s+/g, ' ').trim())) {
      continue; // The target already says exactly this.
    }
    for (const name of statement.declares) {
      if (taken.has(name) && !renames.has(name)) {
        rename(name);
      } else {
        taken.add(name);
      }
    }
    statements.push(text);
    if (statement.kind !== 'type') {
      for (const name of statement.declares) {
        changes.push({ kind: 'variable', name: renames.get(name) ?? name });
      }
    }
  }
  const renamedStatements = statements.map((text) => renamedCode(text, renames));
  const node = renamedNode(withoutSlots(withPropsRead(input.node), target.role, changes), renames);
  const styles = carriedStyles(source.styles, subjectOf(node), target.styles);
  changes.push(...styles.selectors.map((selector): PasteChange => ({ kind: 'style', selector })));
  changes.push(...styles.leftBehind.map((selector): PasteChange => ({ kind: 'style-left', selector })));
  assert(renamedStatements.length === statements.length, 'Renaming keeps every statement');
  return { node, imports, statements: renamedStatements, styles, changes };
}

// Every name the target binds at its top level, imports included: what a carried name must not collide with.
function targetNames(target: PasteTarget): Set<string> {
  const names = new Set(target.imports.map((entry) => entry.name));
  const analysis = readModuleScope(target.frontmatter);
  if (analysis.valid) {
    for (const name of analysis.root.names) {
      names.add(name);
    }
  } else {
    for (const name of identifiersIn(target.frontmatter)) {
      names.add(name); // Unreadable code may bind any word it holds.
    }
  }
  names.add('Astro');
  return names;
}

function sameImport(first: ImportDecl, second: ImportDecl): boolean {
  return (
    first.path === second.path && (first.named === true) === (second.named === true) && (first.imported ?? first.name) === (second.imported ?? second.name)
  );
}

/** `name`, or `name2`, `name3`, …: the first the target does not bind. */
export function freeName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name)) {
    return name;
  }
  const candidatesMax = taken.size + 2;
  for (let ordinal = 2; ordinal <= candidatesMax; ordinal++) {
    const candidate = `${name}${ordinal}`;
    if (!taken.has(candidate)) {
      return candidate;
    }
  }
  assert(false, 'freeName: a free name exists among taken.size + 1 candidates');
  return name;
}

function statementCode(statement: FrontmatterStatement, read: SourceRead): string {
  assert(read.statements.includes(statement), 'The statement belongs to the source read');
  assert(statement.to <= read.code.length, 'A statement lies inside the code it was read from');
  const text = read.code.slice(statement.from, statement.to).trim();
  return statement.declarator === undefined ? text : `${statement.declarator.keyword} ${text};`;
}

function renamedCode(text: string, renames: ReadonlyMap<string, string>): string {
  let out = text;
  for (const [from, to] of renames) {
    if (new RegExp(`(?<![\\w$])${from.replace(/\$/g, '\\$')}(?![\\w$])`).test(out)) {
      out = renamedFrontmatter(out, { from, to });
    }
  }
  return out;
}

function renamedNode(node: EditorNode, renames: ReadonlyMap<string, string>): EditorNode {
  let out = node;
  for (const [from, to] of renames) {
    const [renamed] = renamedLoopVar([out], from, to);
    assert(renamed !== undefined, 'Renaming keeps the node');
    out = renamedTags(renamed, from, to, 0);
  }
  return out;
}

// A component renamed on collision is renamed where it is rendered, too.
function renamedTags(node: EditorNode, from: string, to: string, depth: number): EditorNode {
  assert(depth <= LIMITS.treeDepthMax, 'renamedTags: depth within the tree cap');
  const own =
    node.kind === 'component' && (node.name === from || node.name.startsWith(`${from}.`)) ? { ...node, name: `${to}${node.name.slice(from.length)}` } : node;
  if (own.children === undefined) {
    return own;
  }
  return Object.assign({}, own, { children: own.children.map((child) => renamedTags(child, from, to, depth + 1)) });
}

// `Astro.props.title` → `title`, which the paste declares.
function withPropsRead(node: EditorNode): EditorNode {
  const rewrite = (code: string): string => code.replace(/\bAstro\.props\.([A-Za-z_$][\w$]*)/g, '$1');
  return mapped(node, 0, rewrite);
}

function mapped(node: EditorNode, depth: number, rewrite: (code: string) => string): EditorNode {
  assert(depth <= LIMITS.treeDepthMax, 'mapped: depth within the tree cap');
  let own: EditorNode = node;
  if (own.props !== undefined) {
    const props = Object.fromEntries(
      Object.entries(own.props).map(([key, value]) => [
        key,
        value.type === 'expr' || value.type === 'spread' ? { ...value, value: rewrite(value.value) } : value,
      ]),
    );
    own = { ...own, props };
  }
  if (own.kind === 'expr') {
    own = { ...own, value: rewrite(own.value) };
  } else if (own.kind === 'text') {
    own = { ...own, value: own.value.replace(/\{([^{}]*)\}/g, (_, inner: string) => `{${rewrite(inner)}}`) };
  } else if (own.kind === 'map') {
    own = { ...own, head: rewrite(own.head) };
  } else if (own.kind === 'cond') {
    own = { ...own, test: rewrite(own.test) };
  }
  if (own.children === undefined) {
    return own;
  }
  return Object.assign({}, own, { children: own.children.map((child) => mapped(child, depth + 1, rewrite)) });
}

// A `<slot>` outside a component renders nothing: in a page, its fallback content stands in.
function withoutSlots(node: EditorNode, role: PasteFileRole, changes: PasteChange[]): EditorNode {
  if (role === 'component') {
    return node;
  }
  let count = 0;
  const replaced = (list: readonly EditorNode[], depth: number): EditorNode[] => {
    assert(depth <= LIMITS.treeDepthMax, 'withoutSlots: depth within the tree cap');
    return list.flatMap((child) => {
      if (child.kind === 'element' && child.name === 'slot') {
        count += 1;
        return replaced(child.children ?? [], depth + 1);
      }
      return child.children === undefined ? [child] : [Object.assign({}, child, { children: replaced(child.children, depth + 1) })];
    });
  };
  const top = node.kind === 'element' && node.name === 'slot' ? node : undefined;
  const out = top === undefined ? (replaced([node], 0)[0] ?? node) : node;
  if (count > 0) {
    changes.push({ kind: 'slot', count });
  }
  return out;
}

/** The classes and ids written on `node` and every node inside it: what a selector can name of that markup. */
export function subjectOf(node: EditorNode): ReturnType<typeof styleSubjectOf> {
  const classes: string[] = [];
  const ids: string[] = [];
  const pending: EditorNode[] = [node];
  while (pending.length > 0) {
    assert(classes.length + ids.length <= LIMITS.treeNodesMax * 4, 'subjectOf: attributes within limit');
    const next = pending.pop();
    assert(next !== undefined, 'A non-empty list has a last node');
    for (const [key, value] of Object.entries(next.props ?? {})) {
      if (key === 'class' || key === 'className') {
        if (value.type === 'string') {
          classes.push(value.value);
        } else if (value.type === 'expr') {
          classes.push(...stringsIn(value.value));
        }
      } else if (key === 'class:list' && value.type === 'expr') {
        classes.push(...stringsIn(value.value), ...objectKeysIn(value.value));
      } else if (key === 'id' && value.type === 'string') {
        ids.push(value.value);
      }
    }
    pending.push(...(next.children ?? []));
  }
  return styleSubjectOf(classes, ids);
}

function stringsIn(code: string): readonly string[] {
  return [...code.matchAll(/(['"`])((?:(?!\1)[^\\$]|\\.)*)\1/g)].map((match) => match[2] ?? '');
}

function objectKeysIn(code: string): readonly string[] {
  return [...code.matchAll(/(?:^|[{,])\s*['"]?([-_a-zA-Z][\w-]*)['"]?\s*:/g)].map((match) => match[1] ?? '');
}

function codeOf(node: EditorNode): readonly string[] {
  const out: string[] = [];
  const pending: EditorNode[] = [node];
  while (pending.length > 0) {
    assert(out.length <= LIMITS.treeNodesMax * 8, 'codeOf: code pieces within limit');
    const next = pending.pop();
    assert(next !== undefined, 'A non-empty list has a last node');
    for (const value of Object.values(next.props ?? {})) {
      if (value.type === 'expr' || value.type === 'spread') {
        out.push(value.value);
      }
    }
    if (next.kind === 'expr' || next.kind === 'text') {
      out.push(next.value);
    } else if (next.kind === 'map') {
      out.push(next.head, ...(next.body ?? []));
    } else if (next.kind === 'cond') {
      out.push(next.test);
    }
    pending.push(...(next.children ?? []));
  }
  return out;
}

// A value that means the same anywhere: a literal, or an object or array of literals.
function selfContained(code: string): boolean {
  return code.trim() !== '' && identifiersIn(code).size === 0 && !/[`]/.test(code);
}

/** A value for an unknown that renders and does not throw where the markup uses it. */
export function placeholderFor(name: string, code: string): string {
  const escaped = name.replace(/\$/g, '\\$');
  if (new RegExp(`(?<![\\w$.])${escaped}\\s*\\??\\.\\s*(map|filter|forEach|slice|length|some|every|find|flatMap|reduce|sort|at|join)\\b`).test(code)) {
    return '[]';
  }
  if (new RegExp(`(?<![\\w$.])${escaped}\\s*\\??\\.`).test(code)) {
    return '{}';
  }
  return "''";
}

function declaredByText(code: string, name: string): boolean {
  return new RegExp(`\\b(const|let|var|function|class)\\s+[^;=]*\\b${name.replace(/\$/g, '\\$')}\\b`).test(code);
}
