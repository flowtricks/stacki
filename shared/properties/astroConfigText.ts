// Reads the top-level settings of an astro.config as TEXT, never running it.
//
// Why: the config is ESM or CommonJS, often TypeScript, and written for Astro to load: it may be
// an async function, spread another file, read the environment or build values with code.
// Running it would execute project code, and a regular expression over the whole text finds
// look-alikes (`srcDir` inside a `vite` block, in a comment, in a URL). So this reads tokens: it
// finds the exported object, walks only its top-level keys, and reports each as a literal
// (a plain string, number or boolean) or as computed. A computed value is a fact the caller
// must surface (Stacki falls back to Astro's default and says so), never guess at.
//
// How: `tokenize` turns the text into words, strings, numbers and punctuation, skipping
// comments and regular-expression literals (which can hold quotes). `readConfigText` then locates
// the config object (`export default {…}`, `defineConfig({…})`, an arrow or function returning
// one, `module.exports = {…}`, or a named `const` handed to either) and walks its depth-one
// entries. Every loop advances through the text or token list it was given, so it ends with the
// input; no fixed size cap applies.

import { assert } from '../core/assert';

export type ConfigSetting =
  /** Written as a plain value; `value` is its text without quotes. */
  | { readonly kind: 'literal'; readonly value: string }
  /** Written, but built by code (an environment read, a variable, a call, a spread that may override it). */
  | { readonly kind: 'computed' }
  /** Not set anywhere we can see: Astro's default applies. */
  | { readonly kind: 'unset' };

export interface ConfigReading {
  /** `object` when the exported config object was found; `opaque` when it is built by a call or an import. */
  readonly shape: 'object' | 'opaque';
  /** Each top-level key the object writes, in order, after the effect of any spread. */
  readonly settings: ReadonlyMap<string, ConfigSetting>;
  /** Whether a spread (`...other`) may set keys we cannot see. */
  readonly spread: boolean;
}

type Token =
  | { readonly kind: 'word'; readonly text: string }
  | { readonly kind: 'string'; readonly text: string }
  | { readonly kind: 'template'; readonly text: string; readonly plain: boolean }
  | { readonly kind: 'number'; readonly text: string }
  | { readonly kind: 'regex'; readonly text: string }
  | { readonly kind: 'punct'; readonly text: string };

const UNSET: ConfigSetting = { kind: 'unset' };
const COMPUTED: ConfigSetting = { kind: 'computed' };
const WORD_START = /[A-Za-z_$\u0080-￿]/;
const WORD_PART = /[A-Za-z0-9_$\u0080-￿]/;
const REGEX_AFTER_PUNCT = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^']);
const REGEX_AFTER_WORD = new Set(['return', 'typeof', 'case', 'in', 'of', 'delete', 'void', 'throw', 'new']);

/** The setting `key` has in a reading: its literal, `computed`, or `unset`. An opaque config computes every key. */
export function settingOf(reading: ConfigReading, key: string): ConfigSetting {
  const written = reading.settings.get(key);
  if (written !== undefined) {
    return written;
  }
  if (reading.shape === 'opaque' || reading.spread) {
    return COMPUTED;
  }
  return UNSET;
}

export function readConfigText(text: string): ConfigReading {
  const tokens = tokenize(text);
  const start = locateConfigObject(tokens);
  if (start === undefined) {
    return { shape: 'opaque', settings: opaqueSettings(tokens), spread: false };
  }
  const walked = walkObject(tokens, start);
  assert(walked.end >= start, 'readConfigText: the object ends after it starts');
  return { shape: 'object', settings: walked.settings, spread: walked.spread };
}

