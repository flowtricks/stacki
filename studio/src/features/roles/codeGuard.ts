// Who may put code into the site, and the check every write answers to. The preview server runs the site's code with
// the whole environment of the Studio server, and the preview shares Studio's origin, so writing code is as much as
// controlling both. Only a role with a code permission (admin, "Edit code", "Edit component source") may write it.
//
// Every other role keeps all the editor gives it, which is data: words, pictures, settings, bindings, loop and
// condition settings, new elements and components, and moving, copying, deleting and undoing what is already there.
// So the rule compares code, not text: after a change, each piece of code must be one the project already held, or be
// only data (codeExpression.ts, codeModule.ts). This runs on the server only; documentAccess.ts, which the browser
// demo also type-checks, answers which files a role may write at all.
import { createHash } from 'node:crypto';
import { can, type RoleView } from '../../../vendor/stacki/shared/properties/projectRoles';
import { messageRef, type TypedMessageRef } from '../../../vendor/stacki/shared/properties/i18n/messageRef';
import { assert } from '../../../vendor/stacki/shared/core/assert';
import { readSource, safePath, supportedPath, walk } from '../project/projectServer';
import { batchedRead } from '../../shared/batchedRead';
import { MAX_SOURCE } from '../../shared/validation';
import { stat } from 'node:fs/promises';
import ts from 'typescript';
import { RoleRefusal } from './documentAccess';
import { innerScope, parseExpression, safeExpression, type CodeScope } from './codeExpression';
import {
  importSpecifier,
  moduleScope,
  onlyDataChanged,
  readModule,
  safeStatement,
  statementKey,
  trustedSources,
  type ImportRules,
  type ModuleCode,
} from './codeModule';
import { readPageCode, scriptAddress, scriptMarkup, type CodeUnit } from './codeMarkup';
import { readMdxCode } from './codeMdx';
import { componentTextProps, printedLiterals } from './editorFacts';

export type FileKind = 'page' | 'mdx' | 'script' | 'inert' | 'unknown';

/** Extensions are matched as written: `.ASTRO` is no kind a role without code permission may write. */
export function fileKind(file: string): FileKind {
  if (file.endsWith('.astro')) {
    return 'page';
  }
  if (file.endsWith('.mdx')) {
    return 'mdx';
  }
  if (/\.[cm]?[jt]sx?$/.test(file)) {
    return 'script';
  }
  return /\.(?:css|scss|sass|less|json|md|markdown|mdoc|yaml|yml|toml|csv|ndjson)$/.test(file) ? 'inert' : 'unknown';
}

/** Whether `role` may write any code: it edits source, by permission. */
export function writesCode(role: RoleView): boolean {
  return role.isAdmin || can(role, 'code:edit') || can(role, 'component:edit');
}

/** A write refused because it adds or changes code. The editor shows it in the person's language. */
export class CodeRefusal extends RoleRefusal {
  readonly messageRef: TypedMessageRef;

  constructor(role: RoleView, file: string) {
    super(`Your role (${role.name}) cannot add or change code in ${file}. Ask an admin for access.`);
    this.messageRef = messageRef('studio.collab.roleCannot', { role: role.name });
  }
}

export interface CodeChange {
  readonly file: string;
  /** Undefined for a new file. */
  readonly before: string | undefined;
  readonly after: string;
}

export const CODE_GUARD_LIMITS = {
  /** Pieces of code remembered from files as they were, so undoing a deletion brings its code back. */
  rememberedMax: 100_000,
  /** Files read to learn what code the project already holds. */
  inventoryFilesMax: 2_000,
  inventoryBytesMax: 32_000_000,
  /** Changed statements compared with each older one. */
  comparisonsMax: 200_000,
} as const satisfies Record<string, number>;

interface Analysis {
  readonly module: ModuleCode;
  readonly units: readonly CodeUnit[];
  readonly sources: readonly string[];
  readonly errors: number;
}

const EMPTY: Analysis = { module: { statements: [], errors: 0 }, units: [], sources: [], errors: 0 };
const ANALYSES_MAX = 8;

// The loop settings' sort by image file size (loopQuery.ts, `fileSizeCode`): exactly that text, over a field read.
const FIELD = String.raw`[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*|(?:\?\.)?\['(?:[^'\\\n]|\\.)*'\])*`;
const FILE_SIZE = new RegExp(
  String.raw`\(globalThis\.process\?\.getBuiltinModule\?\.\('node:fs'\)\?\.statSync\(` +
    FIELD +
    String.raw`\?\.fsPath \?\? '', \{ throwIfNoEntry: false \}\)\?\.size \?\? 0\)`,
  'g',
);

