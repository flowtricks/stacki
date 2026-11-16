import { StreamLanguage, type Language, type StringStream } from '@codemirror/language';
import { highlightTree, tagHighlighter, tags as t, type Tag } from '@lezer/highlight';
import { assert } from '../../shared/core/assert';
import { LIMITS } from '../../shared/core/limits';
import { CODE_TOKEN_RULES, type CodeToken, type CodeTokenStyle } from './codeHighlight';
import type { AttributeLanguage } from './attributeLanguage';

// The grammars of attribute values that no stock language reads: a `sizes` list
// is not CSS (it is a comma list of media conditions each followed by a length),
// a `srcset` is not a URL, `d` is not a number list. Each is a few lines of
// lexer, because the job is colour and not a parse: the same tags the app's
// highlight style already colours, so a value looks like the rest of the code in
// the panel. A value the grammar cannot read stays plain rather than going red.
//
// Every language is a pure function of the text through the same `step` shape
// (a token's colour and the state after it), so the editor, which asks
// StreamLanguage for them, and the tests, which ask `attributeTokens`, read the
// same lexer and cannot disagree about what a value looks like.

/** The languages this module reads; JavaScript and a style attribute's declarations have their own. */
export type SyntaxLanguage = Exclude<AttributeLanguage, 'declarations' | 'javascript'>;

// What a step can call a token, in the tags the app's highlight style colours.
const TOKEN_TAGS = {
  atom: t.atom,
  bool: t.bool,
  function: t.function(t.variableName),
  keyword: t.keyword,
  nothing: t.null,
  number: t.number,
  operator: t.operator,
  property: t.propertyName,
  punctuation: t.punctuation,
  string: t.string,
  mediaType: t.className,
  variable: t.variableName,
} as const satisfies Readonly<Record<string, Tag>>;

type TokenName = keyof typeof TOKEN_TAGS;

interface Step<State> {
  /** Undefined is plain text. */
  readonly style: TokenName | undefined;
  readonly state: State;
}

interface Lexer<State> {
  readonly name: string;
  readonly start: State;
  /** Reads one token off the stream, which it must move forward. */
  readonly step: (stream: StringStream, state: State) => Step<State>;
}

/** The syntax extension for a language, to give an editor as its `syntax`. */
export function attributeSyntax(language: SyntaxLanguage): Language {
  return LANGUAGES[language];
}

/**
 * Text as coloured tokens, in the app's own colours, for tests and for text
 * shown rather than edited. Joining the tokens' texts gives the text back.
 */
export function attributeTokens(text: string, language: SyntaxLanguage): readonly CodeToken[] {
  assert(text.length <= LIMITS.attrCharsMax, 'attributeTokens: value limit exceeded');
  const tree = LANGUAGES[language].parser.parse(text);
  const tokens: CodeToken[] = [];
  let position = 0;
  highlightTree(tree, ruleHighlighter, (from, to, classes) => {
    if (from > position) {
      tokens.push({ text: text.slice(position, from) });
    }
    tokens.push({ text: text.slice(from, to), style: ruleStyle(classes) });
    position = to;
  });
  if (position < text.length) {
    tokens.push({ text: text.slice(position) });
  }
  assert(tokens.map((token) => token.text).join('') === text, 'attributeTokens: the tokens are the text');
  return tokens;
}

// Each rule's index stands in for its class name, as codeHighlight.ts does, so a
// highlighted range is looked up in the table without a generated stylesheet.
const ruleHighlighter = tagHighlighter(CODE_TOKEN_RULES.map((rule, index) => ({ tag: rule.tag, class: String(index) })));

function ruleStyle(classes: string): CodeTokenStyle {
  return classes.split(' ').reduce<CodeTokenStyle>((merged, index) => {
    const rule = CODE_TOKEN_RULES[Number(index)];
    assert(rule !== undefined, 'attributeTokens: a highlighted range names a rule in the table');
    return { ...merged, ...rule.style };
  }, {});
}

function define<State>(lexer: Lexer<State>): Language {
  return StreamLanguage.define<{ value: State }>({
    name: lexer.name,
    startState: () => ({ value: lexer.start }),
    copyState: (state) => ({ value: state.value }),
    // CodeMirror's stream parser advances the state object it hands in, and reads
    // "no style" as null; the step itself is computed without touching either.
    token(stream, state) {
      const before = stream.pos;
      const step = lexer.step(stream, state.value);
      assert(stream.pos > before, `${lexer.name}: every token moves forward`);
      // eslint-disable-next-line no-param-reassign -- StreamParser advances its state in place.
      state.value = step.state;
      // eslint-disable-next-line stacki/no-null -- StreamParser spells "no style" as null.
      return step.style ?? null;
    },
    tokenTable: TOKEN_TAGS,
  });
}

