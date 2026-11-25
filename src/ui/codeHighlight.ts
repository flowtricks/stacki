// Syntax colours for code that is shown rather than edited.
//
// The rule table below is the app's one code palette. CodeEditor builds its
// CodeMirror highlight style from it and this module colours static text with
// it, so a string is the same green in a diff, a dialog and the editor. The
// parsers are the editor's Lezer grammars, run without an EditorView: a preview
// is a few lines of text, and an element keeps the size, scroll and wrap its
// surrounding CSS gives it where a mounted editor would bring its own.

import { cssLanguage } from '@codemirror/lang-css';
import { htmlLanguage } from '@codemirror/lang-html';
import { javascriptLanguage, tsxLanguage } from '@codemirror/lang-javascript';
import { markdownLanguage } from '@codemirror/lang-markdown';
import { tomlLanguage } from './tomlSyntax';
import type { Parser, Tree } from '@lezer/common';
import { highlightTree, tagHighlighter, tags as t, type Tag } from '@lezer/highlight';
import { assert } from '../../shared/core/assert';
import { LIMITS } from '../../shared/core/limits';
import { lineSlices, nextLineSlice, yieldToEventLoop, type LineSlice } from './codeSlices';

/** How one token looks: the properties a rule sets, as React and the DOM name them. */
export type CodeTokenStyle = {
  readonly color?: string;
  readonly fontStyle?: string;
  readonly fontWeight?: string;
  readonly textDecoration?: string;
};

/** A run of text with its colour. A token with no style is plain text. */
export interface CodeToken {
  readonly text: string;
  readonly style?: CodeTokenStyle | undefined;
}

/** A line of tokens. Joining a line's texts gives the source line, without its break. */
export type CodeLine = readonly CodeToken[];

export type CodeLanguage = 'astro' | 'commit' | 'css' | 'html' | 'javascript' | 'json' | 'markdown' | 'shell' | 'toml' | 'typescript';

export const CODE_TOKEN_RULES: readonly { readonly tag: Tag | readonly Tag[]; readonly style: CodeTokenStyle }[] = [
  { tag: [t.keyword, t.modifier], style: { color: '#c792ea' } },
  { tag: [t.propertyName], style: { color: '#80cbc4' } },
  { tag: [t.className, t.tagName], style: { color: '#ffcb6b' } },
  { tag: [t.string, t.special(t.string)], style: { color: '#c3e88d' } },
  { tag: [t.number, t.unit, t.bool, t.null, t.atom], style: { color: '#f78c6c' } },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], style: { color: '#82aaff' } },
  { tag: [t.variableName, t.definition(t.variableName)], style: { color: '#e0e0e0' } },
  // Comments stay quiet but readable: #8a8a8a holds 5:1 on the panel, where
  // the old #616161 was 3:1.
  { tag: [t.comment, t.blockComment, t.lineComment], style: { color: '#8a8a8a', fontStyle: 'italic' } },
  { tag: [t.operator, t.punctuation, t.separator], style: { color: '#89ddff' } },
  { tag: [t.labelName, t.attributeName], style: { color: '#80cbc4' } },
  { tag: [t.color, t.constant(t.name), t.standard(t.name)], style: { color: '#f78c6c' } },
  // Markdown: the structure of a document rather than of code. Headings
  // lead, code and links pick up the colours their kind already has
  // elsewhere in this theme, and the marks (#, *, `) stay quiet.
  { tag: [t.heading], style: { color: '#f5f5f5', fontWeight: '600' } },
  { tag: [t.emphasis], style: { fontStyle: 'italic' } },
  { tag: [t.strong], style: { fontWeight: '600', color: '#f5f5f5' } },
  { tag: [t.link, t.url], style: { color: '#82aaff', textDecoration: 'underline' } },
  { tag: [t.monospace], style: { color: '#c3e88d' } },
  { tag: [t.quote], style: { color: '#999999', fontStyle: 'italic' } },
  { tag: [t.list], style: { color: '#89ddff' } },
  { tag: [t.processingInstruction, t.documentMeta], style: { color: '#8a8a8a' } },
];