async function analyze(kind: FileKind, written: string): Promise<Analysis> {
  // The brackets stay, so a call written around it is still read as that call.
  const source = written.replace(FILE_SIZE, '(0)');
  if (kind === 'page') {
    const page = await readPageCode(source);
    return { module: readModule(page.frontmatter), units: page.units, sources: page.sources, errors: page.errors };
  }
  if (kind === 'mdx') {
    const mdx = readMdxCode(source);
    return { module: readModule(mdx.module), units: mdx.units, sources: [], errors: 0 };
  }
  assert(kind === 'script', 'Only files that hold code are analyzed');
  return { module: readModule(source), units: [], sources: [], errors: 0 };
}

const digest = (key: string): string => createHash('sha256').update(key).digest('base64');

function keysOf(analysis: Analysis): readonly string[] {
  const imports = analysis.module.statements.flatMap((statement) => {
    const specifier = importSpecifier(statement);
    return specifier === undefined ? [] : [`import:${specifier}`];
  });
  return [...analysis.module.statements.map(statementKey), ...imports, ...analysis.units.map((unit) => unit.key)].map(digest);
}

type Known = (key: string) => boolean;

// A string inside an expression that the browser would run: an address or markup that runs script.
function harmlessStrings(expression: ts.Expression, sink: 'url' | 'html'): boolean {
  const pending: ts.Node[] = [expression];
  for (let index = 0; index < pending.length; index++) {
    const node = pending[index];
    if (node === undefined || index > 10_000) {
      return false;
    }
    if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      if (sink === 'url' ? scriptAddress(node.text) : scriptMarkup(node.text)) {
        return false;
      }
    }
    ts.forEachChild(node, (child) => {
      pending.push(child);
    });
  }
  return true;
}

function safeUnit(unit: CodeUnit, scope: CodeScope, mdx: boolean): boolean {
  if (unit.kind !== 'expression' || unit.sink === 'handler') {
    return false;
  }
  // Text that is not one expression is accepted only as a copy of existing code.
  const expression = parseExpression(unit.code);
  if (expression === undefined) {
    return false;
  }
  const inner = innerScope(scope, [...unit.names, ...(mdx ? ['props', 'frontmatter'] : [])]);
  return safeExpression(expression, inner) && (unit.sink === 'none' || harmlessStrings(expression, unit.sink));
}

interface Judged {
  readonly file: string;
  readonly kind: FileKind;
  readonly before: Analysis;
  readonly after: Analysis;
}

/** Whether every piece of code in `after` is code `known` holds, or only data. */
function onlyAllowedCode(judged: Judged, known: Known): boolean {
  const { before, after, file, kind } = judged;
  if (after.errors > before.errors || after.module.errors > before.module.errors) {
    return false;
  }
  // Most changes bring no new code at all, which the texts alone answer.
  if (after.module.statements.every((statement) => known(statementKey(statement))) && after.units.every((unit) => known(unit.key))) {
    return true;
  }
  const trusted = new Set([...trustedSources(before.module.statements), ...before.sources]);
  const scope = moduleScope(after.module.statements, trusted);
  const rules: ImportRules = { file, imported: (specifier) => known(`import:${specifier}`) };
  let comparisons = 0;
  const statements = after.module.statements.every(
    (statement) =>
      known(statementKey(statement)) ||
      safeStatement(statement, scope, rules) ||
      before.module.statements.some((old) => ++comparisons <= CODE_GUARD_LIMITS.comparisonsMax && onlyDataChanged(old, statement, scope)),
  );
  return statements && after.units.every((unit) => known(unit.key) || safeUnit(unit, scope, kind === 'mdx'));
}

/** One workspace's check. It remembers code it has seen in files as they were. */
export class CodeGuard {
  private readonly remembered = new Set<string>();
  private readonly recent = new Map<string, { readonly analysis: Analysis; readonly keys: ReadonlySet<string> }>();

  constructor(
    private readonly root: string,
    private readonly read: (file: string) => Promise<string> = (file) => readSource(root, file),
  ) {}

