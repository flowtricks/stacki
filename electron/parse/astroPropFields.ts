// A Props type read field by field: its members and their docs, aliases
// expanded, and the defaults a component destructures from Astro.props.

import { LIMITS } from '../../shared/core/limits';
import type { PropUnion, SchemaField } from './astroParserTypes';
import { required } from './astroAttrs';
import { assert } from '../../shared/core/assert';
import { findMatchingBrace } from './astroScan';
import { splitTypeTop, explodeMembers, statedDefault, numberRules, normalizeType, shownTypeText, MEMBER_NAME_SOURCE, memberName } from './astroPropTypes';

// One member, `name?: type`, with a quoted name allowed.
const MEMBER_RE = new RegExp(String.raw`^(?:readonly\s+)?${MEMBER_NAME_SOURCE}\??\s*:\s*([\s\S]+)$`);
const MEMBER_FLAT_RE = new RegExp(String.raw`^(?:readonly\s+)?${MEMBER_NAME_SOURCE}\??\s*:\s*(.+?),?$`);
const ENTRY_RE = new RegExp(String.raw`^\s*(?:readonly\s+)?${MEMBER_NAME_SOURCE}(\?)?\s*:\s*([\s\S]+?)[;,]?\s*$`);
const ENTRY_OPEN_RE = new RegExp(String.raw`^(?:readonly\s+)?${MEMBER_NAME_SOURCE}\??\s*:\s*$`);
const ENTRY_JOINED_RE = new RegExp(String.raw`^(?:readonly\s+)?${MEMBER_NAME_SOURCE}(\?)?\s*:\s*(.+?)[;,]?\s*$`);

export function parsePropSchemaExpandAlias(aliases: ReadonlyMap<string, string>, part: string, seen = new Set<string>()): string[] {
  const body = aliases.get(part);
  // `seen` gains one alias per expansion, so its size bounds how deep the expansion has gone.
  const depth = seen.size;
  if (!body || seen.has(part) || /[{}]/.test(body) || depth >= LIMITS.treeDepthMax) {
    return [part];
  }
  seen.add(part);
  return splitTypeTop(body, '|').flatMap((part) => parsePropSchemaExpandAlias(aliases, part.trim(), seen));
}

function parsePropSchemaShapeOf(aliases: ReadonlyMap<string, string>, parts: readonly string[]) {
  // A union of two different shapes has no one shape to offer.
  if (parts.length !== 1) {
    return undefined;
  }
  // `readonly T[]` and `ReadonlyArray<T>` are the same list of T as `T[]`: the
  // List property form writes the readonly spelling (AGENTS.md §7).
  const only = required(parts[0], 'Shape has exactly one type')
    .trim()
    .replace(/^readonly\s+/, '');
  const arrayMatch = only.match(/^([\s\S]*)\[\]$/) || only.match(/^(?:Readonly)?Array<([\s\S]*)>$/);
  const inner = (arrayMatch ? required(arrayMatch[1], 'Array element type capture') : only)
    .trim()
    .replace(/^\((.*)\)$/s, '$1')
    .trim();
  const body = inner.startsWith('{') ? inner : aliases.get(inner);
  if (!body || !body.trim().startsWith('{')) {
    return undefined;
  }
  // Inside the braces: a member's `;` is only a separator out here, and with
  // the braces still on, a whole one-line type reads as a single member whose
  // type is the rest of the interface.
  const inside = body.trim().replace(/^\{/, '').replace(/\}$/, '');
  const members = [...parsePropSchemaMemberEntries(inside)].map(([memberName, memberType]) => ({
    name: memberName,
    type: normalizeType(memberType).type,
  }));
  if (!members.length) {
    return undefined;
  }
  return { list: !!arrayMatch, members };
}

