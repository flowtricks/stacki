// What the TypeScript language service answers, brought into the editor's terms: completions (with a component's props
// marked required or optional, typed and documented), hover, signature help and diagnostics. For an .astro file the
// question is moved into the printed TSX and the answer moved back; what only the printed text has is dropped.
import ts from 'typescript';
import {
  CODE_INTEL_LIMITS,
  type CodeCompletion,
  type CodeCompletionDetail,
  type CodeDiagnostic,
  type CodeEdit,
  type CodeHover,
  type CodeSignatureHelp,
  type CompletionEntryRef,
  type CompletionKind,
} from '../../../shared/ipc/codeIntel';
import { frontmatterImport } from './components';
import { clip, matchRank, suggestion } from './suggestion';

/** Where a question lands: the file the language service knows, and the way between its offsets and the editor's. */
export interface Target {
  readonly file: string;
  /** The editor's text. */
  readonly text: string;
  readonly toService: (offset: number) => number | undefined;
  readonly toEditor: (from: number, to: number) => { readonly from: number; readonly to: number } | undefined;
  readonly astro: boolean;
}

export function sameTarget(file: string, text: string): Target {
  return {
    file,
    text,
    toService: (offset) => offset,
    toEditor: (from, to) => (from <= text.length ? { from, to: Math.min(to, text.length) } : undefined),
    astro: false,
  };
}

const PREFERENCES: ts.UserPreferences = {
  includeCompletionsForModuleExports: true,
  includeCompletionsForImportStatements: false,
  includeCompletionsWithInsertText: true,
  includeCompletionsWithSnippetText: false,
  includeAutomaticOptionalChainCompletions: true,
  jsxAttributeCompletionStyle: 'none',
  allowIncompleteCompletions: true,
  importModuleSpecifierPreference: 'shortest',
  quotePreference: 'single',
};

/** The files that declare what every element or component accepts: HTML, ARIA and Astro's own attributes. */
const ELEMENT_TYPES =
  /\/astro\/(astro-jsx\.d\.ts|dist\/(jsx-runtime|types\/public)\/)|\/@types\/react\/|\/typescript\/lib\/|\/typescript-lib\/|\/solid-js\/types\//;

/** Entries whose symbols are looked at, which is what naming a prop's type costs. */
const DESCRIBED_MAX = 300;
/** Suggestions kept to be asked about again. */
const REMEMBERED_MAX = 600;

export interface EntryMemory {
  readonly keep: (entry: ts.CompletionEntry) => CompletionEntryRef;
  readonly data: (reference: CompletionEntryRef) => ts.CompletionEntryData | undefined;
}

// TypeScript's own record of where a suggestion comes from stays in this process; the reference carries its number.
export function entryMemory(): EntryMemory {
  const kept = new Map<string, ts.CompletionEntryData>();
  let next = 0;
  return {
    keep: (entry) => {
      if (entry.data === undefined) {
        return { name: entry.name, source: entry.source, data: undefined };
      }
      next += 1;
      const key = String(next);
      kept.set(key, entry.data);
      const oldest = kept.keys().next();
      if (kept.size > REMEMBERED_MAX && oldest.done !== true) {
        kept.delete(oldest.value);
      }
      return { name: entry.name, source: entry.source, data: key };
    },
    data: (reference) => (reference.data === undefined ? undefined : kept.get(reference.data)),
  };
}

export interface TypeSuggestions {
  readonly items: readonly CodeCompletion[];
  readonly from: number;
  readonly to: number;
  readonly typed: string;
}

export interface Asked {
  readonly position: number;
  /** A component's attribute: its props are described one by one. */
  readonly attribute: boolean;
}

