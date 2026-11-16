// Pre-flight: what an edit would do to a file, checked in memory before the bytes are written.
//
// The editor writes source for people who do not read source. When an edit would leave a page
// that Astro cannot render (a name nothing defines, a component nothing imports, an import of
// an export that does not exist, a name declared twice), the person sees a stack trace where
// their page was, and has to undo without knowing what went wrong. So between the planner and
// the writer every candidate file is read statically and compared with the file before the
// edit. Only findings the edit ADDS count: a file that was already broken in some way is the
// person's, and an edit elsewhere in it is never refused for it (no false positives from the
// past). docs/error-proofing.md is the contract.
//
// Each finding has a severity (`error`: the page WILL break; `warning`: it may) and a remedy:
// `auto-fix` (the editor can repair it without asking, and says so), `one-click` (a fix to
// offer: add the import, fill in a value, paste as a component instance) or `explain` (a plain
// sentence, and the edit is held). What an operation does with the findings is its policy in
// PREFLIGHT_CHECKS below, typed over the planner's operation tags exactly like the instant-edits
// table: a new operation does not compile until it states its checks and its policy.
//
// - `refuse-new-errors`: a gesture (insert, move, wrap, paste, rename a binding). New errors
//   refuse the write, so the canvas keeps the last good render and the file is never written
//   broken.
// - `advise`: code a person types (an expression, the frontmatter editor, a prop value as it is
//   typed, a program's rewrite). Typing is never blocked: findings are reported, the write goes
//   ahead, and a page that then fails to compile offers "Undo last change".
//
// Bounded and cheap: one pass over the tree (LIMITS.treeNodesMax), the Lezer scope reader per
// expression (never throws), no I/O. Import targets are checked through an injected resolver.

import { assert } from '../core/assert';
import { LIMITS } from '../core/limits';
import { err, ok, type Result } from '../core/result';
import type { ImportDecl, PageModel, PageNode } from '../page/pageNode';
import type { OperationTag } from './intent';
import { bindingScope, readModuleScope, readTemplateScope } from './jsScope';

export type PreflightSeverity = 'error' | 'warning';

export type PreflightCode =
  /** A name the markup reads that nothing in the file defines: ReferenceError while rendering. */
  | 'undefined-name'
  /** A component tag with no import: Astro cannot render it. */
  | 'missing-component'
  /** `import { X } from './X.astro'`: a component file has only a default export. */
  | 'named-from-astro'
  /** `import getCollection from 'astro:content'`: that module offers it by name only. */
  | 'default-from-module'
  /** Two top-level bindings of one name: the frontmatter does not compile. */
  | 'duplicate-name'
  /** A page that reads `Astro.props` with no getStaticPaths: every prop is undefined there. */
  | 'props-in-page'
  /** A relative import whose file does not exist. */
  | 'missing-file'
  /** The frontmatter no longer parses. */
  | 'frontmatter-syntax';

export const PREFLIGHT_CODES: readonly PreflightCode[] = [
  'undefined-name',
  'missing-component',
  'named-from-astro',
  'default-from-module',
  'duplicate-name',
  'props-in-page',
  'missing-file',
  'frontmatter-syntax',
] as const;

/** What can be done about a finding. */
export type PreflightRemedy =
  /** Repaired without asking, and reported: the import's form is corrected. */
  | { readonly kind: 'auto-fix'; readonly fix: 'default-import' | 'named-import' }
  /** A fix the person can apply with one click. */
  | { readonly kind: 'one-click'; readonly fix: 'add-import' | 'fill-value' | 'rename' }
  /** Nothing to apply: the reason, in plain words, and the edit is held. */
  | { readonly kind: 'explain' };

export interface PreflightFinding {
  readonly code: PreflightCode;
  readonly severity: PreflightSeverity;
  /** The name, module or path the finding is about: what the message names. */
  readonly subject: string;
  readonly remedy: PreflightRemedy;
}

export type PreflightPolicy = 'refuse-new-errors' | 'advise';

export interface PreflightEntry {
  readonly policy: PreflightPolicy;
  /** The checks that matter for what the operation can change; a check not listed is not run for it. */
  readonly checks: readonly PreflightCode[];
}

