// Code intelligence's contract (docs/contracts.md, "Code intelligence"): what the code editor may ask about the file it
// shows, and the shapes of the answers. The same shapes cross two process boundaries, renderer to main and main to the
// intelligence process, and each side parses what it receives.
//
// Every request carries the editor's whole text, so what is analysed is the unsaved buffer and no second copy of the
// document has to be kept in step. Offsets are UTF-16 units into that text. Answers hold positions, labels and plain
// text only: nothing in them is markup or code the receiver runs.
import { assert } from '../core/assert';
import { boolean, count, list, object, optional, pathText, record, text } from '../core/boundary';
import { parseExplorerPath, type ExplorerPath } from './fileExplorer';

export const CODE_INTEL_LIMITS = {
  /** UTF-16 units of one document that is analysed; a longer one gets the editor's own completions only. */
  documentCharsMax: 1024 * 1024,
  /** Suggestions one answer carries; a longer list is cut and marked incomplete, so typing on asks again. */
  completionsMax: 200,
  /** Squiggles one document shows. */
  diagnosticsMax: 200,
  /** UTF-16 units of one label, detail or message. */
  labelCharsMax: 400,
  messageCharsMax: 2_000,
  /** UTF-16 units of a hover or detail's type signature and of its documentation. */
  signatureCharsMax: 4_000,
  documentationCharsMax: 4_000,
  /** Edits one suggestion may make besides its own insertion (an added import). */
  editsMax: 20,
  editCharsMax: 4_000,
  /** Signatures one signature help answer lists. */
  signaturesMax: 12,
  /** Project files and folders indexed for component and path suggestions; the walk stops there. */
  indexFilesMax: 30_000,
  indexDirectoriesMax: 6_000,
  indexDepthMax: 24,
  /** Stylesheets and style-bearing files read for class and variable suggestions, one's size, and their sum. */
  styleFilesMax: 3_000,
  styleFileBytesMax: 512 * 1024,
  styleBytesMax: 24 * 1024 * 1024,
  /** Stylesheets outside the project followed from `@import` and `import` lines (a workspace or package's tokens). */
  styleImportsMax: 200,
  /** TypeScript files given to the type checker as roots, so their exports can be suggested; a larger project offers
   * auto-imports from the files already imported only. */
  rootFilesMax: 3_000,
  /** One source file the type checker reads. */
  sourceFileBytesMax: 2 * 1024 * 1024,
  /** Type-checker projects (one per tsconfig) kept at once. */
  projectsMax: 3,
  /** Requests waiting for the intelligence process; the oldest is answered empty beyond this. */
  pendingMax: 16,
  /** How long one request may take: the first builds the project's types. A process past it is restarted. */
  firstRequestTimeoutMs: 60_000,
  requestTimeoutMs: 15_000,
  /** The process's JavaScript heap limit, which V8 enforces by ending the process. */
  heapMegabytesMax: 1_024,
  /** Memory the process may hold in all, compiled code and the compiler's WebAssembly included: past it after an
   * answer, the process ends and the next question starts a fresh one. */
  residentMegabytesMax: 1_536,
  /** How long it may sit unused before it is stopped. */
  idleStopMs: 5 * 60_000,
  /** Restarts after a crash or a timeout inside `crashWindowMs`; past them it stays off until the project changes. */
  restartsMax: 3,
  crashWindowMs: 5 * 60_000,
} as const satisfies Record<string, number>;

export const COMPLETION_KINDS = [
  'component',
  'property',
  'value',
  'variable',
  'function',
  'method',
  'class',
  'interface',
  'type',
  'enum',
  'keyword',
  'constant',
  'module',
  'file',
  'folder',
  'cssVariable',
  'cssClass',
  'text',
] as const;
export type CompletionKind = (typeof COMPLETION_KINDS)[number];

export const DIAGNOSTIC_SEVERITIES = ['error', 'warning', 'info'] as const;
export type DiagnosticSeverity = (typeof DIAGNOSTIC_SEVERITIES)[number];