export function typeSuggestions(service: ts.LanguageService, target: Target, asked: Asked, memory: EntryMemory): TypeSuggestions | undefined {
  const at = target.toService(asked.position);
  if (at === undefined) {
    return undefined;
  }
  const answer = service.getCompletionsAtPosition(target.file, at, PREFERENCES);
  if (answer === undefined) {
    return undefined;
  }
  const word = (asked.attribute ? /[\w$:@.-]*$/ : /[\w$]*$/).exec(target.text.slice(Math.max(0, asked.position - 200), asked.position))?.[0] ?? '';
  const replacedFrom = (span: ts.TextSpan | undefined): number | undefined => {
    const range = span === undefined ? undefined : target.toEditor(span.start, span.start + span.length);
    return range !== undefined && range.from <= asked.position ? range.from : undefined;
  };
  // Inside a string TypeScript says what it replaces: the whole literal's text, or a path's last part. A name that is
  // not an identifier says so too, but only for itself (below).
  const plain = answer.entries.find((entry) => entry.insertText === undefined)?.replacementSpan ?? answer.optionalReplacementSpan;
  const from = replacedFrom(plain) ?? asked.position - word.length;
  const typed = target.text.slice(from, asked.position);
  const matching = answer.entries
    .filter((entry) => !entry.name.includes('__AstroComponent_') && matchRank(entry.name, typed) !== undefined)
    // A name not yet typed would bring in every export of every module.
    .filter((entry) => entry.source === undefined || typed.length > 0 || entry.hasAction !== true);
  matching.sort((left, right) => (matchRank(left.name, typed) ?? 2) - (matchRank(right.name, typed) ?? 2) || left.sortText.localeCompare(right.sortText));
  const items = matching.slice(0, asked.attribute ? DESCRIBED_MAX : CODE_INTEL_LIMITS.completionsMax + 1).map((entry) => {
    if (asked.attribute) {
      return attributeSuggestion(service, target, { entry, at, asked }, memory);
    }
    // `styles['title-bar']` takes the place of the dot before it: what is replaced beyond the list's range goes first.
    const reaches = replacedFrom(entry.replacementSpan);
    return suggestion(entry.name, completionKind(entry.kind), {
      edits: reaches !== undefined && reaches < from ? [{ from: reaches, to: from, insert: '' }] : [],
      detail: entry.source === undefined ? undefined : cleanedSource(entry.source),
      insert: entry.insertText === undefined || entry.insertText === entry.name ? undefined : entry.insertText,
      boost: -Number.parseInt(entry.sortText, 10) || 0,
      entry: memory.keep(entry),
    });
  });
  return { items, from, to: asked.position, typed };
}

interface Described {
  readonly entry: ts.CompletionEntry;
  readonly at: number;
  readonly asked: Asked;
}

function attributeSuggestion(service: ts.LanguageService, target: Target, described: Described, memory: EntryMemory): CodeCompletion {
  const { entry, at, asked } = described;
  const symbol = service.getCompletionEntrySymbol(target.file, at, entry.name, entry.source);
  const program = service.getProgram();
  if (symbol === undefined || program === undefined) {
    return suggestion(entry.name, 'property', { entry: memory.keep(entry) });
  }
  const checker = program.getTypeChecker();
  const declarations = symbol.getDeclarations() ?? [];
  // A component's own props rank above the attributes every element or every component has.
  const own = declarations.length === 0 || declarations.some((declaration) => !ELEMENT_TYPES.test(declaration.getSourceFile().fileName));
  const type = checker.getTypeOfSymbol(symbol);
  const optional = (symbol.flags & ts.SymbolFlags.Optional) !== 0;
  const written = clip(checker.typeToString(checker.getNonNullableType(type)), CODE_INTEL_LIMITS.labelCharsMax);
  const documentation = documented(ts.displayPartsToString(symbol.getDocumentationComment(checker)), symbol.getJsDocTags(checker));
  const required = own && !optional;
  const insert = attributeInsert(entry.name, checker.getNonNullableType(type), target.text.slice(asked.position, asked.position + 1));
  return suggestion(entry.name, 'property', {
    detail: written,
    insert: insert?.insert,
    cursor: insert?.cursor,
    boost: required ? 30 : own ? 20 : entry.name.includes(':') ? -10 : 0,
    required,
    signature: `${/^[A-Za-z_$][\w$]*$/.test(entry.name) ? entry.name : `'${entry.name}'`}${optional ? '?' : ''}: ${written}`,
    documentation,
  });
}

// A flag is written alone, a string between quotes and anything else between braces, with the cursor left inside.
function attributeInsert(name: string, type: ts.Type, following: string): { readonly insert: string; readonly cursor: number } | undefined {
  if (following === '=' || name.includes(':')) {
    return undefined;
  }
  const members = type.isUnion() ? type.types : [type];
  const every = (flags: ts.TypeFlags): boolean => members.every((member) => (member.flags & flags) !== 0);
  if (every(ts.TypeFlags.BooleanLike)) {
    return undefined;
  }
  const quoted = every(ts.TypeFlags.StringLike | ts.TypeFlags.NonPrimitive) || members.every((member) => member.isStringLiteral() || isOpenString(member));
  return { insert: quoted ? `${name}=""` : `${name}={}`, cursor: name.length + 2 };
}

function isOpenString(type: ts.Type): boolean {
  // `string`, and the `string & {}` that keeps a union's literals suggestible.
  return (type.flags & ts.TypeFlags.StringLike) !== 0 || (type.isIntersection() && type.types.some((part) => (part.flags & ts.TypeFlags.StringLike) !== 0));
}

