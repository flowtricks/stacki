// What happens to the frontmatter a piece of a page reads when that piece becomes
// a component of its own.
//
// The piece reads values the page declares, and the page's scope does not follow
// it into a new file. By default the code that makes those values moves with the
// markup: the statement, whatever it needs in turn, and the imports under them.
// That is what someone means by "make this a component": the section and its
// data travel together, and the page stops holding things only the section used.
// When the page still needs a statement a copy stays, so both files have one.
//
// Moving code between files is only safe for code that means the same thing in
// both, so every value is judged. Each rule below errs one way: when in doubt the
// value is passed in as a prop, which is what extraction always did and is correct
// for any value; and a statement or import stays in the parent unless it is known
// to be unused there, because a copy too many costs a line while one too few is a
// ReferenceError that takes the whole page down.
//
// A section inside a loop is still one instance in the parent, at that spot. Its
// item is the loop's and reaches it as a prop. Frontmatter cannot read a loop item,
// so a moved statement needs no item, but it does run once per iteration, which is
// why work worth not repeating stays in the parent there.
//
// Names come from the scope readers (jsScope.ts, variableRename.ts), never from
// matching text, so a shadowing callback parameter or a word in a string is not a
// read. Reading is the expensive half and planning is cheap, so the dialog reads
// once and plans again on each change of a choice.

import { assert } from '../../shared/core/assert';
import type { ImportDecl, PageModel, PageNode } from '../../shared/page/pageNode';
import { issue, type Issue } from './issue';
import type { MessageKey } from '../../shared/properties/i18n/messageRef';
import { bindingScope, readModuleScope, readModuleStatements, type JsAnalysis, type JsStatement } from '../../shared/engine/jsScope';
import { mentions, readFile, type FileCode, type FileRead } from '../../shared/engine/variableRename';

/** What becomes of one value the piece reads. */
export type ExtractionValue =
  /** Its code moves into the component. `note` says so when the parent keeps a copy. */
  | { readonly kind: 'move'; readonly name: string; readonly note: string | undefined; readonly noteIssue?: Issue | undefined }
  /** The person chose to pass it in as a prop. */
  | { readonly kind: 'prop'; readonly name: string }
  /** It can only be passed in as a prop, for `reason`. */
  | { readonly kind: 'locked'; readonly name: string; readonly reason: string; readonly reasonIssue: Issue };

export interface ExtractionPlan {
  readonly values: readonly ExtractionValue[];
  /** The props of the new component, in the order the values are listed. */
  readonly props: readonly string[];
  /** What the new component's frontmatter gains; relative paths are still the parent's. */
  readonly moved: { readonly imports: readonly ImportDecl[]; readonly code: string };
  /** The parent's frontmatter once the moved code has left it. */
  readonly parent: { readonly imports: readonly ImportDecl[]; readonly extraFrontmatter: string };
}

/** What the parent is, for the words a reason is written in. */
export type ExtractionParent = 'page' | 'component';

export interface ExtractionInput {
  /** The file as saved, or undefined while an edit of it is still on its way. */
  readonly origin: (FileCode & { readonly model: Pick<PageModel, 'imports' | 'extraFrontmatter'> }) | undefined;
  readonly nodeId: string;
  /** The values the piece reads, by propsForExtraction: frontmatter names and loop items. */
  readonly names: readonly string[];
  readonly loopNames: ReadonlySet<string>;
  /** Whether a loop surrounds the piece, so it renders once per item. */
  readonly inLoop: boolean;
  readonly parent: ExtractionParent;
  /** The parent's frontmatter as shown, for a plan that changes nothing. */
  readonly shown: Pick<PageModel, 'imports' | 'extraFrontmatter'>;
}

/** The file as far as extraction cares; plan with `planExtraction`. */
export type ExtractionRead =
  | {
      readonly kind: 'unreadable';
      readonly names: readonly string[];
      readonly reason: string;
      readonly reasonIssue: Issue;
      readonly shown: Pick<PageModel, 'imports' | 'extraFrontmatter'>;
    }
  | { readonly kind: 'read'; readonly facts: ExtractionFacts };