const ALL: readonly PreflightCode[] = PREFLIGHT_CODES;
const MARKUP: readonly PreflightCode[] = ['undefined-name', 'missing-component', 'props-in-page'];
const FRONTMATTER: readonly PreflightCode[] = [
  'undefined-name',
  'missing-component',
  'named-from-astro',
  'default-from-module',
  'duplicate-name',
  'props-in-page',
  'missing-file',
  'frontmatter-syntax',
];

/** Every planner operation's checks and policy. Typed over the operation tags: a new one does not compile until it says. */
export const PREFLIGHT_CHECKS: Readonly<Record<OperationTag, PreflightEntry>> = {
  'insert-node': { policy: 'refuse-new-errors', checks: MARKUP },
  'append-body': { policy: 'refuse-new-errors', checks: MARKUP },
  'move-node': { policy: 'refuse-new-errors', checks: MARKUP },
  'wrap-nodes': { policy: 'refuse-new-errors', checks: MARKUP },
  'remove-node': { policy: 'refuse-new-errors', checks: MARKUP },
  'rename-tag': { policy: 'refuse-new-errors', checks: ['missing-component'] },
  'rename-binding': { policy: 'refuse-new-errors', checks: ['undefined-name', 'duplicate-name'] },
  'insert-frontmatter': { policy: 'refuse-new-errors', checks: FRONTMATTER },
  // Typed or programmatic text: reported, never blocking (see the policy note above).
  'set-attribute': { policy: 'advise', checks: MARKUP },
  'remove-attribute': { policy: 'advise', checks: MARKUP },
  'rename-attribute': { policy: 'advise', checks: MARKUP },
  'set-inline-style': { policy: 'advise', checks: [] },
  'rewrite-node': { policy: 'advise', checks: MARKUP },
  'apply-code-patch': { policy: 'advise', checks: ALL },
  'edit-frontmatter-slot': { policy: 'advise', checks: FRONTMATTER },
  'revert-splices': { policy: 'advise', checks: ALL },
  'rewrite-text': { policy: 'advise', checks: ALL },
};

/** The file as pre-flight reads it. */
export interface PreflightFile {
  readonly path: string;
  readonly model: Pick<PageModel, 'imports' | 'extraFrontmatter' | 'nodes'>;
}

/** Whether a relative import's target exists; `unknown` when it cannot be told (never a finding). */
export type ImportResolver = (fromPath: string, specifier: string) => 'exists' | 'missing' | 'unknown';

export interface PreflightRefusal {
  readonly findings: readonly PreflightFinding[];
}

/** Findings of one file. Pure, total and bounded; unreadable code yields only `frontmatter-syntax`. */
export function preflightFile(file: PreflightFile, checks: readonly PreflightCode[], resolve?: ImportResolver): readonly PreflightFinding[] {
  const wanted = new Set(checks);
  const findings: PreflightFinding[] = [];
  const frontmatter = readModuleScope(file.model.extraFrontmatter);
  if (!frontmatter.valid) {
    if (wanted.has('frontmatter-syntax')) {
      // A warning: the reader is Lezer, not TypeScript, and a rare valid file reads as broken to it.
      findings.push({ code: 'frontmatter-syntax', severity: 'warning', subject: '', remedy: { kind: 'explain' } });
    }
    return findings; // Names cannot be told apart in code that does not parse.
  }
  const imports = file.model.imports;
  const bound = new Set<string>([...imports.map((entry) => entry.name), ...frontmatter.root.names, ...frontmatter.exported]);
  for (const definition of frontmatter.definitions) {
    if (definition.scope === frontmatter.root) {
      bound.add(definition.name);
    }
  }
  if (wanted.has('undefined-name') || wanted.has('missing-component')) {
    findings.push(...templateFindings(file.model.nodes, bound, wanted));
  }
  if (wanted.has('named-from-astro') || wanted.has('default-from-module')) {
    findings.push(...importFormFindings(imports, wanted));
  }
  if (wanted.has('duplicate-name')) {
    findings.push(...duplicateFindings(imports, frontmatter.root.names));
  }
  if (wanted.has('props-in-page') && isPagePath(file.path)) {
    const code = file.model.extraFrontmatter;
    if (/\bAstro\.props\b/.test(code) && !/\bgetStaticPaths\b/.test(code)) {
      findings.push({ code: 'props-in-page', severity: 'warning', subject: 'Astro.props', remedy: { kind: 'one-click', fix: 'fill-value' } });
    }
  }
  if (wanted.has('missing-file') && resolve !== undefined) {
    for (const entry of imports) {
      if (entry.path.startsWith('.') && resolve(file.path, entry.path) === 'missing') {
        findings.push({ code: 'missing-file', severity: 'error', subject: entry.path, remedy: { kind: 'explain' } });
      }
    }
  }
  assert(findings.length <= LIMITS.treeNodesMax + imports.length * 3 + 2, 'preflightFile: findings within limit');
  return findings;
}