const NUMBER = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/i;

// `sizes` and `media`: `(min-width: 992px) 33vw, 100vw`. State: how deep in
// parentheses, and whether a feature's colon has been seen (what follows it is
// the feature's value, not another feature).
interface MediaState {
  readonly depth: number;
  readonly afterColon: boolean;
}

const MEDIA_KEYWORDS: ReadonlySet<string> = new Set(['all', 'and', 'not', 'only', 'or', 'print', 'screen', 'speech']);

const mediaQuery = define<MediaState>({
  name: 'media-query',
  start: { depth: 0, afterColon: false },
  step(stream, state) {
    if (stream.eatSpace()) {
      return { style: undefined, state };
    }
    if (stream.match(/^-?(?:\d+\.?\d*|\.\d+)(?:[a-z%]+)?/i)) {
      return { style: 'number', state };
    }
    if (stream.match(/^-{0,2}[a-z_][\w-]*/i)) {
      const text = stream.current().toLowerCase();
      if (stream.peek() === '(') {
        return { style: 'function', state };
      }
      if (MEDIA_KEYWORDS.has(text)) {
        return { style: 'keyword', state };
      }
      if (state.depth > 0 && !state.afterColon) {
        return { style: 'property', state };
      }
      return { style: state.afterColon ? 'atom' : 'variable', state };
    }
    const ch = stream.next() ?? '';
    if (ch === '(') {
      return { style: 'punctuation', state: { depth: state.depth + 1, afterColon: false } };
    }
    if (ch === ')') {
      return { style: 'punctuation', state: { depth: Math.max(0, state.depth - 1), afterColon: false } };
    }
    if (ch === ':') {
      return { style: 'punctuation', state: { ...state, afterColon: true } };
    }
    if (ch === ',') {
      return { style: 'punctuation', state: { ...state, afterColon: false } };
    }
    if (ch === '<' || ch === '>') {
      stream.eat('=');
      return { style: 'operator', state };
    }
    return { style: /[=+\-*/]/.test(ch) ? 'operator' : undefined, state };
  },
});

// `srcset`: `hero-480.jpg 480w, hero-960.jpg 960w`. State: whether the next
// token is a candidate's URL (the start, and after each comma) or a descriptor.
interface SourceSetState {
  readonly expectUrl: boolean;
}

const sourceSet = define<SourceSetState>({
  name: 'source-set',
  start: { expectUrl: true },
  step(stream, state) {
    if (stream.eatSpace()) {
      return { style: undefined, state };
    }
    if (stream.eat(',') !== undefined) {
      return { style: 'punctuation', state: { expectUrl: true } };
    }
    if (state.expectUrl) {
      stream.match(/^[^\s,]+/);
      return { style: 'string', state: { expectUrl: false } };
    }
    if (stream.match(/^(?:\d+\.?\d*|\.\d+)[wxh](?=[\s,]|$)/i)) {
      return { style: 'number', state };
    }
    stream.match(/^[^\s,]+/);
    return { style: undefined, state };
  },
});

// `d`: `M10 10 L20 20 Z`. A command letter is a keyword and the numbers around it are numbers.
const pathData = define<undefined>({
  name: 'path-data',
  start: undefined,
  step(stream, state) {
    if (stream.eatSpace()) {
      return { style: undefined, state };
    }
    if (stream.match(NUMBER)) {
      return { style: 'number', state };
    }
    const ch = stream.next() ?? '';
    if (/[MmLlHhVvCcSsQqTtAaZz]/.test(ch)) {
      return { style: 'keyword', state };
    }
    return { style: ch === ',' ? 'punctuation' : undefined, state };
  },
});

// `viewBox`, `points`, `transform`: numbers with units, and the functions that take them.
const svgNumbers = define<undefined>({
  name: 'svg-numbers',
  start: undefined,
  step(stream, state) {
    if (stream.eatSpace()) {
      return { style: undefined, state };
    }
    if (stream.match(/^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?(?:[a-z%]+)?/i)) {
      return { style: 'number', state };
    }
    if (stream.match(/^[a-z][\w-]*/i)) {
      return { style: stream.peek() === '(' ? 'function' : 'atom', state };
    }
    const ch = stream.next() ?? '';
    return { style: /[(),;]/.test(ch) ? 'punctuation' : undefined, state };
  },
});