// The members of `Astro` that answer the same in a component as in its page.
// Everything else is the file's own (`props`, `slots`, `self`), ends the page
// (`redirect`, `rewrite`), or finds files from where it is written (`glob`).
// `params` is here by the rule that route values are the page's to hand down.
const SHARED_ASTRO_MEMBERS: ReadonlySet<string> = new Set([
  'cookies',
  'currentLocale',
  'generator',
  'isPrerendered',
  'locals',
  'preferredLocale',
  'preferredLocaleList',
  'request',
  'routePattern',
  'site',
  'url',
]);

const PLAIN_DECLARATIONS: ReadonlySet<JsStatement['kind']> = new Set(['const', 'let', 'var']);

const ASTRO_MEMBER_RE = /^\s*\??\.\s*([\p{ID_Start}$_][\p{ID_Continue}$]*)/u;

interface Statement extends JsStatement {
  /** The top-level names it binds, values only. */
  readonly declares: readonly string[];
  /** Top-level names, imports and globals its code reads. */
  readonly reads: readonly string[];
  readonly typeReads: readonly string[];
  /** Top-level names its code changes. */
  readonly writes: readonly string[];
  /** Members of `Astro` it reads; `undefined` stands for `Astro` read whole. */
  readonly astroMembers: readonly (string | undefined)[];
}

export interface ExtractionFacts {
  readonly code: string;
  readonly imports: readonly ImportDecl[];
  readonly names: readonly string[];
  readonly loopNames: ReadonlySet<string>;
  readonly inLoop: boolean;
  readonly parent: ExtractionParent;
  readonly statements: readonly Statement[];
  /** Which statements bind a name; `var` may do so twice. */
  readonly declaredBy: ReadonlyMap<string, readonly number[]>;
  readonly typesDeclaredBy: ReadonlyMap<string, readonly number[]>;
  readonly exported: ReadonlySet<string>;
  /** What the template reads once the piece has gone. */
  readonly restReads: ReadonlySet<string>;
  /** Template code the reader could not follow once the piece has gone. */
  readonly restUnreadable: readonly string[];
  /** Names the template changes, piece included. */
  readonly templateWrites: ReadonlySet<string>;
  /** Names the piece's own markup reads, which its import may be all the parent had them for. */
  readonly pieceReads: ReadonlySet<string>;
}

// A reason is a whole sentence per parent ("on this page", "in the parent component"): the place is part of it, and its words change with the language.
type ReasonId =
  'needs' | 'changed' | 'exported' | 'otherCode' | 'astroWhole' | 'astroMember' | 'importMeta' | 'usesCaptured' | 'untraceable' | 'usedTwice' | 'copyStays';

const REASON_KEYS: Readonly<Record<ReasonId, Readonly<Record<ExtractionParent, MessageKey>>>> = {
  needs: { page: 'editor.extract.needs.page', component: 'editor.extract.needs.component' },
  changed: { page: 'editor.extract.changed.page', component: 'editor.extract.changed.component' },
  exported: { page: 'editor.extract.exported.page', component: 'editor.extract.exported.component' },
  otherCode: { page: 'editor.extract.otherCode.page', component: 'editor.extract.otherCode.component' },
  astroWhole: { page: 'editor.extract.astroWhole.page', component: 'editor.extract.astroWhole.component' },
  astroMember: { page: 'editor.extract.astroMember.page', component: 'editor.extract.astroMember.component' },
  importMeta: { page: 'editor.extract.importMeta.page', component: 'editor.extract.importMeta.component' },
  usesCaptured: { page: 'editor.extract.usesCaptured.page', component: 'editor.extract.usesCaptured.component' },
  untraceable: { page: 'editor.extract.untraceable.page', component: 'editor.extract.untraceable.component' },
  usedTwice: { page: 'editor.extract.usedTwice.page', component: 'editor.extract.usedTwice.component' },
  copyStays: { page: 'editor.extract.copyStays.page', component: 'editor.extract.copyStays.component' },
};

function reasonIn(facts: Pick<ExtractionFacts, 'parent'>, id: ReasonId, params?: Readonly<Record<string, string>>): Issue {
  return issue(REASON_KEYS[id][facts.parent], params);
}