/** The findings `after` has that `before` did not, counted per code and subject: only what the edit adds. */
export function addedFindings(before: readonly PreflightFinding[], after: readonly PreflightFinding[]): readonly PreflightFinding[] {
  const had = new Map<string, number>();
  for (const finding of before) {
    const key = findingKey(finding);
    had.set(key, (had.get(key) ?? 0) + 1);
  }
  const added: PreflightFinding[] = [];
  for (const finding of after) {
    const key = findingKey(finding);
    const left = had.get(key) ?? 0;
    if (left > 0) {
      had.set(key, left - 1);
    } else {
      added.push(finding);
    }
  }
  assert(added.length <= after.length, 'addedFindings: never more than the file holds');
  return added;
}

/**
 * The verdict on one edit: `ok` with the findings it adds (warnings, or errors under `advise`),
 * or `err` when its policy refuses the errors it adds.
 */
export function preflightVerdict(
  operation: OperationTag,
  files: { readonly before: PreflightFile | undefined; readonly after: PreflightFile },
  resolve?: ImportResolver,
): Result<readonly PreflightFinding[], PreflightRefusal> {
  const entry = PREFLIGHT_CHECKS[operation];
  assert(entry !== undefined, 'Every operation declares its pre-flight');
  if (entry.checks.length === 0) {
    return ok([]);
  }
  const before = files.before === undefined ? [] : preflightFile(files.before, entry.checks, resolve);
  const added = addedFindings(before, preflightFile(files.after, entry.checks, resolve));
  const errors = added.filter((finding) => finding.severity === 'error');
  if (entry.policy === 'refuse-new-errors') {
    if (errors.length > 0) {
      return err({ findings: errors });
    }
  }
  return ok(added);
}

function findingKey(finding: PreflightFinding): string {
  return `${finding.code}\u0000${finding.subject}`;
}

function isPagePath(path: string): boolean {
  return /[\\/]src[\\/]pages[\\/]/.test(path);
}

// --- Template -----------------------------------------------------------------------------

interface Visit {
  readonly node: PageNode;
  /** Names a surrounding loop binds; undefined below a loop whose head could not be read. */
  readonly scope: ReadonlySet<string> | undefined;
  readonly depth: number;
}

function templateFindings(nodes: readonly PageNode[], bound: ReadonlySet<string>, wanted: ReadonlySet<PreflightCode>): readonly PreflightFinding[] {
  const findings: PreflightFinding[] = [];
  const reported = new Set<string>();
  const report = (code: PreflightCode, subject: string): void => {
    const key = `${code}:${subject}`;
    if (wanted.has(code) && !reported.has(key)) {
      reported.add(key);
      findings.push({
        code,
        severity: 'error',
        subject,
        remedy: code === 'missing-component' ? { kind: 'one-click', fix: 'add-import' } : { kind: 'explain' },
      });
    }
  };
  const known = (name: string, scope: ReadonlySet<string>): boolean => bound.has(name) || scope.has(name) || TEMPLATE_GLOBALS.has(name);
  const pending: Visit[] = nodes.map((node) => ({ node, scope: new Set<string>(), depth: 0 }));
  let visited = 0;
  while (pending.length > 0) {
    const visit = pending.pop();
    assert(visit !== undefined, 'A non-empty list has a last visit');
    visited += 1;
    assert(visited <= LIMITS.treeNodesMax, 'templateFindings: nodes within limit');
    assert(visit.depth <= LIMITS.treeDepthMax, 'templateFindings: depth within limit');
    const { node, scope } = visit;
    if (scope === undefined) {
      continue; // Under a loop whose names cannot be read, nothing is guessed.
    }
    let childScope: ReadonlySet<string> | undefined = scope;
    for (const code of codeOf(node)) {
      for (const name of freeNames(code)) {
        if (!known(name, scope)) {
          report(/^[A-Z]/.test(name) && code.includes(`<${name}`) ? 'missing-component' : 'undefined-name', name);
        }
      }
    }
    if (node.kind === 'component' || (node.kind === 'element' && node.dynamicTag === true)) {
      const root = node.name.split('.')[0] ?? node.name;
      if (!known(root, scope)) {
        report(node.kind === 'component' ? 'missing-component' : 'undefined-name', root);
      }
    }
    if (node.kind === 'map') {
      childScope = loopScope(node, scope);
    }
    if ('children' in node) {
      for (const child of node.children ?? []) {
        pending.push({ node: child, scope: childScope, depth: visit.depth + 1 });
      }
    }
  }
  return findings;
}

