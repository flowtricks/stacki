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
import { highlightTree, tagHighlighter, tags as t, type Tag } from '@lezer/highlight';
import { assert } from '../../shared/core/assert';
import { LIMITS } from '../../shared/core/limits';

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

export type CodeLanguage = 'astro' | 'css' | 'html' | 'javascript' | 'json' | 'markdown' | 'shell' | 'typescript';

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
// with no grammar here (YAML, TOML) stay out: they show as plain text in the
// same type rather than coloured by a parser that misreads them.
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
 * Text as lines of coloured tokens. Astro is not here: its grammar loads on
 * demand (astroHighlight.ts), so its lines arrive through `astroCodeLines`.
 */
export function codeTokenLines(text: string, language: Exclude<CodeLanguage, 'astro'> | undefined): readonly CodeLine[] {
  if (language === undefined) {
    return plainCodeLines(text);
  }
  if (text.length > LIMITS.syntaxHighlightCharsMax) {
    return plainCodeLines(text);
  }
  const tokens = language === 'shell' ? shellTokens(text) : grammarTokens(text, language);
  const lines = tokensByLine(tokens);
  assert(lines.length === text.split('\n').length, 'Coloured code keeps every line of its source');
  return lines;
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

function grammarTokens(text: string, language: Exclude<CodeLanguage, 'astro' | 'shell'>): readonly CodeToken[] {
  // A JSON document on its own reads as a block statement, which is a syntax
  // error by the first colon. In parentheses it is the object literal it looks
  // like, so the parse is of the wrapped text and the offsets step back by one.
  const wrapped = language === 'json';
  const source = wrapped ? `(${text})` : text;
  const offset = wrapped ? 1 : 0;
  const tree = grammarFor(language).parser.parse(source);
  const tokens: CodeToken[] = [];
  let position = 0;
  highlightTree(tree, ruleHighlighter, (from, to, classes) => {
    const start = Math.max(from - offset, 0);
    const end = Math.min(to - offset, text.length);
    if (end <= start) {
      return;
    }
    assert(start >= position, 'Highlighted ranges arrive in order');
    if (position < start) {
      tokens.push({ text: text.slice(position, start) });
    }
    tokens.push({ text: text.slice(start, end), style: ruleStyle(classes) });
    position = end;
  });
  if (position < text.length) {
    tokens.push({ text: text.slice(position) });
  }
  return tokens;
}

function grammarFor(language: Exclude<CodeLanguage, 'astro' | 'shell'>) {
  switch (language) {
    case 'css':
      return cssLanguage;
    case 'html':
      return htmlLanguage;
    case 'markdown':
      return markdownLanguage;
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

const SHELL_PATTERNS: readonly (readonly [ShellTokenKind, RegExp])[] = [
  ['space', /^[ \t\r]+/],
  ['separator', /^(?:\n|;|&&|\|\||\||&)/],
  ['operator', /^[<>]+/],
  ['string', /^(?:'[^']*'?|"(?:\\.|[^"\\])*"?)/s],
  ['variable', /^\$(?:\{[^}\n]*\}?|[A-Za-z_][A-Za-z0-9_]*|[0-9@#?$!*-])/],
  ['assignment', /^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"\n]*"?|'[^'\n]*'?|[^\s;|&<>]*)/],
];
const SHELL_COMMENT = /^#[^\n]*/;
const SHELL_WORD = /^(?:[^\s;|&<>'"$]+|.)/s;

function shellTokens(text: string): readonly CodeToken[] {
  const tokens: CodeToken[] = [];
  let index = 0;
  let commandNext = true;
  // Every pass consumes at least one character, so the text's length bounds it.
  while (index < text.length) {
    const wordStart = index === 0 || /\s/.test(text.charAt(index - 1));
    const [kind, value] = shellTokenOf(text.slice(index), { commandNext, wordStart });
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

function shellTokenOf(rest: string, place: { readonly commandNext: boolean; readonly wordStart: boolean }): readonly [ShellTokenKind, string] {
  // A # opens a comment only where a word could start: `a#b` is one word.
  if (place.wordStart) {
    const comment = SHELL_COMMENT.exec(rest)?.[0];
    if (comment !== undefined) {
      return ['comment', comment];
    }
  }
  for (const [kind, pattern] of SHELL_PATTERNS) {
    const value = pattern.exec(rest)?.[0];
    if (value !== undefined) {
      return [kind, value];
    }
  }
  const word = SHELL_WORD.exec(rest)?.[0];
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