/** Reads what extraction needs of the file, once per dialog. */
export function readExtraction(input: ExtractionInput): ExtractionRead {
  const unreadable = (reason: Issue): ExtractionRead => ({
    kind: 'unreadable',
    names: input.names,
    reason: reason.message,
    reasonIssue: reason,
    shown: input.shown,
  });
  const { origin } = input;
  if (origin === undefined) {
    return unreadable(issue('editor.extract.saving'));
  }
  if (origin.model.format !== undefined) {
    return unreadable(issue('editor.extract.astroOnly'));
  }
  const whole = readFile(origin);
  if (!whole.frontmatterValid) {
    return unreadable(issue('editor.extract.syntaxError'));
  }
  if (whole.partial) {
    return unreadable(issue('editor.extract.partial'));
  }
  const code = origin.model.extraFrontmatter;
  const analysis = readModuleScope(code);
  if (!analysis.valid) {
    return unreadable(issue('editor.extract.syntaxError'));
  }
  const rest = readFile(origin, { leaving: input.nodeId });
  const statements = readStatements(code, analysis);
  return { kind: 'read', facts: extractionFacts({ input, code, analysis, statements, whole, rest }) };
}

/** What the file becomes with `asProp` passed in as props and everything else moved. */
export function planExtraction(read: ExtractionRead, asProp: ReadonlySet<string>): ExtractionPlan {
  if (read.kind === 'unreadable') {
    return {
      values: read.names.map((name) => ({ kind: 'locked', name, reason: read.reason, reasonIssue: read.reasonIssue })),
      props: read.names,
      moved: { imports: [], code: '' },
      parent: { imports: read.shown.imports, extraFrontmatter: read.shown.extraFrontmatter },
    };
  }
  const { facts } = read;
  const locked = lockedValues(facts);
  const settled = settledChoices(facts, locked, asProp);
  const plan = writtenPlan(facts, settled, asProp);
  assert(plan.values.length === facts.names.length, 'Every value the piece reads is accounted for');
  assert(
    plan.values.every((value) => (value.kind === 'move') !== plan.props.includes(value.name)),
    'A value either moves or is a prop, never both',
  );
  return plan;
}

// --- Reading -----------------------------------------------------------------------------

// Filled in while the scopes are walked, and read-only from then on.
interface StatementParts {
  readonly declares: string[];
  readonly reads: string[];
  readonly typeReads: string[];
  readonly writes: string[];
  readonly astroMembers: (string | undefined)[];
}

function readStatements(code: string, analysis: JsAnalysis): readonly Statement[] {
  const statements = readModuleStatements(code);
  const parts = statements.map((): StatementParts => ({ declares: [], reads: [], typeReads: [], writes: [], astroMembers: [] }));
  const at = (position: number): StatementParts | undefined =>
    parts[statements.findIndex((statement) => statement.from <= position && position < statement.to)];
  for (const definition of analysis.definitions) {
    if (definition.scope === analysis.root) {
      at(definition.from)?.declares.push(definition.name);
    }
  }
  for (const reference of analysis.references) {
    const scope = bindingScope(reference.scope, reference.name);
    if (scope === undefined || scope === analysis.root) {
      const statement = at(reference.from);
      statement?.reads.push(reference.name);
      if (reference.written) {
        statement?.writes.push(reference.name);
      }
      if (reference.name === 'Astro') {
        statement?.astroMembers.push(ASTRO_MEMBER_RE.exec(code.slice(reference.to))?.[1]);
      }
    }
  }
  for (const read of analysis.typeReads) {
    at(read.from)?.typeReads.push(read.name);
  }
  return statements.map((statement, index) => {
    const own = parts[index];
    assert(own !== undefined, 'Every statement has its parts');
    return { ...statement, ...own };
  });
}