// The code a node carries, each piece parseable as an expression. Text and raw tags are not code.
function codeOf(node: PageNode): readonly string[] {
  const out: string[] = [];
  if ('props' in node && node.props !== undefined && node.kind !== 'raw') {
    for (const value of Object.values(node.props)) {
      if (value.type === 'expr' || value.type === 'spread') {
        out.push(value.value);
      }
    }
  }
  if (node.kind === 'expr') {
    const inner = node.value.trim();
    out.push(inner.startsWith('{') && inner.endsWith('}') ? inner.slice(1, -1) : inner);
  } else if (node.kind === 'cond') {
    out.push(node.test);
  } else if (node.kind === 'map') {
    const head = LOOP_HEAD.exec(node.head);
    if (head?.[1] !== undefined) {
      out.push(head[1]);
    }
  }
  return out.filter((code) => code.trim() !== '' && !/^\s*\/\*[\s\S]*\*\/\s*$/.test(code));
}

// `data.map((item, index) => (` and `data.map(item => (`: the data, then the parameters.
const LOOP_HEAD = /^([\s\S]*?)\.map\(\s*(?:async\s+)?(?:\(([^)]*)\)|([A-Za-z_$][\w$]*))\s*=>/;

function loopScope(node: Extract<PageNode, { readonly kind: 'map' }>, outer: ReadonlySet<string>): ReadonlySet<string> | undefined {
  const head = LOOP_HEAD.exec(node.head);
  if (head === null) {
    return undefined;
  }
  const names = new Set(outer);
  for (const match of (head[2] ?? head[3] ?? '').matchAll(/[A-Za-z_$][\w$]*/g)) {
    names.add(match[0]);
  }
  // Code inside the callback (`const copy = …; return (…)`) may bind any word it holds: every word
  // of it counts as bound, so a name declared there is never reported.
  for (const code of [...(node.body ?? []), ...(node.bodyParts ?? [])]) {
    for (const match of code.matchAll(/[A-Za-z_$][\w$]*/g)) {
      names.add(match[0]);
    }
  }
  return names;
}

// The names an expression reads that it does not bind itself, tags included.
function freeNames(code: string): readonly string[] {
  const analysis = readTemplateScope(`(${code}\n)`);
  if (!analysis.valid) {
    return []; // Code that does not parse is the compiler's to report; pre-flight never guesses.
  }
  const out = new Set<string>();
  for (const reference of analysis.references) {
    if (bindingScope(reference.scope, reference.name) === undefined) {
      out.add(reference.name);
    }
  }
  for (const tag of analysis.tags) {
    if (/^[A-Z]/.test(tag.name) && bindingScope(tag.scope, tag.name) === undefined) {
      out.add(tag.name);
    }
  }
  return [...out];
}

// --- Frontmatter ----------------------------------------------------------------------------

// Modules whose exports are all named: a default import of them is undefined at run time.
const NAMED_ONLY_MODULES: ReadonlySet<string> = new Set([
  'astro:content',
  'astro:assets',
  'astro:transitions',
  'astro:transitions/client',
  'astro:actions',
  'astro:middleware',
  'astro:i18n',
  'astro:env/client',
  'astro:env/server',
  'astro:schema',
]);