export function parsePropSchemaMemberEntries(block: string) {
  const out = new Map<string, string>();
  // Line by line first — that reads members written one per line, including
  // several separated by commas rather than semicolons.
  for (const line of explodeMembers(block).split('\n')) {
    // The separator this member ended with, if any — explodeMembers has
    // already cut the top-level ones, so whatever is left inside the type is
    // the type's own. Refusing a `;` there cost every prop written the way
    // TypeScript writes an object: `items?: { title: string; text: string }[]`
    // matched nothing at all, so the prop fell through to the destructuring
    // — where it has no type — and a list of rows came out as raw code.
    const text = line.trim().replace(/[;,]\s*$/, '');
    const match = text.match(MEMBER_RE);
    if (match) {
      out.set(memberName(required(match[1], 'Member name capture')), required(match[2], 'Member type capture').trim());
    }
  }
  // …then whole members, for a type that spans lines:
  //   variant?:
  //     | "stack"
  //     | "card";
  // No single line of that is a member, so the scan above sees nothing and
  // the prop vanishes from its branch — which is how a six-option variant
  // came out as a text field instead of a dropdown.
  for (const raw of splitTypeTop(block, ';')) {
    const flat = raw
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/\/\/[^\n]*/g, ' ')
      .replace(/[{}]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!flat.includes('\n') && out.size && !/\|/.test(flat)) {
      continue;
    }
    const match = flat.match(MEMBER_FLAT_RE);
    if (match && !out.has(memberName(required(match[1], 'Member name capture')))) {
      out.set(memberName(required(match[1], 'Member name capture')), required(match[2], 'Member type capture').trim());
    }
  }
  return out;
}

export function parsePropSchemaRawTypes(
  aliases: ReadonlyMap<string, string>,
  blocks: readonly string[],
): {
  rawTypes: Map<string, { parts: string[]; optional: boolean }>;
  noted: Map<string, string>;
} {
  // Raw type strings per prop, gathered across every block, so a prop split
  // over a discriminated union comes back as the union of what it can be —
  // `"responsive"` here and `"fixed"` there is one three-option enum, not
  // three separate one-option ones.
  const rawTypes = new Map<string, { parts: string[]; optional: boolean }>();
  const noted = new Map<string, string>();

  // An alias standing in for a union of literals, expanded to those literals.
  // Only for alias bodies that are plain unions — one holding an object shape
  // describes members, not values, and exploding it would be nonsense.

  for (const block of blocks) {
    parsePropSchemaRawBlock(block, aliases, rawTypes, noted);
  }
  return { rawTypes, noted };
}

export function parsePropSchemaFields(
  aliases: ReadonlyMap<string, string>,
  rawTypes: ReadonlyMap<string, { parts: string[]; optional: boolean }>,
  noted: ReadonlyMap<string, string>,
  sharedDocumentation: ReadonlyMap<string, string>,
  unions: readonly PropUnion[],
): Map<string, SchemaField> {
  const schema = new Map<string, SchemaField>();

  for (const [name, rec] of rawTypes) {
    const typeText = rec.parts.join(' | ');
    const { type, options, numeric, expressionOptions, codeKind } = normalizeType(typeText);
    const shape = parsePropSchemaShapeOf(aliases, rec.parts);
    schema.set(name, {
      name,
      type,
      options,
      numeric,
      ...(expressionOptions ? { expressionOptions } : {}),
      // A value only code can give carries its type, so the panel can say what it takes.
      ...(codeKind ? { codeKind, typeText: shownTypeText(typeText) } : {}),
      optional: rec.optional,
      // What one of these is made of, when the type says. `list` distinguishes
      // `ServiceTime[]` (a loop over it hands you one) from a plain object.
      ...(shape ? { shape: shape.members, shapeIsList: shape.list } : {}),
      default: undefined,
      doc: sharedDocumentation.get(name) ?? noted.get(name),
      // Range and step, for the fields that can be typed into freely. A list
      // of literals already can't take a wrong value.
      ...(type === 'number' ? numberRules(noted.get(name)) : {}),
      // The union shapes this component declares, so the panel can show only
      // the branch that matches what's currently set. Same table on every
      // field — it describes the type, not the prop.
      unions: unions.length ? unions : undefined,
    });
  }
  return schema;
}