// A file extension or a Markdown fence name, and the language it means. Formats
// with no grammar here (YAML) stay out: they show as plain text in the same type
// rather than coloured by a parser that misreads them. TOML has a small lexer of
// its own (tomlSyntax.ts), for Codex's agent definitions.
const CODE_LANGUAGE_NAMES: Readonly<Record<string, CodeLanguage>> = {
  astro: 'astro',
  bash: 'shell',
  cjs: 'javascript',
  console: 'shell',
  css: 'css',
  htm: 'html',
  html: 'html',
  javascript: 'javascript',
  js: 'javascript',
  json: 'json',
  jsonc: 'json',
  jsx: 'javascript',
  less: 'css',
  markdown: 'markdown',
  md: 'markdown',
  mdx: 'markdown',
  mjs: 'javascript',
  mts: 'typescript',
  sass: 'css',
  scss: 'css',
  sh: 'shell',
  shell: 'shell',
  svg: 'html',
  toml: 'toml',
  ts: 'typescript',
  tsx: 'typescript',
  typescript: 'typescript',
  vue: 'html',
  zsh: 'shell',
};

/** The language a Markdown fence names, when it names one this app can colour. */
export function languageNamed(name: string): CodeLanguage | undefined {
  return Object.hasOwn(CODE_LANGUAGE_NAMES, name.toLowerCase()) ? CODE_LANGUAGE_NAMES[name.toLowerCase()] : undefined;
}

/** The language of a path, by extension. */
export function languageFor(filePath: string | undefined): CodeLanguage | undefined {
  const extension = /\.([a-z0-9]+)$/.exec((filePath ?? '').toLowerCase())?.[1];
  return extension === undefined ? undefined : languageNamed(extension);
}

/** Text as lines of plain tokens: what shows until, or instead of, colouring. */
export function plainCodeLines(text: string): readonly CodeLine[] {
  return text.split('\n').map((line) => (line === '' ? [] : [{ text: line }]));
}

/**
 * Text as lines of coloured tokens, at once. Astro is not here: its grammar loads
 * on demand (astroHighlight.ts), so its lines arrive through `astroCodeLines`.
 *
 * Colouring is synchronous CPU, so this is for text of one slice or less (a diff
 * hunk, a command, a fence). Longer text comes back plain, instantly, and is
 * coloured slice by slice through `codeLineBatches`.
 */
export function codeTokenLines(text: string, language: Exclude<CodeLanguage, 'astro'> | undefined): readonly CodeLine[] {
  if (language === undefined || text.length > LIMITS.syntaxHighlightSliceCharsMax) {
    return plainCodeLines(text);
  }
  return colouredLines(text, language);
}

function colouredLines(text: string, language: Exclude<CodeLanguage, 'astro'>): readonly CodeLine[] {
  const tokens = language === 'shell' ? shellTokens(text) : language === 'commit' ? commitTokens(text) : grammarTokens(text, language);
  const lines = tokensByLine(tokens);
  assert(lines.length === text.split('\n').length, 'Coloured code keeps every line of its source');
  return lines;
}

// How long one parse step may run before the event loop gets a turn.
const parseSliceMsMax = 20;

/**
 * Text of any length as consecutive batches of coloured lines: together the
 * batches are exactly the lines of `text`. The first batch is ready after one
 * slice of work, so the top of a huge page is coloured at once; the rest follows
 * with the event loop free between batches (AGENTS.md section 10: the work of
 * one batch is bounded by `syntaxHighlightSliceCharsMax`, never by the text).
 * The consumer stops by ending its iteration.
 */