// An opaque config may still state a key literally (`makeConfig({ srcDir: './app' })`); the first
// `key: 'literal'` pair anywhere is the best evidence there is, so it is kept and the rest stay computed.
function opaqueSettings(tokens: readonly Token[]): ReadonlyMap<string, ConfigSetting> {
  const settings = new Map<string, ConfigSetting>();
  for (let index = 0; index + 2 < tokens.length; index += 1) {
    const key = tokens[index];
    const colon = tokens[index + 1];
    const value = tokens[index + 2];
    if (key?.kind !== 'word' || colon?.kind !== 'punct' || colon.text !== ':' || settings.has(key.text)) {
      continue;
    }
    const literal = literalOf(value === undefined ? [] : [value]);
    if (literal !== undefined) {
      settings.set(key.text, literal);
    }
  }
  return settings;
}

function tokenize(source: string): readonly Token[] {
  const text = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  const tokens: Token[] = [];
  let index = 0;
  while (index < text.length) {
    const char = text.charAt(index);
    const next = text.charAt(index + 1);
    if (/\s/.test(char)) {
      index += 1;
    } else if (char === '/' && next === '/') {
      const end = text.indexOf('\n', index);
      index = end < 0 ? text.length : end + 1;
    } else if (char === '/' && next === '*') {
      const end = text.indexOf('*/', index + 2);
      index = end < 0 ? text.length : end + 2;
    } else if (char === '#' && index === 0 && next === '!') {
      const end = text.indexOf('\n');
      index = end < 0 ? text.length : end + 1;
    } else if (char === '"' || char === "'") {
      const end = endOfString(text, index);
      tokens.push({ kind: 'string', text: unescape(text.slice(index + 1, end)) });
      index = end + 1;
    } else if (char === '`') {
      const end = endOfTemplate(text, index);
      const inner = text.slice(index + 1, end);
      tokens.push({ kind: 'template', text: inner, plain: !inner.includes('${') });
      index = end + 1;
    } else if (char === '/' && startsRegex(tokens)) {
      const end = endOfRegex(text, index);
      tokens.push({ kind: 'regex', text: text.slice(index, end) });
      index = end;
    } else if (WORD_START.test(char)) {
      let end = index + 1;
      while (end < text.length && WORD_PART.test(text.charAt(end))) {
        end += 1;
      }
      tokens.push({ kind: 'word', text: text.slice(index, end) });
      index = end;
    } else if (/[0-9]/.test(char)) {
      let end = index + 1;
      while (end < text.length && /[0-9a-zA-Z_.]/.test(text.charAt(end))) {
        end += 1;
      }
      tokens.push({ kind: 'number', text: text.slice(index, end) });
      index = end;
    } else if (char === '.' && next === '.' && text.charAt(index + 2) === '.') {
      tokens.push({ kind: 'punct', text: '...' });
      index += 3;
    } else if (char === '=' && next === '>') {
      tokens.push({ kind: 'punct', text: '=>' });
      index += 2;
    } else {
      tokens.push({ kind: 'punct', text: char });
      index += 1;
    }
  }
  return tokens;
}

// The index of the closing quote, or the text's end for a string left open (a broken file must still tokenize).
function endOfString(text: string, start: number): number {
  const quote = text.charAt(start);
  let index = start + 1;
  while (index < text.length) {
    const char = text.charAt(index);
    if (char === '\\') {
      index += 2;
    } else if (char === quote || char === '\n') {
      return index;
    } else {
      index += 1;
    }
  }
  return text.length;
}

function endOfTemplate(text: string, start: number): number {
  let index = start + 1;
  let depth = 0;
  while (index < text.length) {
    const char = text.charAt(index);
    if (char === '\\') {
      index += 2;
    } else if (char === '$' && text.charAt(index + 1) === '{') {
      depth += 1;
      index += 2;
    } else if (char === '}' && depth > 0) {
      depth -= 1;
      index += 1;
    } else if (char === '`' && depth === 0) {
      return index;
    } else {
      index += 1;
    }
  }
  return text.length;
}

function startsRegex(tokens: readonly Token[]): boolean {
  const previous = tokens[tokens.length - 1];
  if (previous === undefined) {
    return true;
  }
  if (previous.kind === 'punct') {
    return REGEX_AFTER_PUNCT.has(previous.text) || previous.text === '=>';
  }
  if (previous.kind === 'word') {
    return REGEX_AFTER_WORD.has(previous.text);
  }
  return false;
}