function extractionFacts(read: {
  readonly input: ExtractionInput;
  readonly code: string;
  readonly analysis: JsAnalysis;
  readonly statements: readonly Statement[];
  readonly whole: FileRead;
  readonly rest: FileRead;
}): ExtractionFacts {
  const { input, code, analysis, statements, whole, rest } = read;
  assert(input.origin !== undefined, 'Only a saved file is read');
  const imports = input.origin.model.imports;
  const piece = pieceNode(input.origin, input.nodeId);
  const section = pieceRange(piece);
  const templateUses = whole.uses.filter((use) => use.from >= whole.frontmatterEnd);
  const pieceUses = templateUses.filter((use) => section.from <= use.from && use.to <= section.to);
  // A tag is a read too: `const Heading = 'h2'` is needed by `<Heading>`.
  const pieceTags = piece === undefined ? [] : [...readFile({ source: input.origin.source, model: { ...input.origin.model, nodes: [piece] } }).tags];
  const pieceReads = new Set([...pieceUses.map((use) => use.name), ...pieceTags]);
  const declaredBy = indexed(statements, (statement) => statement.declares);
  const importNames = new Set(imports.map((entry) => entry.name));
  const pieceValues = [...pieceReads].filter((name) => declaredBy.has(name) && !importNames.has(name));
  return {
    code,
    imports,
    names: [...new Set([...input.names, ...pieceValues])],
    loopNames: new Set([...input.loopNames, ...(whole.around.get(input.nodeId) ?? [])]),
    inLoop: input.inLoop,
    parent: input.parent,
    statements,
    declaredBy,
    typesDeclaredBy: indexed(statements, (statement) => statement.typeNames),
    exported: analysis.exported,
    restReads: new Set([...rest.uses.filter((use) => use.from >= rest.frontmatterEnd).map((use) => use.name), ...rest.tags]),
    restUnreadable: rest.unreadable,
    templateWrites: new Set(templateUses.filter((use) => use.written).map((use) => use.name)),
    pieceReads,
  };
}

// Absent from the file as saved, a piece has no text, so it reads nothing there
// and everything stays in the parent.
function pieceNode(file: FileCode, nodeId: string): PageNode | undefined {
  const stack = [...file.model.nodes];
  // Every node of the tree is visited at most once, and the tree itself is bounded.
  while (stack.length > 0) {
    const node = stack.pop();
    assert(node !== undefined, 'A non-empty stack has a top');
    if (node.id === nodeId) {
      return node;
    }
    if ('children' in node) {
      stack.push(...(node.children ?? []));
    }
  }
  return undefined;
}

// A node without a range never gets here: `partial` refused the file first.
function pieceRange(piece: PageNode | undefined): { readonly from: number; readonly to: number } {
  if (piece === undefined) {
    return { from: 0, to: 0 };
  }
  assert(piece.start !== undefined, 'A readable node knows where it starts');
  assert(piece.end !== undefined, 'A readable node knows where it ends');
  return { from: piece.start, to: piece.end };
}

function indexed(statements: readonly Statement[], keys: (statement: Statement) => readonly string[]): ReadonlyMap<string, readonly number[]> {
  const index = new Map<string, number[]>();
  statements.forEach((statement, position) => {
    for (const key of new Set(keys(statement))) {
      index.set(key, [...(index.get(key) ?? []), position]);
    }
  });
  return index;
}

// --- Judging -----------------------------------------------------------------------------

type Closure =
  | { readonly kind: 'clear'; readonly statements: ReadonlySet<number>; readonly imports: ReadonlySet<string> }
  | { readonly kind: 'blocked'; readonly reason: Issue };

// What a value needs, walked from its name: each statement that binds a name it
// reads, and so on. A name that is a prop stops the walk, since the component has
// it from Astro.props. The walk visits each name once, so the names bound it.
function closureOf(facts: ExtractionFacts, name: string, props: ReadonlySet<string>): Closure {
  const statements = new Set<number>();
  const imports = new Set<string>();
  const seen = new Set<string>();
  const pending = [name];
  while (pending.length > 0) {
    const next = pending.pop();
    assert(next !== undefined, 'A non-empty list has a last name');
    if (seen.has(next)) {
      continue;
    }
    seen.add(next);
    if (next !== name && props.has(next)) {
      continue; // The component reads it off Astro.props.
    }
    const held = facts.declaredBy.get(next);
    if (held === undefined) {
      if (facts.imports.some((entry) => entry.name === next)) {
        imports.add(next);
      }
      continue; // A global means the same in both files.
    }
    for (const index of held) {
      const statement = facts.statements[index];
      assert(statement !== undefined, 'An index points at a statement');
      const reason = nameProblem(facts, next, index) ?? statementProblem(facts, statement) ?? sharedDeclaration(statement, next, props);
      if (reason !== undefined) {
        return { kind: 'blocked', reason: next === name ? reason : reasonIn(facts, 'needs', { name: next }) };
      }
      statements.add(index);
      pending.push(...statement.reads, ...writersOf(facts, next, index).flatMap((writer) => writer.declares));
      addTypes({ facts, statement, statements, imports });
    }
  }
  return { kind: 'clear', statements, imports };
}