export async function* codeLineBatches(text: string, language: Exclude<CodeLanguage, 'astro'> | undefined): AsyncGenerator<readonly CodeLine[]> {
  const sliceCharsMax = LIMITS.syntaxHighlightSliceCharsMax;
  if (language === undefined || text.length <= sliceCharsMax) {
    yield language === undefined ? plainCodeLines(text) : colouredLines(text, language);
    return;
  }
  if (language === 'shell' || language === 'commit') {
    // These tokenisers carry little across lines, so each slice stands alone.
    for (const slice of lineSlices(text, 0, sliceCharsMax)) {
      yield colouredLines(text.slice(slice.start, slice.end), language);
      await yieldToEventLoop();
    }
    return;
  }
  yield* grammarBatches(text, language, sliceCharsMax);
}

async function* grammarBatches(
  text: string,
  language: Exclude<CodeLanguage, 'astro' | 'commit' | 'shell'>,
  sliceCharsMax: number,
): AsyncGenerator<readonly CodeLine[]> {
  const parser = grammarFor(language).parser;
  const wrapped = language === 'json';
  const offset = wrapped ? 1 : 0;
  const slices = lineSlices(text, 0, sliceCharsMax);
  let pending = nextOrUndefined(slices);
  // A parse is sequential, so waiting for the whole page would leave the top
  // uncoloured for as long as the page is long. Instead the page is parsed as a
  // prefix that doubles each round: the first window comes from a prefix of one
  // slice, and the work over all rounds is at most twice one parse of the page.
  // A prefix ends on a line break, so only its last tokens differ from the
  // whole-page parse; a later round emits the slices that end clear of the cut.
  let prefixCharsMax = sliceCharsMax;
  // Each round doubles the prefix, so the text's length bounds the rounds.
  for (let round = 0; pending !== undefined; round++) {
    assert(round < 64, 'grammarBatches: a prefix that doubles reaches any text within 64 rounds');
    const prefixSlice = nextLineSlice(text, 0, prefixCharsMax);
    const prefix = text.slice(0, prefixSlice.end);
    const source = wrapped ? `(${prefix}${prefixSlice.last ? ')' : ''}` : prefix;
    const tree = round === 0 ? parser.parse(source) : await parseInSlices(parser, source);
    const clearEnd = prefixSlice.end - sliceCharsMax;
    while (pending !== undefined && pending.end <= prefixSlice.end && (round === 0 || prefixSlice.last || pending.end <= clearEnd)) {
      yield tokensByLine(rangeTokens(tree, text, { offset, from: pending.start, to: pending.end }));
      await yieldToEventLoop();
      pending = nextOrUndefined(slices);
    }
    prefixCharsMax *= 2;
  }
}

// A Lezer parse advances in small steps, so it can be paused between any two.
async function parseInSlices(parser: Parser, source: string): Promise<Tree> {
  const parse = parser.startParse(source);
  let sliceStartedMs = performance.now();
  let previousPosition = 0;
  // A step reads or reduces input and error recovery skips it, so a parse ends
  // after a finite number of steps; the position never moves backwards.
  for (let step = 0; step < Number.MAX_SAFE_INTEGER; step++) {
    const tree = parse.advance();
    if (tree !== null) {
      return tree;
    }
    assert(parse.parsedPos >= previousPosition, 'parseInSlices: a parse never moves backwards');
    previousPosition = parse.parsedPos;
    if (performance.now() - sliceStartedMs > parseSliceMsMax) {
      await yieldToEventLoop();
      sliceStartedMs = performance.now();
    }
  }
  throw new Error('parseInSlices: the step counter ran out');
}

function nextOrUndefined(slices: Generator<LineSlice>): LineSlice | undefined {
  const result = slices.next();
  return result.done === true ? undefined : result.value;
}

// Each rule's index stands in for its class name, so a highlighted range can be
// looked up in the table instead of needing a generated stylesheet in the page.
const ruleHighlighter = tagHighlighter(CODE_TOKEN_RULES.map((rule, index) => ({ tag: rule.tag, class: String(index) })));

