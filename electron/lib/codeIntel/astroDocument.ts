// An .astro file as the type checker reads it. `@astrojs/compiler` (the compiler the app already parses pages with)
// prints the file as TSX: the frontmatter, then the template as JSX, then the component's function. Its source map is
// decoded here into offset tables in both directions, so a cursor in the file finds its place in the TSX and a TypeScript
// answer finds its way back. Only characters the two texts share are mapped: printed scaffolding maps nowhere.
import { convertToTSX } from '@astrojs/compiler/sync';
import type { DiagnosticMessage } from '@astrojs/compiler/types';

export interface AstroDocument {
  readonly code: string;
  /** The place in `code` of the cursor at `offset` of the file. */
  readonly toGenerated: (offset: number) => number | undefined;
  /** The file's range for a range of `code`; undefined when its start is scaffolding. */
  readonly toOriginal: (from: number, to: number) => { readonly from: number; readonly to: number } | undefined;
  /** What the compiler could not read, in the file's offsets. */
  readonly problems: readonly { readonly from: number; readonly to: number; readonly message: string }[];
}

const UNMAPPED = -1;
/** How far back a cursor with no mapped neighbour looks for one on its line. */
const CURSOR_SEARCH_MAX = 200;
const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function astroDocument(source: string, fileName: string): AstroDocument {
  const printed = print(source, fileName);
  if (printed === undefined) {
    return emptyDocument();
  }
  const tables = offsetTables(source, printed.code, printed.mappings);
  return {
    code: withGenericProps(printed.code),
    toGenerated: (offset) => generatedCursor(source, tables.originalToGenerated, offset),
    toOriginal: (from, to) => originalRange(tables.generatedToOriginal, from, to),
    problems: problemsIn(source, printed.diagnostics),
  };
}

// A generic `Props` is named bare in the printed `Astro` global, which is an error that leaves every prop untyped. It is
// given `any` for each parameter instead. The change is after everything mapped, so no offset moves.
function withGenericProps(code: string): string {
  const named = /\(_props: Props<([\w$ ,]+)>\): any/.exec(code)?.[1];
  if (named === undefined) {
    return code;
  }
  const any = named
    .split(',')
    .map(() => 'any')
    .join(', ');
  const at = code.lastIndexOf('AstroGlobal<Props, ');
  return at === -1 ? code : `${code.slice(0, at)}AstroGlobal<Props<${any}>, ${code.slice(at + 'AstroGlobal<Props, '.length)}`;
}

// A file the compiler cannot print at all is read as an empty component: no answers, never a crash.
function emptyDocument(): AstroDocument {
  return {
    code: 'export default function Component__AstroComponent_(_props: Record<string, any>): any {}\n',
    toGenerated: () => undefined,
    toOriginal: () => undefined,
    problems: [],
  };
}

function print(source: string, fileName: string) {
  try {
    const result = convertToTSX(source, { filename: fileName, sourcemap: 'external', includeScripts: false, includeStyles: false });
    return { code: result.code, mappings: result.map.mappings, diagnostics: result.diagnostics };
  } catch {
    return undefined;
  }
}

function offsetTables(source: string, code: string, mappings: string) {
  const generatedToOriginal = new Int32Array(code.length + 1).fill(UNMAPPED);
  const originalToGenerated = new Int32Array(source.length + 1).fill(UNMAPPED);
  const generatedLines = lineStarts(code);
  const originalLines = lineStarts(source);
  const pairs: Array<readonly [number, number]> = [];
  let originalLine = 0;
  let originalColumn = 0;
  const lines = mappings.split(';');
  for (let line = 0; line < lines.length; line++) {
    let column = 0;
    for (const segment of (lines[line] ?? '').split(',')) {
      const values = decodeSegment(segment);
      if (values.length < 4) {
        continue;
      }
      column += values[0] ?? 0;
      originalLine += values[2] ?? 0;
      originalColumn += values[3] ?? 0;
      const generated = (generatedLines[line] ?? code.length) + column;
      const original = (originalLines[originalLine] ?? source.length) + originalColumn;
      if (generated < code.length && original < source.length && code.charCodeAt(generated) === source.charCodeAt(original)) {
        pairs.push([generated, original]);
      }
    }
  }
  for (const [generated, original] of pairs) {
    generatedToOriginal[generated] = original;
    if (originalToGenerated[original] === UNMAPPED) {
      originalToGenerated[original] = generated;
    }
  }
  // The second half of a surrogate pair carries no segment of its own.
  for (const [generated, original] of pairs) {
    const next = generated + 1;
    if (generatedToOriginal[next] === UNMAPPED && code.charCodeAt(next) === source.charCodeAt(original + 1) && isLowSurrogate(code.charCodeAt(next))) {
      generatedToOriginal[next] = original + 1;
      originalToGenerated[original + 1] = next;
    }
  }
  return { generatedToOriginal, originalToGenerated };
}

function isLowSurrogate(unit: number): boolean {
  return unit >= 0xdc00 && unit <= 0xdfff;
}

function decodeSegment(segment: string): readonly number[] {
  const values: number[] = [];
  let value = 0;
  let shift = 0;
  for (const character of segment) {
    const digit = BASE64.indexOf(character);
    value += (digit & 31) * 2 ** shift;
    if ((digit & 32) !== 0) {
      shift += 5;
    } else {
      const magnitude = Math.floor(value / 2);
      values.push(value % 2 === 1 ? -magnitude : magnitude);
      value = 0;
      shift = 0;
    }
  }
  return values;
}

export function lineStarts(value: string): readonly number[] {
  const starts = [0];
  for (let index = value.indexOf('\n'); index !== -1; index = value.indexOf('\n', index + 1)) {
    starts.push(index + 1);
  }
  return starts;
}

// A cursor sits between two characters: after the one before it when that one is mapped, else before the one after it.
// Failing both (the cursor ends a line the compiler dropped trailing space from), the nearest mapped character before it.
function generatedCursor(source: string, table: Int32Array, offset: number): number | undefined {
  const before = offset > 0 ? (table[offset - 1] ?? UNMAPPED) : UNMAPPED;
  if (before !== UNMAPPED) {
    return before + 1;
  }
  const at = table[offset] ?? UNMAPPED;
  if (at !== UNMAPPED) {
    return at;
  }
  for (let back = 2; back <= Math.min(offset, CURSOR_SEARCH_MAX); back++) {
    const found = table[offset - back] ?? UNMAPPED;
    if (found !== UNMAPPED) {
      return found + 1;
    }
    if (source.charAt(offset - back) === '\n') {
      return undefined;
    }
  }
  return undefined;
}

function originalRange(table: Int32Array, from: number, to: number): { readonly from: number; readonly to: number } | undefined {
  const start = table[from] ?? UNMAPPED;
  if (start === UNMAPPED) {
    return undefined;
  }
  const last = to > from ? (table[to - 1] ?? UNMAPPED) : UNMAPPED;
  const end = last !== UNMAPPED && last >= start ? last + 1 : start + Math.max(0, to - from);
  return { from: start, to: end };
}

function problemsIn(source: string, diagnostics: readonly DiagnosticMessage[]): AstroDocument['problems'] {
  const starts = lineStarts(source);
  return diagnostics
    .filter((diagnostic) => diagnostic.severity === 1)
    .map((diagnostic) => {
      const start = starts[Math.max(0, diagnostic.location.line - 1)] ?? 0;
      const from = Math.min(source.length, start + Math.max(0, diagnostic.location.column - 1));
      return { from, to: Math.min(source.length, from + Math.max(1, diagnostic.location.length)), message: diagnostic.text };
    });
}