// One past the closing slash and flags of a regular-expression literal; a `/` inside [...] does not end it.
function endOfRegex(text: string, start: number): number {
  let index = start + 1;
  let inClass = false;
  while (index < text.length) {
    const char = text.charAt(index);
    if (char === '\n') {
      return index;
    }
    if (char === '\\') {
      index += 2;
    } else if (char === '[') {
      inClass = true;
      index += 1;
    } else if (char === ']') {
      inClass = false;
      index += 1;
    } else if (char === '/' && !inClass) {
      index += 1;
      while (index < text.length && /[a-z]/i.test(text.charAt(index))) {
        index += 1;
      }
      return index;
    } else {
      index += 1;
    }
  }
  return text.length;
}

function unescape(raw: string): string {
  return raw.replace(/\\(.)/g, (_match, char: string) => char);
}

function isPunct(token: Token | undefined, text: string): boolean {
  return token !== undefined && token.kind === 'punct' && token.text === text;
}

function isWord(token: Token | undefined, text: string): boolean {
  return token !== undefined && token.kind === 'word' && token.text === text;
}

// The index of the `{` that opens the config object, or undefined when the config is not written as one.
function locateConfigObject(tokens: readonly Token[]): number | undefined {
  for (let index = 0; index < tokens.length; index += 1) {
    const exported = isWord(tokens[index], 'export') && isWord(tokens[index + 1], 'default');
    const commonjs =
      isWord(tokens[index], 'module') && isPunct(tokens[index + 1], '.') && isWord(tokens[index + 2], 'exports') && isPunct(tokens[index + 3], '=');
    if (exported) {
      return objectFromExpression(tokens, index + 2, tokens.length);
    }
    if (commonjs) {
      return objectFromExpression(tokens, index + 4, tokens.length);
    }
  }
  return undefined;
}

// Where the value that starts at `from` is an object: directly, as the argument of a call (defineConfig),
// as the body of an arrow or function, or through a named variable.
function objectFromExpression(tokens: readonly Token[], from: number, limit: number): number | undefined {
  let index = from;
  while (isWord(tokens[index], 'async') || isWord(tokens[index], 'function')) {
    index += 1;
  }
  const first = tokens[index];
  if (first === undefined || index >= limit) {
    return undefined;
  }
  if (isPunct(first, '{')) {
    return index;
  }
  if (first.kind === 'word') {
    const afterCall = isPunct(tokens[index + 1], '(') ? index + 2 : undefined;
    if (afterCall !== undefined) {
      return objectFromCallArgument(tokens, afterCall);
    }
    return objectFromVariable(tokens, first.text);
  }
  if (isPunct(first, '(')) {
    return objectFromCallArgument(tokens, index + 1);
  }
  return undefined;
}

// `defineConfig({…})`, `defineConfig(config)`, `defineConfig(async () => ({…}))`, `(function () { return {…} })`.
function objectFromCallArgument(tokens: readonly Token[], from: number): number | undefined {
  let index = from;
  while (isWord(tokens[index], 'async') || isWord(tokens[index], 'function')) {
    index += 1;
  }
  const first = tokens[index];
  if (isPunct(first, '{')) {
    return index;
  }
  if (first?.kind === 'word' && !isPunct(tokens[index + 1], '(') && !isPunct(tokens[index + 1], '=>')) {
    return objectFromVariable(tokens, first.text);
  }
  // A parameter list or function name, then `=>` or a body.
  const arrow = findToken(tokens, index, (token) => isPunct(token, '=>') || isPunct(token, '{'));
  if (arrow === undefined) {
    return undefined;
  }
  if (isPunct(tokens[arrow], '=>')) {
    const body = tokens[arrow + 1];
    if (isPunct(body, '(') && isPunct(tokens[arrow + 2], '{')) {
      return arrow + 2;
    }
    if (isPunct(body, '{')) {
      return returnedObject(tokens, arrow + 1);
    }
    return undefined;
  }
  return returnedObject(tokens, arrow);
}