export function typeDetail(
  service: ts.LanguageService,
  target: Target,
  asked: { readonly position: number; readonly entry: CompletionEntryRef },
  memory: EntryMemory,
): CodeCompletionDetail | undefined {
  const at = target.toService(asked.position);
  if (at === undefined) {
    return undefined;
  }
  const { name, source } = asked.entry;
  const details = service.getCompletionEntryDetails(target.file, at, name, {}, source, PREFERENCES, memory.data(asked.entry));
  if (details === undefined) {
    return undefined;
  }
  const edits: CodeEdit[] = [];
  for (const change of (details.codeActions ?? []).flatMap((action) => action.changes)) {
    if (change.fileName !== target.file) {
      continue;
    }
    for (const textChange of change.textChanges) {
      const edit = editorEdit(target, textChange);
      if (edit !== undefined && edits.length < CODE_INTEL_LIMITS.editsMax) {
        edits.push(edit);
      }
    }
  }
  return {
    signature: shown(ts.displayPartsToString(details.displayParts)),
    documentation: documented(ts.displayPartsToString(details.documentation), details.tags ?? []),
    edits,
  };
}

function editorEdit(target: Target, change: ts.TextChange): CodeEdit | undefined {
  // TypeScript places a new import at the top of the printed TSX, above anything the file has: it goes in the
  // frontmatter instead.
  if (target.astro && /^\s*import\s/.test(change.newText)) {
    const statement = change.newText.trim();
    return frontmatterImport(target.text, () => statement);
  }
  const range = target.toEditor(change.span.start, change.span.start + change.span.length);
  if (range === undefined || (change.span.length > 0 && range.to === range.from)) {
    return undefined;
  }
  return { from: range.from, to: range.to, insert: change.newText.replace(/\r\n/g, '\n') };
}

export function typeHover(service: ts.LanguageService, target: Target, position: number): CodeHover | undefined {
  const at = target.toService(position);
  if (at === undefined) {
    return undefined;
  }
  const info = service.getQuickInfoAtPosition(target.file, at);
  if (info === undefined) {
    return undefined;
  }
  const range = target.toEditor(info.textSpan.start, info.textSpan.start + info.textSpan.length);
  if (range === undefined || position < range.from || position > range.to) {
    return undefined;
  }
  return {
    ...range,
    signature: shown(ts.displayPartsToString(info.displayParts)),
    documentation: documented(ts.displayPartsToString(info.documentation), info.tags ?? []),
  };
}

export function typeSignature(service: ts.LanguageService, target: Target, position: number): CodeSignatureHelp | undefined {
  const at = target.toService(position);
  if (at === undefined) {
    return undefined;
  }
  const help = service.getSignatureHelpItems(target.file, at, {});
  if (help === undefined) {
    return undefined;
  }
  const start = target.toEditor(help.applicableSpan.start, help.applicableSpan.start + help.applicableSpan.length);
  const shownFrom = Math.max(0, help.selectedItemIndex - Math.floor(CODE_INTEL_LIMITS.signaturesMax / 2));
  const items = help.items.slice(shownFrom, shownFrom + CODE_INTEL_LIMITS.signaturesMax);
  return {
    from: Math.min(position, start?.from ?? position),
    active: Math.max(0, help.selectedItemIndex - shownFrom),
    signatures: items.map((item) => {
      const separator = ts.displayPartsToString(item.separatorDisplayParts);
      let label = ts.displayPartsToString(item.prefixDisplayParts);
      let activeFrom = 0;
      let activeTo = 0;
      item.parameters.forEach((parameter, index) => {
        label += index === 0 ? '' : separator;
        const written = ts.displayPartsToString(parameter.displayParts);
        const rest = index === item.parameters.length - 1 && item.isVariadic;
        if (index === help.argumentIndex || (rest && help.argumentIndex > index)) {
          activeFrom = label.length;
          activeTo = label.length + written.length;
        }
        label += written;
      });
      label += ts.displayPartsToString(item.suffixDisplayParts);
      const parameter = item.parameters[Math.min(help.argumentIndex, item.parameters.length - 1)];
      const text = [parameter === undefined ? '' : ts.displayPartsToString(parameter.documentation), ts.displayPartsToString(item.documentation)]
        .filter((part) => part !== '')
        .join('\n\n');
      return {
        label: clip(label, CODE_INTEL_LIMITS.signatureCharsMax),
        activeFrom: Math.min(activeFrom, CODE_INTEL_LIMITS.signatureCharsMax),
        activeTo: Math.min(activeTo, CODE_INTEL_LIMITS.signatureCharsMax),
        documentation: text === '' ? undefined : clip(text, CODE_INTEL_LIMITS.documentationCharsMax),
      };
    }),
  };
}

// Reported of the printed TSX and not of the .astro file: it has no single root, no `--jsx` of the project's own, and
// a frontmatter that returns and awaits at the top level.
const PRINTED_ONLY: ReadonlySet<number> = new Set([1108, 1308, 1375, 1378, 2657, 2686, 2695, 6192, 7026, 17004]);