// `const sorted = all.sort(byDate)` reorders `all` for everything after it, so
// wherever `all` goes that line has to go too, or `all` would read differently.
function writersOf(facts: ExtractionFacts, name: string, declaring: number): readonly Statement[] {
  return facts.statements.filter((statement, index) => index !== declaring && statement.writes.includes(name));
}

// A declaration runs once, where it stands, so it can travel with what it changes.
// A function changes it whenever it is called, and an effect is not moved at all.
function changesInPlace(statement: Statement): boolean {
  return PLAIN_DECLARATIONS.has(statement.kind) && !statement.callable;
}

// Types erase at build, so one that cannot come along stops nothing. It only
// leaves a name for the type checker to ask about.
function addTypes(walk: {
  readonly facts: ExtractionFacts;
  readonly statement: Statement;
  readonly statements: Set<number>;
  readonly imports: Set<string>;
}): void {
  const { facts, statement, statements, imports } = walk;
  const pending = [...statement.typeReads];
  const seen = new Set<string>();
  while (pending.length > 0) {
    const name = pending.pop();
    assert(name !== undefined, 'A non-empty list has a last name');
    if (seen.has(name)) {
      continue;
    }
    seen.add(name);
    if (facts.imports.some((entry) => entry.name === name)) {
      imports.add(name);
    }
    // `import type { T }` stays code, so it is a statement rather than an import.
    const typeImports = (facts.declaredBy.get(name) ?? []).filter((index) => facts.statements[index]?.kind === 'import');
    for (const index of [...(facts.typesDeclaredBy.get(name) ?? []), ...typeImports]) {
      const declared = facts.statements[index];
      assert(declared !== undefined, 'An index points at a statement');
      statements.add(index);
      pending.push(...declared.typeReads);
    }
  }
}

function nameProblem(facts: ExtractionFacts, name: string, declaring: number): Issue | undefined {
  const changed = reasonIn(facts, 'changed');
  if (facts.templateWrites.has(name)) {
    return changed;
  }
  if (!writersOf(facts, name, declaring).every(changesInPlace)) {
    return changed;
  }
  if (facts.exported.has(name)) {
    return reasonIn(facts, 'exported');
  }
  const effects = facts.statements.filter((statement, index) => index !== declaring && statement.kind === 'effect');
  if (effects.some((statement) => statement.reads.includes(name) || statement.declares.includes(name))) {
    return reasonIn(facts, 'otherCode');
  }
  return undefined;
}

function statementProblem(facts: ExtractionFacts, statement: Statement): Issue | undefined {
  if (statement.kind === 'export') {
    return reasonIn(facts, 'exported');
  }
  if (statement.kind === 'effect') {
    return issue('editor.extract.effect');
  }
  for (const member of statement.astroMembers) {
    if (member === undefined) {
      return reasonIn(facts, 'astroWhole');
    }
    if (!SHARED_ASTRO_MEMBERS.has(member)) {
      return reasonIn(facts, 'astroMember', { member });
    }
  }
  if (statement.readsImportMeta) {
    return reasonIn(facts, 'importMeta');
  }
  if (statement.callable) {
    const own = new Set(statement.declares);
    const captured = statement.reads.find((name) => facts.declaredBy.has(name) && !own.has(name));
    if (captured !== undefined) {
      return reasonIn(facts, 'usesCaptured', { name: captured });
    }
  }
  if (facts.inLoop) {
    if (statement.awaits || statement.volatile) {
      return issue('editor.extract.inLoop');
    }
  }
  return undefined;
}

// `const { a, b } = data` moves whole, so `a` cannot move while `b` is a prop:
// the component would declare `b` twice, which does not compile.
function sharedDeclaration(statement: Statement, name: string, props: ReadonlySet<string>): Issue | undefined {
  const clash = statement.declares.find((declared) => declared !== name && props.has(declared));
  return clash === undefined ? undefined : issue('editor.extract.declaredTogether', { name: clash });
}