  /** Throws when `role` may not make `change`, for the code it holds. Which files a role writes is checked elsewhere. */
  async assertAllowed(role: RoleView, change: CodeChange): Promise<void> {
    if (writesCode(role) || change.before === change.after) {
      return;
    }
    const kind = fileKind(change.file);
    if (kind === 'inert') {
      return;
    }
    // A new code file is never data: it is a route, or something a route may import.
    if (kind === 'unknown' || (kind === 'script' && change.before === undefined)) {
      throw new CodeRefusal(role, change.file);
    }
    const previous = change.before === undefined ? { analysis: EMPTY, keys: new Set<string>() } : await this.analyzed(kind, change.before);
    const next = await this.analyzed(kind, change.after);
    this.remember(previous.keys);
    const judged: Judged = { file: change.file, kind, before: previous.analysis, after: next.analysis };
    const here: Known = (key) => {
      const hashed = digest(key);
      return previous.keys.has(hashed) || this.remembered.has(hashed);
    };
    if (onlyAllowedCode(judged, here)) {
      return;
    }
    // Code copied from another page (a paste, a duplicated page) is the project's own.
    const project = await this.inventory();
    const anywhere: Known = (key) => here(key) || project.has(digest(key));
    if (onlyAllowedCode(judged, anywhere)) {
      return;
    }
    if (kind === 'page' && change.before !== undefined && (await this.onlyPrintedText(change.file, change.before, change.after, anywhere))) {
      return;
    }
    throw new CodeRefusal(role, change.file);
  }

  /** Keeps the code of a file about to be deleted or replaced, so putting it back is not new code. */
  async retain(file: string, source: string): Promise<void> {
    const kind = fileKind(file);
    if (kind === 'page' || kind === 'mdx' || kind === 'script') {
      this.remember(keysOf(await analyze(kind, source)));
    }
  }

  private async analyzed(kind: FileKind, source: string) {
    const id = `${kind}:${digest(source)}`;
    const cached = this.recent.get(id);
    if (cached !== undefined) {
      return cached;
    }
    const analysis = await analyze(kind, source);
    const entry = { analysis, keys: new Set(keysOf(analysis)) };
    for (const oldest of this.recent.keys()) {
      if (this.recent.size < ANALYSES_MAX) {
        break;
      }
      this.recent.delete(oldest);
    }
    this.recent.set(id, entry);
    return entry;
  }

  // The canvas lets text be typed where the page prints a frontmatter string, even inside a developer's own call.
  private async onlyPrintedText(file: string, before: string, after: string, known: Known): Promise<boolean> {
    const read = (target: string) => this.read(target).catch(() => undefined);
    const textProp = await componentTextProps(file, [before, after], read);
    const mask = async (source: string) => {
      let masked = source;
      const ranges = await printedLiterals(file, source, textProp);
      for (const range of [...ranges].sort((left, right) => right.start - left.start)) {
        masked = `${masked.slice(0, range.start)}"__avbText"${masked.slice(range.end)}`;
      }
      return masked;
    };
    const left = await analyze('page', await mask(before));
    const right = await analyze('page', await mask(after));
    const held = new Set(keysOf(left));
    return onlyAllowedCode({ file, kind: 'page', before: left, after: right }, (key) => held.has(digest(key)) || known(key));
  }

  private remember(keys: Iterable<string>): void {
    for (const key of keys) {
      this.remembered.add(key);
    }
    for (const oldest of this.remembered) {
      if (this.remembered.size <= CODE_GUARD_LIMITS.rememberedMax) {
        break;
      }
      this.remembered.delete(oldest);
    }
  }

  // The code the project's pages and MDX files hold now. Read only when a change holds code its own file did not.
  private async inventory(): Promise<ReadonlySet<string>> {
    const files = (await walk(this.root, 'src')).filter((file) => /\.(?:astro|mdx)$/.test(file) && supportedPath(file));
    const found = new Set<string>();
    let bytes = 0;
    await batchedRead(files.slice(0, CODE_GUARD_LIMITS.inventoryFilesMax), async (file) => {
      const size = (await stat(await safePath(this.root, file))).size;
      if (size > MAX_SOURCE || bytes + size > CODE_GUARD_LIMITS.inventoryBytesMax) {
        return;
      }
      bytes += size;
      // A page that cannot be read as code adds nothing, which can only refuse more.
      const analysis = await analyze(fileKind(file), await this.read(file)).catch(() => EMPTY);
      for (const key of keysOf(analysis)) {
        found.add(key);
      }
    });
    return found;
  }
}