export interface Checking {
  /** Only mistakes in the writing itself: for a project whose dependencies are not installed, whose types would all be missing. */
  readonly syntaxOnly: boolean;
}

export function typeDiagnostics(service: ts.LanguageService, target: Target, checking: Checking): CodeDiagnostic[] {
  const found: CodeDiagnostic[] = [];
  const all: readonly ts.Diagnostic[] = [
    ...service.getSyntacticDiagnostics(target.file),
    ...(checking.syntaxOnly ? [] : service.getSemanticDiagnostics(target.file)),
  ];
  for (const diagnostic of all) {
    if (found.length >= CODE_INTEL_LIMITS.diagnosticsMax) {
      break;
    }
    if (diagnostic.start === undefined || (target.astro && PRINTED_ONLY.has(diagnostic.code))) {
      continue;
    }
    const range = target.toEditor(diagnostic.start, diagnostic.start + (diagnostic.length ?? 0));
    if (range === undefined) {
      continue;
    }
    found.push({
      ...range,
      severity: diagnostic.category === ts.DiagnosticCategory.Error ? 'error' : diagnostic.category === ts.DiagnosticCategory.Warning ? 'warning' : 'info',
      message: clip(`${shown(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')) ?? ''} (ts ${diagnostic.code})`, CODE_INTEL_LIMITS.messageCharsMax),
    });
  }
  return found;
}

// The printed component's function has a name of its own, which no one wrote.
function shown(text: string): string | undefined {
  const cleaned = text
    .replace(/function (\w+?)(?:__AstroComponent_)?(<[^(]*>)?\(_props: ([\s\S]*?)\): any/g, 'component $1$2(props: $3)')
    .replace(/(\w+?)__AstroComponent_/g, '$1');
  return cleaned === '' ? undefined : clip(cleaned, CODE_INTEL_LIMITS.signatureCharsMax);
}

function documented(text: string, tags: readonly ts.JSDocTagInfo[]): string | undefined {
  const lines = tags.map((tag) => {
    const body = tag.text === undefined ? '' : ts.displayPartsToString(tag.text);
    return `@${tag.name}${body === '' ? '' : ` ${body}`}`;
  });
  const all = [text, lines.join('\n')].filter((part) => part !== '').join('\n\n');
  return all === '' ? undefined : clip(all, CODE_INTEL_LIMITS.documentationCharsMax);
}

function cleanedSource(source: string): string {
  const modules = source.lastIndexOf('/node_modules/');
  return modules === -1 ? source : source.slice(modules + '/node_modules/'.length);
}

const KINDS: ReadonlyMap<ts.ScriptElementKind, CompletionKind> = new Map<ts.ScriptElementKind, CompletionKind>([
  [ts.ScriptElementKind.keyword, 'keyword'],
  [ts.ScriptElementKind.functionElement, 'function'],
  [ts.ScriptElementKind.localFunctionElement, 'function'],
  [ts.ScriptElementKind.memberFunctionElement, 'method'],
  [ts.ScriptElementKind.memberVariableElement, 'property'],
  [ts.ScriptElementKind.memberGetAccessorElement, 'property'],
  [ts.ScriptElementKind.memberSetAccessorElement, 'property'],
  [ts.ScriptElementKind.jsxAttribute, 'property'],
  [ts.ScriptElementKind.variableElement, 'variable'],
  [ts.ScriptElementKind.localVariableElement, 'variable'],
  [ts.ScriptElementKind.letElement, 'variable'],
  [ts.ScriptElementKind.parameterElement, 'variable'],
  [ts.ScriptElementKind.constElement, 'constant'],
  [ts.ScriptElementKind.classElement, 'class'],
  [ts.ScriptElementKind.interfaceElement, 'interface'],
  [ts.ScriptElementKind.typeElement, 'type'],
  [ts.ScriptElementKind.primitiveType, 'type'],
  [ts.ScriptElementKind.typeParameterElement, 'type'],
  [ts.ScriptElementKind.enumElement, 'enum'],
  [ts.ScriptElementKind.enumMemberElement, 'value'],
  [ts.ScriptElementKind.string, 'value'],
  [ts.ScriptElementKind.moduleElement, 'module'],
  [ts.ScriptElementKind.externalModuleName, 'module'],
  [ts.ScriptElementKind.alias, 'module'],
  [ts.ScriptElementKind.directory, 'folder'],
  [ts.ScriptElementKind.scriptElement, 'file'],
]);

function completionKind(kind: ts.ScriptElementKind): CompletionKind {
  return KINDS.get(kind) ?? 'text';
}