// The first `return {` inside the block that opens at `block`.
function returnedObject(tokens: readonly Token[], block: number): number | undefined {
  const close = matching(tokens, block);
  for (let index = block + 1; index < close; index += 1) {
    if (isWord(tokens[index], 'return') && isPunct(tokens[index + 1], '{')) {
      return index + 1;
    }
  }
  return undefined;
}

// `const name = {…}`, with an optional type annotation, found anywhere in the file.
function objectFromVariable(tokens: readonly Token[], name: string): number | undefined {
  for (let index = 0; index + 1 < tokens.length; index += 1) {
    const declaration = isWord(tokens[index], 'const') || isWord(tokens[index], 'let') || isWord(tokens[index], 'var');
    if (!declaration || !isWord(tokens[index + 1], name)) {
      continue;
    }
    const equals = findToken(tokens, index + 2, (token) => isPunct(token, '=') || isPunct(token, ';'));
    if (equals !== undefined && isPunct(tokens[equals], '=')) {
      return objectFromExpression(tokens, equals + 1, tokens.length);
    }
  }
  return undefined;
}

function findToken(tokens: readonly Token[], from: number, test: (token: Token | undefined) => boolean): number | undefined {
  for (let index = from; index < tokens.length; index += 1) {
    if (test(tokens[index])) {
      return index;
    }
  }
  return undefined;
}

const OPENERS = new Set(['(', '[', '{']);
const CLOSERS = new Set([')', ']', '}']);

// The index of the bracket that closes the one at `open`; the token count when it never closes.
function matching(tokens: readonly Token[], open: number): number {
  let depth = 0;
  for (let index = open; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token?.kind !== 'punct') {
      continue;
    }
    if (OPENERS.has(token.text)) {
      depth += 1;
    } else if (CLOSERS.has(token.text)) {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return tokens.length;
}

function walkObject(
  tokens: readonly Token[],
  open: number,
): { readonly settings: ReadonlyMap<string, ConfigSetting>; readonly spread: boolean; readonly end: number } {
  const end = matching(tokens, open);
  const settings = new Map<string, ConfigSetting>();
  let spread = false;
  let index = open + 1;
  while (index < end) {
    const entryEnd = endOfEntry(tokens, index, end);
    const entry = tokens.slice(index, entryEnd);
    const head = entry[0];
    if (isPunct(head, '...')) {
      // A spread may overwrite anything written before it; later keys win over it.
      spread = true;
      for (const key of settings.keys()) {
        settings.set(key, COMPUTED);
      }
    } else if (head !== undefined && (head.kind === 'word' || head.kind === 'string')) {
      settings.set(head.text, isPunct(entry[1], ':') ? (literalOf(entry.slice(2)) ?? COMPUTED) : COMPUTED);
    }
    index = entryEnd + 1;
  }
  return { settings, spread, end };
}

// The index of the comma that ends the entry starting at `from`, or `limit` for the last entry.
function endOfEntry(tokens: readonly Token[], from: number, limit: number): number {
  let depth = 0;
  for (let index = from; index < limit; index += 1) {
    const token = tokens[index];
    if (token?.kind !== 'punct') {
      continue;
    }
    if (OPENERS.has(token.text)) {
      depth += 1;
    } else if (CLOSERS.has(token.text)) {
      depth -= 1;
    } else if (token.text === ',' && depth === 0) {
      return index;
    }
  }
  return limit;
}

// A value written as one plain string, number or boolean; anything else is code.
function literalOf(value: readonly Token[]): ConfigSetting | undefined {
  const only = value.length === 1 ? value[0] : undefined;
  if (only === undefined) {
    return undefined;
  }
  if (only.kind === 'string' || (only.kind === 'template' && only.plain)) {
    return { kind: 'literal', value: only.text };
  }
  if (only.kind === 'number' || (only.kind === 'word' && (only.text === 'true' || only.text === 'false'))) {
    return { kind: 'literal', value: only.text };
  }
  return undefined;
}