// The destructure that reads the props: `const { a, b = 1 } = Astro.props`,
// annotated or not (`const { a }: { a: string } = Astro.props`), or taken from
// a name that holds them (`const props = Astro.props; const { a } = props`).
export interface PropsDestructure {
  // The text between the pattern's braces.
  readonly pattern: string;
  // The annotation after the pattern, when it has one: `{ a: string }` or `Props`.
  readonly annotation: string | undefined;
}

// A frontmatter declares a handful of destructures; past this many the search stops.
const DESTRUCTURE_CANDIDATES_MAX = 64;

export function propsDestructure(frontmatter: string): PropsDestructure | undefined {
  // `const props = Astro.props` names the props; a destructure of that name reads them too.
  const holders = [
    'Astro\\.props',
    ...[...frontmatter.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*Astro\.props\s*;?\s*(?:\n|$)/g)].map((match) =>
      required(match[1], 'Props holder capture').replace(/\$/g, '\\$'),
    ),
  ];
  const source = new RegExp(String.raw`^\s*=\s*(?:${holders.join('|')})(?![\w$.])`);
  const opener = /(?:const|let|var)\s*\{/g;
  let found: PropsDestructure | undefined;
  for (let candidate = 0; candidate < DESTRUCTURE_CANDIDATES_MAX; candidate++) {
    const match = opener.exec(frontmatter);
    if (match === null) {
      break;
    }
    const open = match.index + match[0].length - 1;
    const close = findMatchingBrace(frontmatter, open);
    if (close === -1) {
      continue;
    }
    const rest = frontmatter.slice(close + 1);
    const annotated = destructureAnnotation(rest);
    if (source.test(rest.slice(annotated.length))) {
      const annotation = annotated.replace(/^\s*:/, '').trim();
      found = { pattern: frontmatter.slice(open + 1, close), annotation: annotation === '' ? undefined : annotation };
      break;
    }
  }
  assert(found === undefined || found.pattern.length < frontmatter.length, 'propsDestructure: the pattern lies inside the frontmatter');
  return found;
}

// The `: Type` that may follow a destructure pattern, as written (empty when
// there is none): a braced type literal read to its matching brace, or a
// named type read to the `=`.
function destructureAnnotation(rest: string): string {
  const colon = rest.match(/^\s*:\s*/);
  if (!colon) {
    return '';
  }
  const at = colon[0].length;
  if (rest.charAt(at) === '{') {
    const close = findMatchingBrace(rest, at);
    return close === -1 ? '' : rest.slice(0, close + 1);
  }
  const named = rest.slice(at).match(/^[^=;{}]+/);
  return named ? rest.slice(0, at + named[0].length) : '';
}

export function parsePropSchemaDestructure(frontmatter: string, schema: Map<string, SchemaField>): void {
  const destructure = propsDestructure(frontmatter);
  if (!destructure) {
    return;
  }
  // One entry per top-level comma. A default may be an object or a list of
  // its own (`filters: propFilters = {"fields": [{"fieldPath": "name"}]}`),
  // and its keys and values are not props: reading the entries with patterns
  // over the whole text listed `fields`, `fieldPath` and `name` as props.
  for (const entry of topLevelEntries(destructure.pattern)) {
    // Rest params (...rest) aren't real props, and renames (class: className)
    // register under the real prop name only. A quoted key (`'data-id': dataId`)
    // is the prop's name without its quotes.
    const match = entry.match(DESTRUCTURE_ENTRY_RE);
    if (!match?.[1] || /^\s*\.\.\./.test(entry)) {
      continue;
    }
    const name = memberName(match[1]);
    const existing = schema.get(name) || {
      name,
      type: 'other',
      optional: true,
      default: undefined,
    };
    schema.set(name, match[2] === undefined ? existing : withDestructureDefault(existing, match[2].trim()));
  }
}