function importFormFindings(imports: readonly ImportDecl[], wanted: ReadonlySet<PreflightCode>): readonly PreflightFinding[] {
  const findings: PreflightFinding[] = [];
  for (const entry of imports) {
    if (entry.typeOnly === true) {
      continue; // Erased at build: no export is looked up.
    }
    if (wanted.has('named-from-astro') && entry.named === true && /\.astro$/.test(entry.path) && /^[A-Z]/.test(entry.name)) {
      // A component imported by name: the file's default export is the component. A lower-case
      // helper exported from a frontmatter (`import { getSinglePage } from './contentParser.astro'`)
      // is real and works, so it is never reported (found on the corpus of real sites).
      findings.push({ code: 'named-from-astro', severity: 'warning', subject: entry.name, remedy: { kind: 'auto-fix', fix: 'default-import' } });
    }
    if (wanted.has('default-from-module') && entry.named !== true && NAMED_ONLY_MODULES.has(entry.path) && !entry.name.startsWith('*')) {
      findings.push({ code: 'default-from-module', severity: 'error', subject: entry.name, remedy: { kind: 'auto-fix', fix: 'named-import' } });
    }
  }
  return findings;
}

function duplicateFindings(imports: readonly ImportDecl[], declared: ReadonlySet<string>): readonly PreflightFinding[] {
  const findings: PreflightFinding[] = [];
  const seen = new Set<string>();
  for (const entry of imports) {
    if (seen.has(entry.name) || declared.has(entry.name)) {
      findings.push({ code: 'duplicate-name', severity: 'error', subject: entry.name, remedy: { kind: 'one-click', fix: 'rename' } });
    }
    seen.add(entry.name);
  }
  return findings;
}

/** Names every template may read without declaring them: the language, the platform, Astro. */
export const TEMPLATE_GLOBALS: ReadonlySet<string> = new Set([
  // Astro.
  'Astro',
  'Fragment',
  // Language.
  'undefined',
  'NaN',
  'Infinity',
  'globalThis',
  'Object',
  'Array',
  'String',
  'Number',
  'Boolean',
  'Symbol',
  'BigInt',
  'Math',
  'JSON',
  'Date',
  'RegExp',
  'Error',
  'TypeError',
  'RangeError',
  'SyntaxError',
  'ReferenceError',
  'EvalError',
  'URIError',
  'AggregateError',
  'Promise',
  'Proxy',
  'Reflect',
  'Map',
  'Set',
  'WeakMap',
  'WeakSet',
  'WeakRef',
  'FinalizationRegistry',
  'Intl',
  'ArrayBuffer',
  'SharedArrayBuffer',
  'DataView',
  'Atomics',
  'Int8Array',
  'Uint8Array',
  'Uint8ClampedArray',
  'Int16Array',
  'Uint16Array',
  'Int32Array',
  'Uint32Array',
  'Float32Array',
  'Float64Array',
  'BigInt64Array',
  'BigUint64Array',
  'parseInt',
  'parseFloat',
  'isNaN',
  'isFinite',
  'encodeURI',
  'encodeURIComponent',
  'decodeURI',
  'decodeURIComponent',
  'escape',
  'unescape',
  'eval',
  'arguments',
  'require',
  'module',
  'exports',
  // Platform (Node and the web, both of which a server render can see).
  'console',
  'process',
  'Buffer',
  'URL',
  'URLSearchParams',
  'TextEncoder',
  'TextDecoder',
  'fetch',
  'Request',
  'Response',
  'Headers',
  'FormData',
  'Blob',
  'File',
  'AbortController',
  'AbortSignal',
  'Event',
  'EventTarget',
  'structuredClone',
  'queueMicrotask',
  'setTimeout',
  'clearTimeout',
  'setInterval',
  'clearInterval',
  'setImmediate',
  'atob',
  'btoa',
  'crypto',
  'performance',
  'navigator',
  'window',
  'document',
  'location',
  'history',
  'localStorage',
  'sessionStorage',
  'customElements',
  'HTMLElement',
  'Element',
  'Node',
  'CSS',
  'Image',
  'import',
]);
