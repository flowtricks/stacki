// Shared by the file writer and the frontmatter code editor. Imports remain
// editable records; their slots retain the code and whitespace between them.
// No renderer or Node dependencies: this module is also loaded by Astro.

import { assert } from '../core/assert';

import type { ImportMember, ImportSlot, FrontmatterLayout } from './frontmatter';
export type { ImportMember, ImportSlot, FrontmatterLayout } from './frontmatter';

type SerializableImport = Omit<ImportMember, 'at'> & { readonly at?: number };

export interface FrontmatterModel<Import extends SerializableImport = ImportMember> {
  readonly imports: readonly Import[];
  readonly frontmatterLead: string;
  readonly extraFrontmatter: string;
  readonly extraFrontmatterSpaced: boolean;
  readonly frontmatterLayout?: FrontmatterLayout;
}

const DEFAULT_IMPORT = /import\s+([A-Za-z_$][\w$]*)\s+from\s+(['"])([^'"]+)\2;?/y;
const NAMED_IMPORT = /import\s*\{([^}]*)\}\s*from\s*(['"])([^'"]+)\2;?/y;
const MEMBER = /^(type\s+)?([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/;

function skipQuoted(text: string, start: number): number {
  const quote = text.charAt(start);
  assert('\'"`'.includes(quote), 'skipQuoted: starts at a quote');
  let i = start + 1;
  for (; i < text.length; i++) {
    if (text.charAt(i) === '\\') {
      i++;
    } else if (text.charAt(i) === quote) {
      return i + 1;
    } else if (quote === '`' && text.charAt(i) === '$' && text.charAt(i + 1) === '{') {
      i = skipBraced(text, i + 1) - 1;
    }
  }
  assert(i > start, 'skipQuoted: a quoted run consumes its opening quote');
  return i;
}

function skipCodeToken(text: string, i: number): number {
  if ('\'"`'.includes(text.charAt(i))) {
    return skipQuoted(text, i);
  }
  if (text.startsWith('//', i)) {
    const end = text.indexOf('\n', i + 2);
    return end < 0 ? text.length : end;
  }
  if (text.startsWith('/*', i)) {
    const end = text.indexOf('*/', i + 2);
    return end < 0 ? text.length : end + 2;
  }
  // A regex can contain import-looking prose just as a string can.
  let before = i - 1;
  if (text.charAt(i) === '/') {
    while (before >= 0 && /\s/.test(text.charAt(before))) {
      before--;
    }
  }
  const previous = before >= 0 ? text.charAt(before) : undefined;
  if (text.charAt(i) === '/' && (before < 0 || (previous !== undefined && '=(:,[!&|?{};'.includes(previous)))) {
    let inClass = false;
    for (let j = i + 1; j < text.length && text.charAt(j) !== '\n'; j++) {
      if (text.charAt(j) === '\\') {
        j++;
      } else if (text.charAt(j) === '[') {
        inClass = true;
      } else if (text.charAt(j) === ']') {
        inClass = false;
      } else if (text.charAt(j) === '/' && !inClass) {
        return j + 1;
      }
    }
  }
  return i;
}

function skipBraced(text: string, start: number): number {
  assert(text.charAt(start) === '{', 'skipBraced: starts at an opening brace');
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const skipped = skipCodeToken(text, i);
    if (skipped !== i) {
      i = skipped - 1;
      continue;
    }
    if (text.charAt(i) === '{') {
      depth++;
    } else if (text.charAt(i) === '}' && --depth === 0) {
      return i + 1;
    }
  }
  return text.length;
}

// One import statement the editor models as records, parsed at `at`.
interface ParsedImport {
  readonly members: readonly ImportMember[];
  // Offset just past the statement, its import attributes and its semicolon.
  readonly end: number;
  // Offset just past the quoted specifier, inside the statement's own text.
  readonly pathEnd: number;
}

function readFrontmatter(source = ''): FrontmatterModel {
  const imports: ImportMember[] = [];
  const slots: ImportSlot[] = [];
  let cursor = 0;
  let extra = '';
  for (let i = 0; i < source.length; i++) {
    const skipped = skipCodeToken(source, i);
    if (skipped !== i) {
      i = skipped - 1;
      continue;
    }
    if (!source.startsWith('import', i) || /[\w$.]/.test(source.charAt(i - 1))) {
      continue;
    }
    const parsed = parseImportAt(source, i);
    if (parsed === undefined) {
      continue;
    }
    extra += source.slice(cursor, i);
    const suffix = /^[ \t]*\r?\n/.exec(source.slice(parsed.end))?.[0] || '';
    const raw = source.slice(i, parsed.end);
    slots.push({
      at: i,
      offset: extra.length,
      source: raw,
      suffix,
      tail: raw.slice(parsed.pathEnd),
      members: parsed.members.map((member) => ({ ...member })),
    });
    imports.push(...parsed.members);
    cursor = parsed.end + suffix.length;
    assert(cursor > i, 'readFrontmatter: every modelled import consumes source');
    i = cursor - 1;
  }
  extra += source.slice(cursor);
  return {
    imports,
    // All declarations stay visible to binding/schema editors, including
    // those preceding the first import. Slots preserve their source position.
    frontmatterLead: '',
    extraFrontmatter: extra.trim(),
    extraFrontmatterSpaced: /^[ \t]*\r?\n/.test(extra),
    frontmatterLayout: { extra, slots },
  };
}

// Namespace, side-effect and type-only imports stay code, and so does an
// unfamiliar specifier: it is kept verbatim instead of extracting half of it.
function parseImportAt(source: string, at: number): ParsedImport | undefined {
  DEFAULT_IMPORT.lastIndex = NAMED_IMPORT.lastIndex = at;
  const plain = DEFAULT_IMPORT.exec(source);
  const match = plain ?? NAMED_IMPORT.exec(source);
  if (match === null) {
    return undefined;
  }
  const quote = match[2];
  const specifier = match[3];
  const body = match[1];
  if (quote === undefined || specifier === undefined || body === undefined) {
    return undefined;
  }
  const members = plain === null ? namedMembers(body, specifier, quote, at) : [{ name: body, path: specifier, quote, at }];
  if (members === undefined) {
    return undefined;
  }
  let end = at + match[0].length;
  const attribute = /^[ \t]*(?:with|assert)\s*\{/.exec(source.slice(end));
  if (attribute) {
    end = skipBraced(source, end + attribute[0].length - 1);
    if (source.charAt(end) === ';') {
      end++;
    }
  }
  const pathEnd = match[0].lastIndexOf(quote + specifier + quote) + specifier.length + 2;
  assert(end > at, 'parseImportAt: an import statement is not empty');
  return { members, end, pathEnd };
}

// The members of `import { … }`, or undefined when there are none or one of
// them is not a plain `[type] name [as alias]`.
function namedMembers(body: string, specifier: string, quote: string, at: number): ImportMember[] | undefined {
  const members: ImportMember[] = [];
  const texts = body
    .split(',')
    .map((text) => text.trim())
    .filter(Boolean);
  for (const text of texts) {
    const member = MEMBER.exec(text);
    if (member === null || member[2] === undefined) {
      return undefined;
    }
    const [typePrefix, imported, alias] = [member[1], member[2], member[3]];
    members.push({
      name: alias || imported,
      imported,
      named: true,
      path: specifier,
      quote,
      at,
      ...(typePrefix ? { typeOnly: true } : {}),
    });
  }
  return members.length > 0 ? members : undefined;
}

const sameImport = <Import extends SerializableImport>(candidate: Import, existing: SerializableImport, specFor?: (imp: Import) => string): boolean =>
  candidate.name === existing.name &&
  (specFor ? specFor(candidate) : candidate.path) === existing.path &&
  candidate.quote === existing.quote &&
  !!candidate.named === !!existing.named &&
  candidate.imported === existing.imported &&
  !!candidate.typeOnly === !!existing.typeOnly;

interface ImportGroup<Import extends SerializableImport> {
  members: Import[];
  specifier: string;
}

function importLines<Import extends SerializableImport>(imports: readonly Import[], tail: string, specFor?: (imp: Import) => string): string[] {
  const groups: ImportGroup<Import>[] = [];
  const named = new Map<string, ImportGroup<Import>>();
  for (const imp of imports) {
    const specifier = specFor ? specFor(imp) : imp.path;
    if (!imp.named) {
      groups.push({ members: [imp], specifier });
      continue;
    }
    let group = named.get(specifier);
    if (!group) {
      group = { members: [], specifier };
      groups.push(group);
      named.set(specifier, group);
    }
    group.members.push(imp);
  }
  return groups.map(({ members, specifier }) => {
    const first = members[0];
    if (first === undefined) {
      return '';
    }
    const quote = first.quote === '"' ? '"' : "'";
    const names = first.named
      ? '{ ' +
        members
          .map((imp) => {
            const name = imp.imported && imp.imported !== imp.name ? `${imp.imported} as ${imp.name}` : imp.name;
            return imp.typeOnly ? `type ${name}` : name;
          })
          .join(', ') +
        ' }'
      : first.name;
    return `import ${names} from ${quote}${specifier}${quote}${tail}`;
  });
}

// Preserve the whitespace outside the editable code field. The code editor
// sees that whitespace directly through writeFrontmatter/readFrontmatter;
// declaration fields edit the trimmed code without removing its surroundings.
function withWhitespace(raw: string, value = ''): string {
  if (value === raw.trim()) {
    return raw;
  }
  const from = raw.length - raw.trimStart().length;
  const to = Math.max(from, raw.trimEnd().length);
  const result = raw.slice(0, from) + value + raw.slice(to);
  // Only the whitespace around the old value is kept.
  assert(result.trim() === value.trim(), 'withWhitespace: the value is replaced whole');
  return result;
}

// Map import slots through edits to the declarations field. Work on lines so
// an import can never land inside an edited string or identifier. Trim the
// unchanged ends first: changing one line in a large collection stays cheap.
function moveOffsets(before: string, after: string, offsets: readonly number[]): number[] {
  if (before === after || !offsets.length) {
    return [...offsets];
  }
  const split = (text: string): string[] => text.match(/[^\n]*\n|[^\n]+$/g) || [];
  const beforeLines = split(before);
  const afterLines = split(after);
  let first = 0;
  while (first < beforeLines.length && first < afterLines.length && beforeLines[first] === afterLines[first]) {
    first++;
  }
  let beforeEnd = beforeLines.length;
  let afterEnd = afterLines.length;
  while (beforeEnd > first && afterEnd > first && beforeLines[beforeEnd - 1] === afterLines[afterEnd - 1]) {
    beforeEnd--;
    afterEnd--;
  }
  const dp = commonLinesTable(beforeLines.slice(first, beforeEnd), afterLines.slice(first, afterEnd));
  const moved: number[] = [];
  let oldAt = 0;
  let newAt = 0;
  let slot = 0;
  // A kept line carries its slots along; a changed one moves them to its start.
  const take = (oldText: string, newText: string, line: 'kept' | 'changed'): void => {
    const end = oldAt + oldText.length;
    while (slot < offsets.length && (offsets[slot] ?? 0) < end) {
      moved.push(newAt + (line === 'kept' ? (offsets[slot] ?? 0) - oldAt : 0));
      slot++;
    }
    oldAt = end;
    newAt += newText.length;
  };
  for (let i = 0; i < first; i++) {
    take(beforeLines[i] ?? '', afterLines[i] ?? '', 'kept');
  }
  let i = first;
  let j = first;
  while (i < beforeEnd || j < afterEnd) {
    if (i < beforeEnd && j < afterEnd && beforeLines[i] === afterLines[j]) {
      take(beforeLines[i++] ?? '', afterLines[j++] ?? '', 'kept');
    } else if (i < beforeEnd && (j === afterEnd || !dp.length || (dp[i - first + 1]?.[j - first] ?? 0) >= (dp[i - first]?.[j - first + 1] ?? 0))) {
      take(beforeLines[i++] ?? '', '', 'changed');
    } else {
      take('', afterLines[j++] ?? '', 'changed');
    }
  }
  while (i < beforeLines.length) {
    take(beforeLines[i++] ?? '', afterLines[j++] ?? '', 'kept');
  }
  while (slot++ < offsets.length) {
    moved.push(newAt);
  }
  assert(moved.length === offsets.length, 'moveOffsets: every slot is moved');
  return safeImportOffsets(after, moved);
}

// Longest-common-subsequence lengths of two line runs: cell [i][j] counts the
// lines the runs share from `before[i]` and `after[j]` on. A wholesale
// replacement has no useful interior anchors, so past the bound the table is
// empty and the caller keeps its imports in order at the replacement's start.
function commonLinesTable(before: readonly string[], after: readonly string[]): Uint32Array[] {
  const table: Uint32Array[] = [];
  if (before.length * after.length > 262144) {
    return table;
  }
  for (let i = 0; i <= before.length; i++) {
    table.push(new Uint32Array(after.length + 1));
  }
  for (let i = before.length - 1; i >= 0; i--) {
    for (let j = after.length - 1; j >= 0; j--) {
      const row = table[i];
      assert(row !== undefined, 'commonLinesTable: every row was allocated');
      row[j] = before[i] === after[j] ? (table[i + 1]?.[j + 1] ?? 0) + 1 : Math.max(table[i + 1]?.[j] ?? 0, table[i]?.[j + 1] ?? 0);
    }
  }
  return table;
}

// Matching a line inside a newly added template or function does not make it
// a legal place for an import. Advance displaced slots to a statement boundary
// outside strings, comments and nested expressions; keep their relative order.
function safeImportOffsets(text: string, offsets: readonly number[]): number[] {
  const safe: number[] = [];
  let slot = 0;
  let depth = 0;
  let lineStart = true;
  let ended = true;
  let previous = '';
  for (let i = 0; i < text.length && slot < offsets.length; i++) {
    if (!depth && (ended || (lineStart && !'=(:,[!&|?+-*/.'.includes(previous)))) {
      while (slot < offsets.length && (offsets[slot] ?? 0) <= i) {
        safe.push(i);
        slot++;
      }
    }
    const skipped = skipCodeToken(text, i);
    if (skipped !== i) {
      if (text.charAt(i) !== '/') {
        previous = text.charAt(i);
        lineStart = ended = false;
      }
      i = skipped - 1;
      continue;
    }
    const char = text.charAt(i);
    if (char === '\n') {
      lineStart = true;
      continue;
    }
    if (/\s/.test(char)) {
      continue;
    }
    if ('([{'.includes(char)) {
      depth++;
    } else if (')]}'.includes(char)) {
      depth--;
    }
    ended = char === ';' && depth === 0;
    lineStart = false;
    previous = char;
  }
  while (slot++ < offsets.length) {
    safe.push(text.length);
  }
  assert(safe.length === offsets.length, 'safeImportOffsets: every slot keeps a place');
  assert(
    safe.every((offset) => offset <= text.length),
    'safeImportOffsets: every place is inside the text',
  );
  return safe;
}

function writeFrontmatter<Import extends SerializableImport>(model: FrontmatterModel<Import>, specFor?: (imp: Import) => string): string {
  const layout = model.frontmatterLayout;
  if (!layout) {
    return writeFrontmatterFresh(model, specFor);
  }
  const { groups, additions } = groupImports(layout, model.imports || []);
  const extra = withWhitespace(layout.extra, model.extraFrontmatter);
  const offsets = moveOffsets(
    layout.extra,
    extra,
    layout.slots.map((slot) => slot.offset),
  );
  let output = model.frontmatterLead ? model.frontmatterLead + '\n' : '';
  let from = 0;
  for (let i = 0; i < layout.slots.length; i++) {
    const slot = layout.slots[i];
    assert(slot !== undefined, 'writeFrontmatter: slot index in bounds');
    const members = groups.get(slot.at) ?? [];
    output += extra.slice(from, offsets[i]);
    from = offsets[i] ?? from;
    if (members.length) {
      if (extra !== layout.extra && from === extra.length && output && !/\n$/.test(output)) {
        output += '\n';
      }
      const untouched =
        members.length === slot.members.length &&
        members.every((imp, index) => {
          const original = slot.members[index];
          return original !== undefined && sameImport(imp, original, specFor);
        });
      output += (untouched ? slot.source : importLines(members, slot.tail, specFor).join('\n')) + slot.suffix;
    }
    if (i === layout.slots.length - 1 && additions.length) {
      if (output && !/\n$/.test(output)) {
        output += '\n';
      }
      output += importLines(additions, ';', specFor).join('\n');
      if (extra.slice(from)) {
        output += '\n';
      }
    }
  }
  if (!layout.slots.length && additions.length) {
    from = extra.length - extra.trimStart().length;
    output += extra.slice(0, from);
    output += importLines(additions, ';', specFor).join('\n');
    if (extra.slice(from)) {
      output += '\n';
    }
  }
  return output + extra.slice(from);
}

// No layout to preserve: the imports, then the remaining code below a blank line.
function writeFrontmatterFresh<Import extends SerializableImport>(model: FrontmatterModel<Import>, specFor?: (imp: Import) => string): string {
  const lines: string[] = [];
  if (model.frontmatterLead) {
    lines.push(model.frontmatterLead);
  }
  lines.push(...importLines(model.imports || [], ';', specFor));
  if (model.extraFrontmatter) {
    if (lines.length && model.extraFrontmatterSpaced !== false) {
      lines.push('');
    }
    lines.push(model.extraFrontmatter);
  }
  return lines.join('\n');
}

// Sorts imports into the slots they were read from. A newly used named export
// can join its existing declaration; any other new import is an addition.
// Separate declarations already in the source keep their individual positions.
function groupImports<Import extends SerializableImport>(
  layout: FrontmatterLayout,
  imports: readonly Import[],
): { readonly groups: ReadonlyMap<number, Import[]>; readonly additions: readonly Import[] } {
  const groups = new Map<number, Import[]>(layout.slots.map((slot) => [slot.at, []]));
  const added: Import[] = [];
  for (const imp of imports) {
    const group = imp.at === undefined ? undefined : groups.get(imp.at);
    if (group) {
      group.push(imp);
    } else {
      added.push(imp);
    }
  }
  const additions: Import[] = [];
  for (const imp of added) {
    const slot =
      imp.named && layout.slots.find((layoutSlot) => (groups.get(layoutSlot.at) ?? []).some((grouped) => grouped.named && grouped.path === imp.path));
    if (slot) {
      const target = groups.get(slot.at);
      assert(target !== undefined, 'groupImports: slot group exists — groups were built from layout.slots');
      target.push(imp);
    } else {
      additions.push(imp);
    }
  }
  assert(additions.length <= imports.length, 'groupImports: additions come from the imports');
  return { groups, additions };
}

export { readFrontmatter, writeFrontmatter };

// Rebase only lexical module specifiers. Strings, comments, and regular expressions are
// skipped so a preview copy never rewrites prose that happens to resemble an import.
export function mapModuleSpecifiers(source: string, map: (path: string) => string): string {
  const edits: { readonly start: number; readonly end: number; readonly text: string }[] = [];
  for (let index = 0; index < source.length; index++) {
    const skipped = skipCodeToken(source, index);
    if (skipped !== index) {
      index = skipped - 1;
      continue;
    }
    if (/[\w$.]/.test(source.charAt(index - 1))) {
      continue;
    }
    const match = /^(?:import\s*(?:\(\s*)?|from\s+)(['"])([^'"\\\r\n]+)\1/.exec(source.slice(index));
    const path = match?.[2];
    if (match && path) {
      const end = index + match[0].length;
      const start = end - path.length - 2;
      const mapped = map(path);
      // One that does not change keeps the quotes it was written with.
      if (mapped !== path) {
        edits.push({ start, end, text: JSON.stringify(mapped) });
      }
      index = end - 1;
    }
  }
  let result = source;
  let nextStart = source.length;
  for (const edit of edits.reverse()) {
    assert(edit.end <= nextStart, 'Module replacements do not overlap');
    assert(source.charAt(edit.start) === source.charAt(edit.end - 1), 'Module replacement consumes a complete quoted specifier');
    nextStart = edit.start;
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  }
  assert(edits.length <= source.length, 'Module edits are bounded by source tokens');
  assert(typeof result === 'string', 'Module rebasing produces source text');
  return result;
}