export type CodeIntelQuery =
  | { readonly kind: 'complete'; readonly position: number; readonly explicit: boolean }
  /** The type, documentation and extra edits of one TypeScript suggestion, asked when it is looked at or accepted. */
  | { readonly kind: 'resolve'; readonly position: number; readonly entry: CompletionEntryRef }
  | { readonly kind: 'hover'; readonly position: number }
  | { readonly kind: 'signature'; readonly position: number }
  | { readonly kind: 'diagnostics' };

export interface CodeIntelRequest {
  readonly projectPath: string;
  readonly path: ExplorerPath;
  readonly text: string;
  readonly query: CodeIntelQuery;
}

/** Names one TypeScript suggestion again; `data` is the type checker's own record of where it comes from, as JSON. */
export interface CompletionEntryRef {
  readonly name: string;
  readonly source: string | undefined;
  readonly data: string | undefined;
}

export interface CodeEdit {
  readonly from: number;
  readonly to: number;
  readonly insert: string;
}

export interface CodeCompletion {
  readonly label: string;
  readonly kind: CompletionKind;
  /** Short text beside the label: a type, a value, the file it comes from. */
  readonly detail: string | undefined;
  /** The text inserted over the answer's range, when it is not the label. */
  readonly insert: string | undefined;
  /** Where the cursor goes inside `insert`; at its end when absent. */
  readonly cursor: number | undefined;
  /** Higher comes first among equally good matches. */
  readonly boost: number;
  /** A required property that is not yet written. */
  readonly required: boolean;
  /** A CSS colour to draw beside the suggestion. */
  readonly color: string | undefined;
  readonly signature: string | undefined;
  readonly documentation: string | undefined;
  /** Edits made with the insertion, in the request's offsets: the import a component needs. */
  readonly edits: readonly CodeEdit[];
  readonly entry: CompletionEntryRef | undefined;
}

export interface CodeCompletions {
  /** The range the accepted suggestion replaces: `from` to the request's position, or further to `to`. */
  readonly from: number;
  readonly to: number;
  readonly items: readonly CodeCompletion[];
  /** True when these answers are the whole story here, so the editor's grammar completions stay out. */
  readonly exclusive: boolean;
  readonly incomplete: boolean;
}

export interface CodeCompletionDetail {
  readonly signature: string | undefined;
  readonly documentation: string | undefined;
  readonly edits: readonly CodeEdit[];
}

export interface CodeDiagnostic {
  readonly from: number;
  readonly to: number;
  readonly severity: DiagnosticSeverity;
  readonly message: string;
}

export interface CodeHover {
  readonly from: number;
  readonly to: number;
  readonly signature: string | undefined;
  readonly documentation: string | undefined;
}

export interface CodeSignature {
  readonly label: string;
  /** The range of `label` naming the argument being typed; empty when there is none. */
  readonly activeFrom: number;
  readonly activeTo: number;
  readonly documentation: string | undefined;
}

export interface CodeSignatureHelp {
  readonly from: number;
  readonly signatures: readonly CodeSignature[];
  readonly active: number;
}

export type CodeIntelReply =
  | { readonly kind: 'completions'; readonly completions: CodeCompletions }
  | { readonly kind: 'detail'; readonly detail: CodeCompletionDetail }
  | { readonly kind: 'hover'; readonly hover: CodeHover | undefined }
  | { readonly kind: 'signature'; readonly help: CodeSignatureHelp | undefined }
  | { readonly kind: 'diagnostics'; readonly diagnostics: readonly CodeDiagnostic[] }
  /** No answer: the process is starting again, off, or the request was dropped. The editor stays as it is. */
  | { readonly kind: 'unavailable' };

export const UNAVAILABLE: CodeIntelReply = { kind: 'unavailable' };