function ruleStyle(classes: string): CodeTokenStyle {
  // A node with several tags takes all their rules, the later one winning, as
  // the stylesheet CodeMirror generates from this table does.
  return classes.split(' ').reduce<CodeTokenStyle>((merged, index) => {
    const rule = CODE_TOKEN_RULES[Number(index)];
    assert(rule !== undefined, 'A highlighted range names a rule in the table');
    return { ...merged, ...rule.style };
  }, {});
}

function grammarTokens(text: string, language: Exclude<CodeLanguage, 'astro' | 'commit' | 'shell'>): readonly CodeToken[] {
  // A JSON document on its own reads as a block statement, which is a syntax
  // error by the first colon. In parentheses it is the object literal it looks
  // like, so the parse is of the wrapped text and the offsets step back by one.
  const wrapped = language === 'json';
  const tree = grammarFor(language).parser.parse(wrapped ? `(${text})` : text);
  return rangeTokens(tree, text, { offset: wrapped ? 1 : 0, from: 0, to: text.length });
}

/** The tokens of `text[from, to)` from a tree whose offsets are `offset` past the text's. */
function rangeTokens(tree: Tree, text: string, range: { readonly offset: number; readonly from: number; readonly to: number }): readonly CodeToken[] {
  assert(range.from <= range.to, 'rangeTokens: a range does not end before it starts');
  assert(range.to <= text.length, 'rangeTokens: a range stays inside the text');
  const tokens: CodeToken[] = [];
  let position = range.from;
  highlightTree(
    tree,
    ruleHighlighter,
    (from, to, classes) => {
      const start = Math.max(from - range.offset, position);
      const end = Math.min(to - range.offset, range.to);
      if (end <= start) {
        return;
      }
      if (position < start) {
        tokens.push({ text: text.slice(position, start) });
      }
      tokens.push({ text: text.slice(start, end), style: ruleStyle(classes) });
      position = end;
    },
    range.from + range.offset,
    range.to + range.offset,
  );
  if (position < range.to) {
    tokens.push({ text: text.slice(position, range.to) });
  }
  return tokens;
}

function grammarFor(language: Exclude<CodeLanguage, 'astro' | 'commit' | 'shell'>) {
  switch (language) {
    case 'css':
      return cssLanguage;
    case 'html':
      return htmlLanguage;
    case 'markdown':
      return markdownLanguage;
    case 'toml':
      return tomlLanguage;
    case 'json':
      return javascriptLanguage;
    case 'javascript':
    case 'typescript':
      // Both read as TSX, as the file they came from may hold either.
      return tsxLanguage;
    default: {
      const exhaustive: never = language;
      return exhaustive;
    }
  }
}

function tokensByLine(tokens: readonly CodeToken[]): readonly CodeLine[] {
  const lines: CodeToken[][] = [[]];
  for (const token of tokens) {
    token.text.split('\n').forEach((part, index) => {
      if (index > 0) {
        lines.push([]);
      }
      if (part !== '') {
        lines.at(-1)?.push({ ...token, text: part });
      }
    });
  }
  return lines;
}

// Shell has no grammar in the app's dependencies and the commands shown are one
// or two lines, so a small tokeniser covers it. Its kinds take their colours
// from the same table, by the tag each one is closest to.
const SHELL_TOKEN_TAGS = {
  argument: undefined,
  assignment: t.variableName,
  command: t.function(t.variableName),
  comment: t.lineComment,
  flag: t.attributeName,
  operator: t.operator,
  separator: t.operator,
  space: undefined,
  string: t.string,
  variable: t.variableName,
} as const;

type ShellTokenKind = keyof typeof SHELL_TOKEN_TAGS;

