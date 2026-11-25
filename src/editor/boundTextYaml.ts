// Text a page prints from a YAML file: `{platformIntro.heading}` where the page
// imports `home` and `home.ts` reads `parse(raw)` of `import raw from "./home.yaml?raw"`.
// The path is walked through the file's own YAML node tree, never through the
// parsed data, so the walk ends at the one scalar whose exact bytes the canvas
// may replace, and every other byte (comments, indentation, other quotes) stays.
//
// Only a scalar written on one line is edited: plain (`heading: Words`), single
// quoted (`'It''s'`) or double quoted (`"Say \"hi\""`). A block scalar (`|`, `>`)
// or a plain or quoted scalar folded over several lines is refused: rewriting it
// would mean re-flowing lines the person laid out by hand. An alias or a tag
// stands for a value written elsewhere or converted, so it is refused too.
//
// Encoding keeps the scalar's style whenever that style can spell the words. A
// plain scalar that cannot (a `: `, a leading `#`, a word YAML reads as a number
// or `true`, a newline) and a single-quoted one that cannot (a newline, a
// control character) become double quoted, the one YAML style with escapes. It
// is the same rule the CMS YAML writer follows (electron/content/formats/yaml.ts):
// a value is quoted defensively rather than written so that it no longer parses
// as the same string.

import * as YAML from 'yaml';
import { assert } from '../../shared/core/assert';

/** How a YAML scalar is spelled, so a rewrite keeps the file's own style. */
export const YAML_QUOTES = ['yaml-plain', 'yaml-single', 'yaml-double'] as const;
export type YamlQuote = (typeof YAML_QUOTES)[number];

export const isYamlQuote = (quote: string): quote is YamlQuote => YAML_QUOTES.some((entry) => entry === quote);

export type YamlStep = { readonly kind: 'key'; readonly name: string } | { readonly kind: 'index'; readonly at: number };

export type YamlBlockReason = 'computed' | 'missing' | 'multiline' | 'not-text' | 'unreadable';

export type YamlFound =
  | { readonly kind: 'site'; readonly start: number; readonly end: number; readonly quote: YamlQuote; readonly value: string; readonly raw: string }
  | { readonly kind: 'list'; readonly count: number }
  | { readonly kind: 'block'; readonly reason: YamlBlockReason; readonly detail: string; readonly line: number };

/** Characters of YAML read for one binding; a bigger data file is not walked. */
export const YAML_TEXT_CHARS_MAX = 2_000_000;

// Options passed explicitly (AGENTS.md §6): the YAML 1.2 core schema the `yaml` package parses with, and duplicate keys as errors.
const PARSE_OPTIONS = { keepSourceTokens: false, uniqueKeys: true, version: '1.2', prettyErrors: false } as const;

/** The scalar or list `steps` names in the YAML `text`, or why it cannot be edited in place. */
export function findYamlValue(text: string, steps: readonly YamlStep[], want: 'string' | 'list'): YamlFound {
  if (text.length > YAML_TEXT_CHARS_MAX) {
    return yamlBlock('unreadable', 'The YAML file is larger than the editor reads.', text, 0);
  }
  const document = YAML.parseDocument(text, PARSE_OPTIONS);
  const firstError = document.errors[0];
  if (firstError !== undefined) {
    return yamlBlock('unreadable', `The YAML file does not parse: ${firstError.message}`, text, firstError.pos[0]);
  }
  let node: unknown = document.contents;
  for (const step of steps) {
    const walked = yamlChild(node, step, text);
    if (walked.kind === 'block') {
      return walked;
    }
    node = walked.node;
  }
  return yamlLeaf(node, want, text);
}

type Walked = { readonly kind: 'node'; readonly node: unknown } | Extract<YamlFound, { readonly kind: 'block' }>;

// One step down the node tree: a key of a mapping, an item of a sequence.
function yamlChild(node: unknown, step: YamlStep, text: string): Walked {
  if (YAML.isAlias(node)) {
    return yamlBlock('computed', `An alias (*${node.source}) supplies this value.`, text, node.range?.[0] ?? 0);
  }
  if (YAML.isMap(node)) {
    if (step.kind === 'key') {
      const matches = node.items.filter((pair) => YAML.isScalar(pair.key) && String(pair.key.value) === step.name);
      if (matches.length === 1) {
        return { kind: 'node', node: matches[0]?.value };
      }
      const merged = node.items.some((pair) => YAML.isScalar(pair.key) && pair.key.value === '<<');
      return merged
        ? yamlBlock('computed', `A merge key (<<) may supply ${step.name}.`, text, node.range?.[0] ?? 0)
        : yamlBlock('missing', `${step.name} is not written in this mapping.`, text, node.range?.[0] ?? 0);
    }
    return yamlBlock('missing', 'A mapping has values by name, not by number.', text, node.range?.[0] ?? 0);
  }
  if (YAML.isSeq(node)) {
    const item = step.kind === 'index' ? node.items[step.at] : undefined;
    if (item === undefined) {
      const detail = step.kind === 'index' ? `The list has no item ${step.at}.` : 'A list has items by number, not by name.';
      return yamlBlock('missing', detail, text, node.range?.[0] ?? 0);
    }
    return { kind: 'node', node: item };
  }
  return yamlBlock('missing', 'The path goes past a value that has no fields.', text, 0);
}