// What has to be a prop whatever the person chooses: loop items, what nothing
// declares, and what a rule stops. A value stopped only by such a value is stopped
// for good too, so this repeats until nothing changes; each pass locks a value or
// ends, so the values bound it.
function lockedValues(facts: ExtractionFacts): ReadonlyMap<string, Issue> {
  const locked = new Map<string, Issue>();
  for (const name of facts.names) {
    if (facts.loopNames.has(name)) {
      locked.set(name, issue('editor.extract.fromLoop'));
    } else if (!facts.declaredBy.has(name)) {
      locked.set(name, reasonIn(facts, 'untraceable'));
    }
  }
  for (let pass = 0; pass <= facts.names.length; pass++) {
    const before = locked.size;
    for (const name of facts.names) {
      if (!locked.has(name)) {
        const closure = closureOf(facts, name, new Set(locked.keys()));
        if (closure.kind === 'blocked') {
          locked.set(name, closure.reason);
        }
      }
    }
    if (locked.size === before) {
      return locked;
    }
  }
  assert(false, 'Locking values stops once none is added');
  return locked;
}

interface Settled {
  /** Every value that ends up a prop, with the reason where it is not a choice. */
  readonly locked: ReadonlyMap<string, Issue>;
  readonly props: ReadonlySet<string>;
  readonly statements: ReadonlySet<number>;
  readonly imports: ReadonlySet<string>;
  /** Moved statements the parent still needs, so a copy stays. */
  readonly kept: ReadonlySet<number>;
  /** Every name the parent reads once the moved code has gone. */
  readonly parentReads: ReadonlySet<string>;
}

// The choices together. One value's fate can change another's: a statement shared
// with a prop has to stay, and a copy left behind may be one that cannot be
// duplicated. Each pass locks a value or ends, so the values bound it.
function settledChoices(facts: ExtractionFacts, always: ReadonlyMap<string, Issue>, asProp: ReadonlySet<string>): Settled {
  const locked = new Map(always);
  for (let pass = 0; pass <= facts.names.length; pass++) {
    const props = new Set([...locked.keys(), ...facts.names.filter((name) => asProp.has(name))]);
    const closures = movedClosures(facts, props);
    const blocked = closures.flatMap(({ name, closure }) => (closure.kind === 'blocked' ? [{ name, reason: closure.reason }] : []));
    if (blocked.length > 0) {
      blocked.forEach(({ name, reason }) => locked.set(name, reason));
      continue;
    }
    const statements = new Set(closures.flatMap(({ closure }) => (closure.kind === 'clear' ? [...closure.statements] : [])));
    const imports = new Set(closures.flatMap(({ closure }) => (closure.kind === 'clear' ? [...closure.imports] : [])));
    const { kept, parentReads } = parentNeeds(facts, statements, props);
    const twice = closures.filter(({ closure }) => closure.kind === 'clear' && [...closure.statements].some((index) => unsafeTwice(facts, index, kept)));
    if (twice.length === 0) {
      return { locked, props, statements, imports, kept, parentReads };
    }
    const reason = reasonIn(facts, 'usedTwice');
    twice.forEach(({ name }) => locked.set(name, reason));
  }
  assert(false, 'Settling choices stops once no value is locked');
  return { locked, props: new Set(), statements: new Set(), imports: new Set(), kept: new Set(), parentReads: new Set() };
}

function movedClosures(facts: ExtractionFacts, props: ReadonlySet<string>): readonly { readonly name: string; readonly closure: Closure }[] {
  return facts.names.filter((name) => !props.has(name)).map((name) => ({ name, closure: closureOf(facts, name, props) }));
}

function unsafeTwice(facts: ExtractionFacts, index: number, kept: ReadonlySet<number>): boolean {
  return kept.has(index) && facts.statements[index]?.volatile === true;
}