// Sticky patterns match at an index without slicing the text, so a long script
// costs time in proportion to its length instead of its length squared.
const SHELL_PATTERNS: readonly (readonly [ShellTokenKind, RegExp])[] = [
  ['space', /[ \t\r]+/y],
  ['separator', /(?:\n|;|&&|\|\||\||&)/y],
  ['operator', /[<>]+/y],
  ['string', /(?:'[^']*'?|"(?:\\.|[^"\\])*"?)/sy],
  ['variable', /\$(?:\{[^}\n]*\}?|[A-Za-z_][A-Za-z0-9_]*|[0-9@#?$!*-])/y],
  ['assignment', /[A-Za-z_][A-Za-z0-9_]*=(?:"[^"\n]*"?|'[^'\n]*'?|[^\s;|&<>]*)/y],
];
const SHELL_COMMENT = /#[^\n]*/y;
const SHELL_WORD = /(?:[^\s;|&<>'"$]+|.)/sy;

function matchAt(pattern: RegExp, text: string, index: number): string | undefined {
  // eslint-disable-next-line no-param-reassign -- a sticky pattern is positioned through lastIndex.
  pattern.lastIndex = index;
  return pattern.exec(text)?.[0];
}

function shellTokens(text: string): readonly CodeToken[] {
  const tokens: CodeToken[] = [];
  let index = 0;
  let commandNext = true;
  // Every pass consumes at least one character, so the text's length bounds it.
  while (index < text.length) {
    const wordStart = index === 0 || /\s/.test(text.charAt(index - 1));
    const [kind, value] = shellTokenOf(text, index, { commandNext, wordStart });
    assert(value.length > 0, 'A shell token consumes text');
    const tag = SHELL_TOKEN_TAGS[kind];
    tokens.push({ text: value, style: tag === undefined ? undefined : tagStyle(tag) });
    index += value.length;
    if (kind === 'separator') {
      commandNext = true;
    } else if (kind === 'command') {
      commandNext = false;
    }
  }
  assert(index === text.length, 'Shell tokens cover the whole text');
  return tokens;
}

function shellTokenOf(text: string, index: number, place: { readonly commandNext: boolean; readonly wordStart: boolean }): readonly [ShellTokenKind, string] {
  // A # opens a comment only where a word could start: `a#b` is one word.
  if (place.wordStart) {
    const comment = matchAt(SHELL_COMMENT, text, index);
    if (comment !== undefined) {
      return ['comment', comment];
    }
  }
  for (const [kind, pattern] of SHELL_PATTERNS) {
    const value = matchAt(pattern, text, index);
    if (value !== undefined) {
      return [kind, value];
    }
  }
  const word = matchAt(SHELL_WORD, text, index);
  assert(word !== undefined, 'The word pattern matches any character');
  if (word.startsWith('-')) {
    return ['flag', word];
  }
  return [place.commandNext ? 'command' : 'argument', word];
}

function tagStyle(tag: Tag): CodeTokenStyle | undefined {
  const classes = ruleHighlighter.style([tag]);
  return classes === null ? undefined : ruleStyle(classes);
}

// A commit subject in the Conventional Commits shape, `type(scope)!: message`.
// Only the prefix is coloured: the type reads as a keyword, the scope as a
// label, a breaking `!` in the warm colour values take, and the message stays
// plain because it is prose. A subject without the prefix is plain throughout.
const COMMIT_PREFIX = /^([A-Za-z]+)(?:(\()([^()\s:]*)(\)))?(!)?(:)/;

function commitTokens(text: string): readonly CodeToken[] {
  const match = COMMIT_PREFIX.exec(text);
  if (match === null) {
    return [{ text }];
  }
  const [prefix, type = '', open, scope, close, breaking, colon = ''] = match;
  const parts: readonly (readonly [string | undefined, Tag | undefined])[] = [
    [type, t.keyword],
    [open, t.punctuation],
    [scope, t.labelName],
    [close, t.punctuation],
    [breaking, t.atom],
    [colon, t.punctuation],
    [text.slice(prefix.length), undefined],
  ];
  const tokens = parts.flatMap(([value, tag]) => (value ? [{ text: value, style: tag === undefined ? undefined : tagStyle(tag) }] : []));
  assert(tokens.map((token) => token.text).join('') === text, 'Commit tokens cover the whole subject');
  return tokens;
}