// The end of the walk: a one-line string scalar, a list to count, or why neither.
function yamlLeaf(node: unknown, want: 'string' | 'list', text: string): YamlFound {
  if (YAML.isSeq(node)) {
    return want === 'list' ? { kind: 'list', count: node.items.length } : yamlBlock('not-text', 'This value is a list, not text.', text, node.range?.[0] ?? 0);
  }
  if (YAML.isAlias(node)) {
    return yamlBlock('computed', `An alias (*${node.source}) supplies this value.`, text, node.range?.[0] ?? 0);
  }
  if (!YAML.isScalar(node) || typeof node.value !== 'string' || want !== 'string') {
    return yamlBlock('not-text', 'This value is not one string.', text, rangeStart(node));
  }
  const range = node.range;
  if (range === undefined || range === null) {
    return yamlBlock('missing', 'This value has no place in the file.', text, 0);
  }
  if (node.tag !== undefined) {
    return yamlBlock('computed', `A tag (${node.tag}) converts this value.`, text, range[0]);
  }
  const quote = yamlQuoteOf(node.type);
  if (quote === undefined) {
    return yamlBlock('multiline', 'A block scalar (| or >) holds this text over several lines.', text, range[0]);
  }
  const raw = text.slice(range[0], range[1]);
  if (raw.includes('\n') || raw.includes('\r')) {
    return yamlBlock('multiline', 'This text is folded over several lines.', text, range[0]);
  }
  assert(raw.length > 0, 'A YAML scalar with a value spans some characters');
  assert(range[1] <= text.length, 'A YAML scalar ends inside its file');
  return { kind: 'site', start: range[0], end: range[1], quote, value: node.value, raw };
}

// The scalar styles one line can hold; a block scalar has none.
const YAML_QUOTE_OF_TYPE: Readonly<Record<string, YamlQuote>> = { PLAIN: 'yaml-plain', QUOTE_SINGLE: 'yaml-single', QUOTE_DOUBLE: 'yaml-double' };

function yamlQuoteOf(type: string | undefined): YamlQuote | undefined {
  return type === undefined ? undefined : YAML_QUOTE_OF_TYPE[type];
}

function rangeStart(node: unknown): number {
  if (YAML.isNode(node)) {
    return node.range?.[0] ?? 0;
  }
  return 0;
}

function yamlBlock(reason: YamlBlockReason, detail: string, text: string, offset: number): Extract<YamlFound, { readonly kind: 'block' }> {
  return { kind: 'block', reason, detail, line: lineAt(text, offset) };
}

/** The 1-based line `offset` falls on in `text`. */
export function lineAt(text: string, offset: number): number {
  assert(offset >= 0, 'A line is asked for an offset inside the text');
  let line = 1;
  const end = Math.min(offset, text.length);
  for (let index = 0; index < end; index++) {
    if (text.charCodeAt(index) === 10) {
      line++;
    }
  }
  return line;
}

/** The scalar that spells `value` in `quote`'s style, or in double quotes when that style cannot spell it (see the top of this file). */
export function encodeYamlScalar(value: string, quote: YamlQuote): string {
  const encoded = encodeYamlScalarStyle(value, quote);
  assert(!encoded.includes('\n'), 'An encoded YAML scalar stays on one line');
  assert(YAML.parse(encoded, PARSE_OPTIONS) === value, 'An encoded YAML scalar reads back as its value');
  return encoded;
}

function encodeYamlScalarStyle(value: string, quote: YamlQuote): string {
  switch (quote) {
    case 'yaml-plain':
      return plainSpells(value) ? value : doubleQuoted(value);
    case 'yaml-single':
      return singleSpells(value) ? `'${value.replaceAll("'", "''")}'` : doubleQuoted(value);
    case 'yaml-double':
      return doubleQuoted(value);
    default: {
      const exhaustive: never = quote;
      return exhaustive;
    }
  }
}

// JSON's string syntax is YAML 1.2's double-quoted style: every character it writes reads back the same.
const doubleQuoted = (value: string): string => JSON.stringify(value);

// Characters a single-quoted scalar cannot hold on one line: line breaks and the C0 controls and DEL.
const SINGLE_UNSPELLABLE = /[\u0000-\u0008\u000a-\u001f\u007f]/;

function singleSpells(value: string): boolean {
  return !SINGLE_UNSPELLABLE.test(value);
}

// A plain scalar is written only when nothing in it means something else to YAML, in block or flow context alike.
const PLAIN_FIRST_UNSAFE = /^[-?:,[\]{}#&*!|>'"%@`\s]/;
const PLAIN_ANYWHERE_UNSAFE = /[\u0000-\u001f\u007f,[\]{}]|: |:$| #|\s$/;

function plainSpells(value: string): boolean {
  if (value.length === 0) {
    return false;
  }
  if (PLAIN_FIRST_UNSAFE.test(value)) {
    return false;
  }
  if (PLAIN_ANYWHERE_UNSAFE.test(value)) {
    return false;
  }
  // `true`, `12`, `null`, `~`, `0x1F`: words the core schema reads as another type stay strings only when quoted.
  return YAML.parse(value, PARSE_OPTIONS) === value;
}