// Which moved statements the parent still reads. A statement kept is a statement
// whose own reads are the parent's again, so this repeats; each pass keeps a
// statement or ends, so the moved statements bound it.
function parentNeeds(
  facts: ExtractionFacts,
  moved: ReadonlySet<number>,
  props: ReadonlySet<string>,
): { readonly kept: ReadonlySet<number>; readonly parentReads: ReadonlySet<string> } {
  const reads = new Set([...facts.restReads, ...props]);
  const read = (statement: Statement): void => {
    for (const name of [...statement.reads, ...statement.typeReads]) {
      reads.add(name);
    }
  };
  facts.statements.forEach((statement, index) => {
    if (!moved.has(index)) {
      read(statement);
    }
  });
  const kept = new Set<number>();
  for (let pass = 0; pass <= moved.size; pass++) {
    const before = kept.size;
    for (const index of moved) {
      const statement = facts.statements[index];
      assert(statement !== undefined, 'An index points at a statement');
      if (!kept.has(index)) {
        if (parentNeedsStatement(facts, { statement, reads, kept })) {
          kept.add(index);
          read(statement);
        }
      }
    }
    if (kept.size === before) {
      return { kept, parentReads: reads };
    }
  }
  assert(false, 'Keeping statements stops once none is added');
  return { kept, parentReads: reads };
}

// A statement that changes a value the parent keeps stays with it, or the parent's
// value would stop being what the rest of the parent was written against.
function parentNeedsStatement(
  facts: ExtractionFacts,
  held: { readonly statement: Statement; readonly reads: ReadonlySet<string>; readonly kept: ReadonlySet<number> },
): boolean {
  const { statement, reads, kept } = held;
  if ([...statement.declares, ...statement.typeNames].some((name) => stillRead(facts, reads, name))) {
    return true;
  }
  return statement.writes.some((name) => (facts.declaredBy.get(name) ?? []).some((index) => kept.has(index)));
}

// Code nobody could read may read anything it names, so the name counts as read.
function stillRead(facts: ExtractionFacts, reads: ReadonlySet<string>, name: string): boolean {
  return reads.has(name) || facts.restUnreadable.some((code) => mentions(code, name));
}

// --- Writing -----------------------------------------------------------------------------

function writtenPlan(facts: ExtractionFacts, settled: Settled, asProp: ReadonlySet<string>): ExtractionPlan {
  const values = facts.names.map((name) => valueOf(facts, settled, { name, asProp }));
  const order = [...settled.statements].sort((first, second) => first - second);
  const leaving = order.filter((index) => !settled.kept.has(index));
  return {
    values,
    props: values.filter((value) => value.kind !== 'move').map((value) => value.name),
    moved: {
      imports: facts.imports.filter((entry) => settled.imports.has(entry.name)),
      code: order.map((index) => statementText(facts, index)).join('\n'),
    },
    parent: {
      imports: facts.imports.filter((entry) => !importLeaves(facts, settled, entry)),
      extraFrontmatter: withoutStatements(facts, leaving),
    },
  };
}

function valueOf(facts: ExtractionFacts, settled: Settled, value: { readonly name: string; readonly asProp: ReadonlySet<string> }): ExtractionValue {
  const { name, asProp } = value;
  const reason = settled.locked.get(name);
  if (reason !== undefined) {
    return { kind: 'locked', name, reason: reason.message, reasonIssue: reason };
  }
  if (asProp.has(name)) {
    return { kind: 'prop', name };
  }
  const held = facts.declaredBy.get(name) ?? [];
  const copyStays = held.some((index) => settled.kept.has(index));
  const note = copyStays ? reasonIn(facts, 'copyStays') : undefined;
  return { kind: 'move', name, note: note?.message, ...(note === undefined ? {} : { noteIssue: note }) };
}

function statementText(facts: ExtractionFacts, index: number): string {
  const statement = facts.statements[index];
  assert(statement !== undefined, 'An index points at a statement');
  const { declarator } = statement;
  if (declarator === undefined) {
    return facts.code.slice(statement.from, statement.to);
  }
  // One declarator of several travels as a declaration of its own.
  return `${declarator.keyword} ${facts.code.slice(statement.from, statement.to)};`;
}

// An import leaves only when this extraction is why nothing reads it any more.
// One the page already had no use for was not asked about.
function importLeaves(facts: ExtractionFacts, settled: Settled, entry: ImportDecl): boolean {
  if (settled.imports.has(entry.name) || facts.pieceReads.has(entry.name)) {
    return !stillRead(facts, settled.parentReads, entry.name);
  }
  return false;
}