const DESTRUCTURE_ENTRY_RE = /^\s*([\w$]+|'[^'\n]+'|"[^"\n]+")\s*(?::\s*[\w$]+\s*)?(?:=\s*([\s\S]+?))?\s*$/;
const STRING_DEFAULT_RE = /^("(?:[^"\\\n]|\\[\s\S])*"|'(?:[^'\\\n]|\\[\s\S])*'|`(?:[^`\\$]|\\[\s\S]|\$(?!\{))*`)$/;

// What a default's text says about the prop: a literal sets its type and
// value; anything else is kept as an expression for the scanner to resolve.
function withDestructureDefault(field: SchemaField, defaultText: string): SchemaField {
  const typed = (type: SchemaField['type']): SchemaField['type'] => (field.type === 'other' && field.codeKind === undefined ? type : field.type);
  // A whole string literal only: `'a' + b` and `` `${SITE}:` `` start with a
  // quote but are expressions, and showing them as text would claim a value
  // the component never has.
  if (STRING_DEFAULT_RE.test(defaultText)) {
    return { ...field, optional: true, default: decodeStringLiteral(defaultText.slice(1, -1)), type: typed('string') };
  }
  if (/^(true|false)$/.test(defaultText)) {
    return { ...field, optional: true, default: defaultText === 'true', type: typed('boolean') };
  }
  const number = numericLiteral(defaultText);
  if (number !== undefined) {
    return { ...field, optional: true, default: number, type: typed('number') };
  }
  // Not a literal — an identifier or expression (e.g. SITE_TITLE). Flagged so
  // the scanner can try resolving it to a real value. An array literal makes
  // an untyped prop a list, an object literal an attributes object, and an
  // arrow function an action set in code.
  const expression = { ...field, optional: true, default: defaultText, defaultExpr: true };
  if (/^\[/.test(defaultText)) {
    return { ...expression, type: typed('code') };
  }
  if (/^\{/.test(defaultText)) {
    return { ...expression, type: typed('attrs') };
  }
  if (field.type === 'other' && field.codeKind === undefined && /^(?:async\s+)?(?:\([^()]*\)|[A-Za-z_$][\w$]*)\s*=>/.test(defaultText)) {
    return { ...expression, codeKind: 'function' };
  }
  return expression;
}

// A number literal in any of the ways JS writes one — `-2`, `0.5`, `1e3`,
// `0x10`, `1_000` — as its value; undefined for anything else.
export function numericLiteral(text: string): number | undefined {
  const match = text.match(/^(-?)(0[xX][\da-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|(?:\d[\d_]*)?\.?\d[\d_]*(?:[eE][+-]?\d+)?)$/);
  if (!match) {
    return undefined;
  }
  const digits = required(match[2], 'Number literal digits').replace(/_/g, '');
  const value = Number(digits);
  if (!Number.isFinite(value)) {
    return undefined;
  }
  return match[1] === '-' ? -value : value;
}

// A string literal's body as the string it stands for: `\n` is a line break,
// `\"` a quote, `\\` one backslash, `\u00e9` an é.
export function decodeStringLiteral(body: string): string {
  const simple: Readonly<Record<string, string>> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0' };
  const decoded = body.replace(/\\(u\{[\da-fA-F]+\}|u[\da-fA-F]{4}|x[\da-fA-F]{2}|\r\n|[\s\S])/g, (_whole, escape: string) => {
    if (escape.startsWith('u{')) {
      const code = parseInt(escape.slice(2, -1), 16);
      return code <= 0x10ffff ? String.fromCodePoint(code) : escape;
    }
    if (/^[ux][\da-fA-F]/.test(escape)) {
      return String.fromCharCode(parseInt(escape.slice(1), 16));
    }
    // A backslash before a line break continues the line.
    if (escape === '\n' || escape === '\r\n' || escape === '\r') {
      return '';
    }
    return simple[escape] ?? escape;
  });
  assert(decoded.length <= body.length, 'decodeStringLiteral: decoding never lengthens');
  return decoded;
}

/**
 * A destructure's text split at its top-level commas: commas inside a
 * string, a template or brackets belong to that entry's default, and comments
 * (a doc comment above an entry) are left out. Bounded by the text, which
 * the frontmatter limit bounds.
 */
export function topLevelEntries(text: string): string[] {
  const entries: string[] = [];
  let current = '';
  let depth = 0;
  let quote = '';
  const end = Math.min(text.length, LIMITS.ipcFieldCharsMax);
  for (let index = 0; index < end; index++) {
    const char = text.charAt(index);
    const next = text.charAt(index + 1);
    if (quote !== '') {
      current += char;
      if (char === '\\') {
        current += next;
        index++;
      } else if (char === quote) {
        quote = '';
      }
    } else if (char === '/' && next === '*') {
      const close = text.indexOf('*/', index + 2);
      index = close < 0 ? end : close + 1;
    } else if (char === '/' && next === '/') {
      const close = text.indexOf('\n', index);
      index = close < 0 ? end : close - 1;
    } else if (char === ',' && depth === 0) {
      entries.push(current);
      current = '';
    } else {
      if (char === '"' || char === "'" || char === '`') {
        quote = char;
      } else if (char === '{' || char === '[' || char === '(') {
        depth++;
      } else if (char === '}' || char === ']' || char === ')') {
        depth = Math.max(0, depth - 1);
      }
      current += char;
    }
  }
  entries.push(current);
  return entries.filter((entry) => entry.trim() !== '');
}

export function parsePropSchemaSplitFallback(unions: readonly PropUnion[]): Set<string> {
  // A prop written in several branches can promise a different fallback in
  // each. There is no single answer for the field, and reading the first
  // branch's doc would have it claim Play on a close button — the same lie
  // the conditional clause above refuses to tell. The branch tables carry
  // the per-branch answers; the field claims none.
  const splitFallback = new Set<string>();
  for (const union of unions) {
    for (const name of union.names) {
      const seen = new Set();
      for (const branch of union.branches) {
        if (branch.defaults?.[name] !== undefined) {
          seen.add(branch.defaults[name]);
        }
        if (branch.rules?.[name]) {
          seen.add(`rule:${name}`);
        }
      }
      if (seen.size > 1) {
        splitFallback.add(name);
      }
    }
  }
  return splitFallback;
}

export function parsePropSchemaFallbacks(frontmatter: string, schema: Map<string, SchemaField>, splitFallback: ReadonlySet<string>): void {
  // A prop's fallback isn't always a destructure default. Two more places it
  // is stated plainly, both worth showing as a field's placeholder so the
  // panel can say what happens when you leave it alone:
  //
  //   - a renamed prop's fallback: `const alt = altProp ?? "";`
  //   - the doc comment: /** Output format. Defaults to `webp`. */
  //
  // Only literal values are taken. "Defaults to whatever Astro picks" is prose
  // and stays prose — a placeholder that isn't a real value would be a lie
  // about what the component does.
  for (const field of schema.values()) {
    if (field.default !== undefined) {
      continue;
    }

    // `const x = xProp ?? <literal>` / `const x = props.x ?? <literal>`
    const nullish = frontmatter.match(
      new RegExp(
        `(?:const|let)\\s+${field.name}\\s*=\\s*[\\w.]+\\s*\\?\\?\\s*` +
          `("(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'|\`[^\`]*\`|true|false|-?\\d+(?:\\.\\d+)?)`,
      ),
    );
    if (nullish) {
      const lit = required(nullish[1], 'Nullish default literal capture');
      field.default = /^["'\`]/.test(lit) ? decodeStringLiteral(lit.slice(1, -1)) : /^(true|false)$/.test(lit) ? lit === 'true' : Number(lit);
      // An untyped prop takes its kind from its fallback, as from a destructure default.
      if (field.type === 'other' && field.codeKind === undefined) {
        field.type = typeof field.default === 'string' ? 'string' : typeof field.default === 'boolean' ? 'boolean' : 'number';
      }
      continue;
    }

    // "Defaults to `webp`", "Default: 2", "Defaults to `[1, 2]`". The
    // backticked form is tried first and taken whole — a value like `[1, 2]`
    // contains the comma the bare form has to stop at.
    if (splitFallback.has(field.name)) {
      continue;
    }

    const said = statedDefault(field.doc);
    if (said.value !== undefined) {
      // "Defaults to true." on a switch is the boolean, not the word.
      field.default = field.type === 'boolean' && (said.value === 'true' || said.value === 'false') ? said.value === 'true' : said.value;
      continue;
    }
    if (said.hint) {
      field.hint = said.hint;
      continue;
    }

    // Some fallbacks are a behaviour rather than a value — "it is inferred",
    // "Astro picks sensible ones". There is nothing to prefill, but a field
    // that says `inferred` still answers "what happens if I leave this?".
    // Kept as `hint`, not `default`: it is not a value, so nothing may treat
    // it as one (the enum's unset-shows-default logic, for instance).
    const phrase =
      field.doc &&
      field.doc.match(
        new RegExp(
          '\\b(?:is|are)\\s+(inferred|automatic|calculated)\\b' +
            '|\\b(inferred|automatic)\\s+from\\b|\\b([A-Z][\\w ]{0' +
            ',24}?picks[\\w ]{0,20}?)\\s+by default\\b|\\bdefault' +
            's?\\s*(?:to|:)\\s*([^.]+)',
          'i',
        ),
      );
    if (phrase) {
      // To the end of the sentence, not a fixed number of word characters —
      // "the image service's own default" was coming back as "the image
      // service", which reads like a value rather than the shrug it is.
      const text = (phrase[1] || phrase[2] || phrase[3] || phrase[4] || '').replace(/`/g, '').replace(/\s+/g, ' ').trim();
      if (text && text.length <= 48) {
        field.hint = text;
      }
    }
  }
}

// A component may name its props only where it reads them —
// `Astro.props.label` in the markup, `Astro.props.year ?? 2026` in the
// frontmatter — with no type and no destructure. Each name read is a prop.
// Only for components with no Props type: a declared type is the whole list.
const DIRECT_ACCESS_READS_MAX = 512;
export function parsePropSchemaDirectAccess(source: string, schema: Map<string, SchemaField>): void {
  let reads = 0;
  for (const match of source.matchAll(/\bAstro\.props\.([A-Za-z_$][\w$]*)/g)) {
    reads++;
    if (reads > DIRECT_ACCESS_READS_MAX) {
      break;
    }
    const name = required(match[1], 'Direct access name capture');
    if (!schema.has(name) && schema.size < LIMITS.propSchemaFieldsMax) {
      schema.set(name, { name, type: 'other', optional: true, default: undefined });
    }
  }
  assert(schema.size <= LIMITS.propSchemaFieldsMax, 'parsePropSchemaDirectAccess: schema stays bounded');
}

function parsePropSchemaAccumulate(
  aliases: ReadonlyMap<string, string>,
  rawTypes: Map<string, { parts: string[]; optional: boolean }>,
  match: RegExpMatchArray,
): string {
  const name = memberName(required(match[1], 'Schema member name capture'));
  let typeText = required(match[3], 'Schema member type capture').trim();
  if (aliases.has(typeText)) {
    typeText = required(aliases.get(typeText), 'Type alias exists');
  }
  // `never` is how a union branch says "not in this shape" — it describes
  // the branch, not the prop, so it contributes no type and no
  // optionality. It DOES fix the prop's position though: a component that
  // writes `href?: never` above `type` is saying where href belongs, and
  // skipping the line outright would only register href in a later branch
  // and sort it to the bottom.
  if (typeText === 'never') {
    if (!rawTypes.has(name)) {
      rawTypes.set(name, { parts: [], optional: false });
    }
  } else {
    if (!rawTypes.has(name)) {
      rawTypes.set(name, { parts: [], optional: false });
    }
    const rec = required(rawTypes.get(name), 'Prop type accumulator was initialized');
    // Split at the top level only: the `|` inside `{ mode: 'a' | 'b' }` or
    // `(x: 'a' | 'b') => void` belongs to that member, not to this union.
    for (const part of splitTypeTop(typeText, '|')) {
      // `variant?: PlainVariant | ReversibleVariant` names two aliases
      // rather than being one, so the substitution above doesn't reach it
      // — and an unexpanded name among the literals is a non-literal, so
      // the whole thing stops reading as a fixed set of options.
      for (const piece of parsePropSchemaExpandAlias(aliases, part)) {
        if (piece !== 'never' && !rec.parts.includes(piece)) {
          rec.parts.push(piece);
        }
      }
    }
    if (match[2]) {
      rec.optional = true;
    }
  }

  return name;
}

function parsePropSchemaRawBlock(
  block: string,
  aliases: ReadonlyMap<string, string>,
  rawTypes: Map<string, { parts: string[]; optional: boolean }>,
  noted: Map<string, string>,
): void {
  // Walked line by line rather than matched in one pass, so the comment
  // above a prop can be carried onto it — that's the prop's documentation,
  // and the panel shows it as the field's help text.
  // The type runs to the end of the member — explodeMembers has already cut
  // the top-level semicolons, so a `;` still in there belongs to the type.
  // Refusing one cost every prop written the way TypeScript writes an object:
  // `items?: { title: string; text: string }[]` matched nothing at all, the
  // prop fell through to the destructuring — where it has no type — and a
  // list of rows came out as a code field instead of the list control.
  const entryRe = ENTRY_RE;
  let documentation: string[] = [];
  let inBlock = false;
  const lines = explodeMembers(block).split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = required(lines[i], 'Schema line index is in bounds').trim();
    if (inBlock) {
      // Closing a block that opened on an earlier line.
      const end = line.indexOf('*/');
      documentation.push((end === -1 ? line : line.slice(0, end)).replace(/^\*+\s?/, ''));
      if (end !== -1) {
        inBlock = false;
      }
      continue;
    }
    if (line.startsWith('/*')) {
      const end = line.indexOf('*/');
      documentation.push((end === -1 ? line.slice(2) : line.slice(2, end)).replace(/^\*+\s?/, ''));
      inBlock = end === -1;
      continue;
    }
    if (line.startsWith('//')) {
      documentation.push(line.slice(2).trim());
      continue;
    }
    // A blank line ends a comment's reach — otherwise a note about the
    // interface itself would land on whatever prop happens to come next.
    if (!line) {
      documentation = [];
      continue;
    }
    let match = line.match(entryRe);
    // A member whose type is written across lines —
    //   variant?:
    //     | "stack"
    //     | "card"
    // — has no single line that reads as a declaration, so the scan above
    // sees nothing and the prop disappears from the schema entirely. When a
    // line opens one, take the rest of the member with it. (explodeMembers
    // already ended the member at its `;`, so what follows belongs to it.)
    if (!match && ENTRY_OPEN_RE.test(line)) {
      const rest = [];
      while (i + 1 < lines.length) {
        const next = required(lines[i + 1], 'Following schema line exists').trim();
        if (!next || next.startsWith('/*') || next.startsWith('//')) {
          break;
        }
        if (entryRe.test(next) || ENTRY_OPEN_RE.test(next)) {
          break;
        }
        rest.push(next);
        i += 1;
      }
      if (rest.length) {
        match = (line + ' ' + rest.join(' ')).replace(/\s+/g, ' ').match(ENTRY_JOINED_RE);
      }
    }
    if (!match) {
      documentation = [];
      continue;
    }
    const name = parsePropSchemaAccumulate(aliases, rawTypes, match);
    const text = documentation.join(' ').replace(/\s+/g, ' ').trim();
    if (text && !noted.has(name)) {
      noted.set(name, text);
    }
    documentation = [];
  }
}