function bounded(maximum: number) {
  assert(maximum > 0, 'A text bound is positive');
  return (input: unknown): string => {
    const value = text(input);
    if (value.length > maximum) {
      throw new Error('Code intelligence text exceeds its bound');
    }
    return value;
  };
}

function capped<T>(maximum: number, parse: (input: unknown) => T) {
  assert(maximum > 0, 'A list bound is positive');
  return (input: unknown): T[] => {
    const values = list(parse)(input);
    if (values.length > maximum) {
      throw new Error('Code intelligence list exceeds its bound');
    }
    return values;
  };
}

function member<T extends string>(values: readonly T[], input: unknown): T {
  assert(values.length > 0, 'A choice has values');
  const found = values.find((value) => value === input);
  if (found === undefined) {
    throw new Error('Code intelligence: unknown value');
  }
  return found;
}

const label = bounded(CODE_INTEL_LIMITS.labelCharsMax);
const signatureText = bounded(CODE_INTEL_LIMITS.signatureCharsMax);
const documentationText = bounded(CODE_INTEL_LIMITS.documentationCharsMax);
const messageText = bounded(CODE_INTEL_LIMITS.messageCharsMax);

function parseEntryRef(input: unknown): CompletionEntryRef {
  const source = record(input);
  return {
    name: label(source['name']),
    source: optional(bounded(CODE_INTEL_LIMITS.signatureCharsMax))(source['source']),
    data: optional(bounded(CODE_INTEL_LIMITS.signatureCharsMax))(source['data']),
  };
}

function parseQuery(input: unknown, documentLength: number): CodeIntelQuery {
  assert(documentLength >= 0, 'A document has a length');
  assert(documentLength <= CODE_INTEL_LIMITS.documentCharsMax, 'The document was bounded before its query is read');
  const source = record(input);
  const position = (): number => {
    const value = count(source['position']);
    if (value > documentLength) {
      throw new Error('Code intelligence position is outside the document');
    }
    return value;
  };
  switch (source['kind']) {
    case 'complete':
      return { kind: 'complete', position: position(), explicit: boolean(source['explicit']) };
    case 'resolve':
      return { kind: 'resolve', position: position(), entry: parseEntryRef(source['entry']) };
    case 'hover':
      return { kind: 'hover', position: position() };
    case 'signature':
      return { kind: 'signature', position: position() };
    case 'diagnostics':
      return { kind: 'diagnostics' };
    default:
      throw new Error('Code intelligence: unknown query');
  }
}

export function parseCodeIntelRequest(input: unknown): CodeIntelRequest {
  const source = record(input);
  const document = source['text'];
  if (typeof document !== 'string') {
    throw new Error('Code intelligence: the document is text');
  }
  if (document.length > CODE_INTEL_LIMITS.documentCharsMax) {
    throw new Error('Code intelligence: the document exceeds its bound');
  }
  const path = parseExplorerPath(source['path']);
  if (path === '') {
    throw new Error('Code intelligence: a file is named');
  }
  const query = parseQuery(source['query'], document.length);
  assert(!('position' in query) || query.position <= document.length, 'A question points into its document');
  return { projectPath: pathText(source['projectPath']), path, text: document, query };
}

function parseEdit(input: unknown): CodeEdit {
  const source = record(input);
  const edit = { from: count(source['from']), to: count(source['to']), insert: bounded(CODE_INTEL_LIMITS.editCharsMax)(source['insert']) };
  if (edit.to < edit.from) {
    throw new Error('Code intelligence: an edit keeps its order');
  }
  assert(edit.insert.length <= CODE_INTEL_LIMITS.editCharsMax, 'An edit stays within its bound');
  return edit;
}

const parseEdits = capped(CODE_INTEL_LIMITS.editsMax, parseEdit);