function withoutStatements(facts: ExtractionFacts, leaving: readonly number[]): string {
  const { code } = facts;
  const pieces: string[] = [];
  let at = 0;
  for (const span of removedSpans(facts, leaving)) {
    // Two statements on one line can claim the same line ends.
    pieces.push(code.slice(at, Math.max(at, span.from)));
    at = Math.max(at, span.to);
  }
  pieces.push(code.slice(at));
  const left = pieces.join('').trim();
  assert(left.length <= code.length, 'Taking code out never adds any');
  return left;
}

// The text each leaving statement takes with it, in source order. A declarator whose
// siblings all leave too takes the whole declaration; one with a sibling that stays
// takes only itself and the comma that set it apart, so the others are left as written.
function removedSpans(facts: ExtractionFacts, leaving: readonly number[]): readonly { readonly from: number; readonly to: number }[] {
  const spans: { from: number; to: number }[] = [];
  const leavingParts = new Map<number, Set<number>>();
  for (const index of leaving) {
    const statement = facts.statements[index];
    assert(statement !== undefined, 'An index points at a statement');
    const { declarator } = statement;
    if (declarator === undefined) {
      spans.push(wholeLines(facts.code, statement));
    } else {
      const parts = leavingParts.get(declarator.whole.from) ?? new Set<number>();
      parts.add(declarator.index);
      leavingParts.set(declarator.whole.from, parts);
    }
  }
  for (const [wholeFrom, parts] of leavingParts) {
    const statement = facts.statements.find((candidate) => candidate.declarator?.whole.from === wholeFrom);
    assert(statement?.declarator !== undefined, 'A leaving declarator has its declaration');
    const { declarators, whole } = statement.declarator;
    if (parts.size === declarators.length) {
      spans.push(wholeLines(facts.code, whole));
    } else {
      spans.push(...declaratorSpansLeaving(declarators, parts));
    }
  }
  return spans.sort((first, second) => first.from - second.from);
}

// Each leaving declarator before the last one that stays goes with the comma after it;
// the ones after it go with the comma before the first of them.
function declaratorSpansLeaving(
  declarators: readonly { readonly from: number; readonly to: number }[],
  leaving: ReadonlySet<number>,
): readonly { readonly from: number; readonly to: number }[] {
  const staying = declarators.map((_, index) => index).filter((index) => !leaving.has(index));
  const lastStaying = staying[staying.length - 1];
  assert(lastStaying !== undefined, 'Something of the declaration stays');
  const spans: { from: number; to: number }[] = [];
  declarators.forEach((declarator, index) => {
    const next = declarators[index + 1];
    if (leaving.has(index)) {
      if (index < lastStaying) {
        assert(next !== undefined, 'A declarator before the last that stays has one after it');
        spans.push({ from: declarator.from, to: next.from });
      }
    }
  });
  const last = declarators[declarators.length - 1];
  const kept = declarators[lastStaying];
  assert(last !== undefined, 'A declaration has declarators');
  assert(kept !== undefined, 'The last declarator that stays is one of them');
  if (lastStaying < declarators.length - 1) {
    spans.push({ from: kept.to, to: last.to });
  }
  return spans;
}

// A statement alone on its lines takes those lines with it, and the blank line
// that set it apart, or removals would leave a gap behind.
function wholeLines(code: string, statement: { readonly from: number; readonly to: number }): { readonly from: number; readonly to: number } {
  const lineStart = code.lastIndexOf('\n', statement.from - 1) + 1;
  const lineEnd = code.indexOf('\n', statement.to);
  const end = lineEnd === -1 ? code.length : lineEnd + 1;
  if (code.slice(lineStart, statement.from).trim() !== '') {
    return statement;
  }
  if (code.slice(statement.to, end).trim() !== '') {
    return statement;
  }
  const blankAbove = lineStart === 0 || code.slice(0, lineStart).endsWith('\n\n');
  const nextEnd = code.indexOf('\n', end);
  const blankBelow = nextEnd !== -1 && code.slice(end, nextEnd).trim() === '';
  if (blankAbove) {
    if (blankBelow) {
      return { from: lineStart, to: nextEnd + 1 };
    }
  }
  return { from: lineStart, to: end };
}