// `pattern`: a regular expression. State: whether the text is inside `[...]`.
interface RegexState {
  readonly inClass: boolean;
}

const regex = define<RegexState>({
  name: 'regex',
  start: { inClass: false },
  step(stream, state) {
    if (stream.match(/^\\./)) {
      return { style: 'keyword', state };
    }
    if (state.inClass) {
      if (stream.eat(']') !== undefined) {
        return { style: 'punctuation', state: { inClass: false } };
      }
      stream.match(/^[^\]\\]+/);
      return { style: 'string', state };
    }
    if (stream.match(/^\[\^?/)) {
      return { style: 'punctuation', state: { inClass: true } };
    }
    if (stream.match(/^\(\?(?:<[=!]|[:=!]|<\w+>)?/) || stream.match(/^[()|]/)) {
      return { style: 'punctuation', state };
    }
    if (stream.match(/^(?:[*+?]|\{\d+(?:,\d*)?\})\??/)) {
      return { style: 'operator', state };
    }
    if (stream.match(/^[\^$.]/)) {
      return { style: 'atom', state };
    }
    if (stream.match(/^[^\\[\](){}|*+?^$.]+/) === null) {
      stream.next();
    }
    return { style: undefined, state };
  },
});

// `data-*` holding JSON: keys and strings differ, so a key is the property it names.
const json = define<undefined>({
  name: 'json-value',
  start: undefined,
  step(stream, state) {
    if (stream.eatSpace()) {
      return { style: undefined, state };
    }
    if (stream.match(/^"(?:[^"\\]|\\.)*"?/)) {
      return { style: stream.match(/^\s*:/, false) ? 'property' : 'string', state };
    }
    if (stream.match(/^-?\d+(?:\.\d+)?(?:e[-+]?\d+)?/i)) {
      return { style: 'number', state };
    }
    if (stream.match(/^(?:true|false)\b/)) {
      return { style: 'bool', state };
    }
    if (stream.match(/^null\b/)) {
      return { style: 'nothing', state };
    }
    if (stream.match(/^[{}[\],:]/)) {
      return { style: 'punctuation', state };
    }
    stream.match(/^[^\s"{}[\],:]+/);
    return { style: undefined, state };
  },
});

// `rel`, `type`, `accept`, `sandbox`: lists of keywords, media types and extensions.
const tokens = define<undefined>({
  name: 'token-list',
  start: undefined,
  step(stream, state) {
    if (stream.eatSpace()) {
      return { style: undefined, state };
    }
    if (stream.match(/^(?:[\w.+-]+|\*)\/[\w.+*-]+/)) {
      return { style: 'mediaType', state };
    }
    if (stream.match(/^\.[\w-]+/)) {
      return { style: 'string', state };
    }
    if (stream.match(/^[a-z][\w-]*(?==)/i)) {
      return { style: 'property', state };
    }
    if (stream.match(/^[a-z][\w-]*/i)) {
      return { style: 'keyword', state };
    }
    if (stream.match(/^\d+\.?\d*/)) {
      return { style: 'number', state };
    }
    const ch = stream.next() ?? '';
    return { style: ch === '=' ? 'operator' : /[,;]/.test(ch) ? 'punctuation' : undefined, state };
  },
});

// `<meta content>`: `width=device-width, initial-scale=1`. It is also where a
// description lives, which is a sentence, so nothing is coloured until the text
// shows itself to be pairs: the first `key=` turns the rest of it on.
interface PairsState {
  readonly pairs: boolean;
}

const keyValues = define<PairsState>({
  name: 'key-values',
  start: { pairs: false },
  step(stream, state) {
    if (stream.eatSpace()) {
      return { style: undefined, state };
    }
    if (stream.match(/^[\w.-]+(?==)/)) {
      return { style: 'property', state: { pairs: true } };
    }
    if (stream.eat('=') !== undefined) {
      return { style: 'operator', state: { pairs: true } };
    }
    if (stream.match(/^-?\d+\.?\d*(?![\w-])/)) {
      return { style: state.pairs ? 'number' : undefined, state };
    }
    if (stream.match(/^[\w.-]+/)) {
      return { style: state.pairs ? 'atom' : undefined, state };
    }
    const ch = stream.next() ?? '';
    return { style: state.pairs && /[,;]/.test(ch) ? 'punctuation' : undefined, state };
  },
});

const LANGUAGES: Readonly<Record<SyntaxLanguage, Language>> = {
  json,
  keyValues,
  mediaQuery,
  pathData,
  regex,
  sourceSet,
  svgNumbers,
  tokens,
};