function parseCompletion(input: unknown): CodeCompletion {
  const source = record(input);
  const boost = source['boost'];
  if (typeof boost !== 'number' || !Number.isFinite(boost)) {
    throw new Error('Code intelligence: a boost is a number');
  }
  return {
    label: label(source['label']),
    kind: member(COMPLETION_KINDS, source['kind']),
    detail: optional(label)(source['detail']),
    insert: optional(bounded(CODE_INTEL_LIMITS.editCharsMax))(source['insert']),
    cursor: optional(count)(source['cursor']),
    boost,
    required: boolean(source['required']),
    color: optional(label)(source['color']),
    signature: optional(signatureText)(source['signature']),
    documentation: optional(documentationText)(source['documentation']),
    edits: parseEdits(source['edits']),
    entry: optional(parseEntryRef)(source['entry']),
  };
}

function range(source: Record<string, unknown>): { readonly from: number; readonly to: number } {
  const from = count(source['from']);
  const to = count(source['to']);
  if (to < from) {
    throw new Error('Code intelligence: a range keeps its order');
  }
  assert(from >= 0, 'A range starts inside the document');
  return { from, to };
}

function parseCompletions(input: unknown): CodeCompletions {
  const source = record(input);
  const completions = {
    ...range(source),
    items: capped(CODE_INTEL_LIMITS.completionsMax, parseCompletion)(source['items']),
    exclusive: boolean(source['exclusive']),
    incomplete: boolean(source['incomplete']),
  };
  assert(completions.items.length <= CODE_INTEL_LIMITS.completionsMax, 'An answer lists a bounded number of suggestions');
  assert(completions.from <= completions.to, 'The replaced range keeps its order');
  return completions;
}

function parseDetail(input: unknown): CodeCompletionDetail {
  const source = record(input);
  return {
    signature: optional(signatureText)(source['signature']),
    documentation: optional(documentationText)(source['documentation']),
    edits: parseEdits(source['edits']),
  };
}

const parseHover = object({ from: count, to: count, signature: optional(signatureText), documentation: optional(documentationText) });

function parseHoverValue(input: unknown): CodeHover {
  const hover = parseHover(input);
  return { from: hover.from, to: hover.to, signature: hover.signature, documentation: hover.documentation };
}

function parseSignature(input: unknown): CodeSignature {
  const source = record(input);
  return {
    label: signatureText(source['label']),
    activeFrom: count(source['activeFrom']),
    activeTo: count(source['activeTo']),
    documentation: optional(documentationText)(source['documentation']),
  };
}

function parseSignatureHelp(input: unknown): CodeSignatureHelp {
  const source = record(input);
  return {
    from: count(source['from']),
    signatures: capped(CODE_INTEL_LIMITS.signaturesMax, parseSignature)(source['signatures']),
    active: count(source['active']),
  };
}

function parseDiagnostic(input: unknown): CodeDiagnostic {
  const source = record(input);
  return { ...range(source), severity: member(DIAGNOSTIC_SEVERITIES, source['severity']), message: messageText(source['message']) };
}

export function parseCodeIntelReply(input: unknown): CodeIntelReply {
  const source = record(input);
  switch (source['kind']) {
    case 'completions':
      return { kind: 'completions', completions: parseCompletions(source['completions']) };
    case 'detail':
      return { kind: 'detail', detail: parseDetail(source['detail']) };
    case 'hover':
      return { kind: 'hover', hover: optional(parseHoverValue)(source['hover']) };
    case 'signature':
      return { kind: 'signature', help: optional(parseSignatureHelp)(source['help']) };
    case 'diagnostics':
      return { kind: 'diagnostics', diagnostics: capped(CODE_INTEL_LIMITS.diagnosticsMax, parseDiagnostic)(source['diagnostics']) };
    case 'unavailable':
      return UNAVAILABLE;
    default:
      throw new Error('Code intelligence: unknown reply');
  }
}

assert(CODE_INTEL_LIMITS.requestTimeoutMs <= CODE_INTEL_LIMITS.firstRequestTimeoutMs, 'The first request is given the longest');
