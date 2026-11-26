// The classes and variables a stylesheet declares, read from CSS, SCSS, Sass-indented or Less text as it is on disk:
// comments, strings and interpolation are stepped over, and nothing needs to be valid. Whether a name is global or
// scoped to its component is decided here from `is:global` and `:global(…)`.

export interface StyleVariable {
  readonly name: string;
  readonly value: string;
  readonly offset: number;
  /** The innermost selector or at-rule it is declared in, for telling two values apart. */
  readonly selector: string;
  readonly global: boolean;
}

export interface StyleClass {
  readonly name: string;
  readonly offset: number;
  readonly global: boolean;
}

export interface StyleSymbols {
  /** Custom properties, named with their `--`. */
  readonly variables: readonly StyleVariable[];
  /** Sass `$name` and Less `@name` variables. */
  readonly preprocessorVariables: readonly StyleVariable[];
  readonly classes: readonly StyleClass[];
  /** What `@import`, `@use` and `@forward` name. */
  readonly imports: readonly { readonly specifier: string; readonly rule: string }[];
}

export interface StyleDialect {
  /** `//` comments exist in SCSS, Sass and Less, not in CSS. */
  readonly lineComments: boolean;
  readonly less: boolean;
  /** A whole sheet is global; a component's `<style>` is scoped unless it says otherwise. */
  readonly global: boolean;
}

export function dialectFor(language: string, scope: { readonly global: boolean }): StyleDialect {
  return { lineComments: language !== 'css', less: language === 'less', global: scope.global };
}

const SYMBOLS_MAX = 20_000;
const VALUE_CHARS_MAX = 200;
const AT_RULES_WITH_SELECTORS: ReadonlySet<string> = new Set(['@at-root', '@nest']);

interface Frame {
  readonly selector: string;
  readonly global: boolean;
}

interface Collected {
  readonly variables: StyleVariable[];
  readonly preprocessorVariables: StyleVariable[];
  readonly classes: StyleClass[];
  readonly imports: { specifier: string; rule: string }[];
}

export function styleSymbols(source: string, dialect: StyleDialect, base = 0): StyleSymbols {
  const collected: Collected = { variables: [], preprocessorVariables: [], classes: [], imports: [] };
  const stack: Frame[] = [];
  const text = withoutComments(source, dialect);
  let start = 0;
  let parentheses = 0;
  let quote = '';
  for (let index = 0; index <= text.length; index++) {
    const character = index === text.length ? ';' : text.charAt(index);
    if (quote !== '') {
      if (character === '\\') {
        index++;
      } else if (character === quote || character === '\n') {
        quote = '';
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '(') {
      parentheses++;
    } else if (character === ')') {
      parentheses = Math.max(0, parentheses - 1);
    } else if (character === '{' && text.charAt(index - 1) !== '#' && text.charAt(index - 1) !== '@') {
      stack.push(openRule(text.slice(start, index), base + start, { stack, dialect, collected }));
      start = index + 1;
      parentheses = 0;
    } else if (character === '{') {
      // Interpolation (`#{…}`, `@{…}`) belongs to the name around it.
      const close = text.indexOf('}', index);
      index = close === -1 ? text.length : close;
    } else if ((character === ';' && parentheses === 0) || character === '}') {
      declaration(text.slice(start, index), base + start, { stack, dialect, collected });
      if (character === '}') {
        stack.pop();
        parentheses = 0;
      }
      start = index + 1;
    }
  }
  return collected;
}

function withoutComments(source: string, dialect: StyleDialect): string {
  // Comments become spaces, so offsets stay those of the file.
  const blank = (match: string): string => match.replace(/[^\n]/g, ' ');
  const pattern = dialect.lineComments
    ? /"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|url\([^)\n]*\)|\/\*[\s\S]*?(?:\*\/|$)|\/\/[^\n]*/g
    : /"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|url\([^)\n]*\)|\/\*[\s\S]*?(?:\*\/|$)/g;
  return source.replace(pattern, (match) => (match.startsWith('/') ? blank(match) : match));
}

interface Place {
  readonly stack: readonly Frame[];
  readonly dialect: StyleDialect;
  readonly collected: Collected;
}

function openRule(prelude: string, offset: number, place: Place): Frame {
  const trimmed = prelude.trim().replace(/\s+/g, ' ');
  const parent = place.stack.at(-1);
  const inheritedGlobal = parent?.global === true || place.dialect.global;
  const atRule = /^@[\w-]+/.exec(trimmed)?.[0];
  if (atRule !== undefined && !AT_RULES_WITH_SELECTORS.has(atRule)) {
    return { selector: trimmed.slice(0, VALUE_CHARS_MAX), global: inheritedGlobal };
  }
  // `:global { … }` and a selector that is wholly `:global(…)` make what is nested global too.
  const global = inheritedGlobal || /^:global(\(.*\))?$/.test(trimmed);
  selectorClasses(prelude, offset, { global, collected: place.collected });
  return { selector: trimmed.slice(0, VALUE_CHARS_MAX), global };
}

function selectorClasses(prelude: string, offset: number, scope: { readonly global: boolean; readonly collected: Collected }): void {
  const { global, collected } = scope;
  const spans: Array<readonly [number, number]> = [];
  for (const match of prelude.matchAll(/:global\(((?:[^()]|\([^()]*\))*)\)/g)) {
    spans.push([match.index, match.index + match[0].length]);
  }
  // Strings and attribute selectors hold dots that are not classes.
  const plain = prelude.replace(/"[^"]*"|'[^']*'|\[[^\]]*\]/g, (match) => ' '.repeat(match.length));
  for (const match of plain.matchAll(/\.(-?[A-Za-z_\u0080-￿](?:[\w\u0080-￿-]|\\.)*)/g)) {
    if (collected.classes.length >= SYMBOLS_MAX) {
      return;
    }
    const name = (match[1] ?? '').replace(/\\(.)/g, '$1');
    const after = plain.charAt(match.index + match[0].length);
    // `.5s` is a number and `.icon-#{$x}` only half a name.
    if (after === '#' || after === '@') {
      continue;
    }
    const wrapped = spans.some(([from, to]) => match.index >= from && match.index < to);
    collected.classes.push({ name, offset: offset + match.index, global: global || wrapped });
  }
}

function declaration(statement: string, offset: number, place: Place): void {
  const trimmed = statement.trim();
  if (trimmed === '') {
    return;
  }
  const at = offset + statement.indexOf(trimmed.charAt(0));
  const imported = /^@(import|use|forward|reference)\s+(?:url\(\s*)?["']?([^"')\s]+)["']?/.exec(trimmed);
  if (imported !== null) {
    if (place.collected.imports.length < SYMBOLS_MAX) {
      place.collected.imports.push({ specifier: imported[2] ?? '', rule: imported[1] ?? '' });
    }
    return;
  }
  const custom = /^(--[\w\u0080-￿-]+)\s*:\s*([\s\S]*)$/.exec(trimmed);
  const parent = place.stack.at(-1);
  const found = (match: RegExpExecArray, into: StyleVariable[]): void => {
    if (into.length < SYMBOLS_MAX) {
      const value = (match[2] ?? '')
        .replace(/\s*!(default|global)\s*$/, '')
        .replace(/\s+/g, ' ')
        .trim();
      const global = parent?.global === true || place.dialect.global;
      into.push({ name: match[1] ?? '', value: value.slice(0, VALUE_CHARS_MAX), offset: at, selector: parent?.selector ?? '', global });
    }
  };
  if (custom !== null) {
    found(custom, place.collected.variables);
    return;
  }
  const preprocessor = (place.dialect.less ? /^(@[\w-]+)\s*:\s*([\s\S]*)$/ : /^(\$[\w-]+)\s*:\s*([\s\S]*)$/).exec(trimmed);
  if (preprocessor !== null && place.dialect.lineComments) {
    found(preprocessor, place.collected.preprocessorVariables);
  }
}

/** The class names a template's markup writes, for suggesting them while a stylesheet is written. */
export function markupClassNames(source: string): readonly { readonly name: string; readonly offset: number }[] {
  const names: { name: string; offset: number }[] = [];
  for (const match of source.matchAll(/\bclass(?:Name)?\s*=\s*(?:"([^"{}]*)"|'([^'{}]*)')/g)) {
    const value = match[1] ?? match[2] ?? '';
    for (const word of value.split(/\s+/)) {
      if (word !== '' && names.length < SYMBOLS_MAX) {
        names.push({ name: word, offset: match.index });
      }
    }
  }
  return names;
}

const NAMED_COLORS: ReadonlySet<string> = new Set([
  'black',
  'white',
  'red',
  'green',
  'blue',
  'yellow',
  'orange',
  'purple',
  'pink',
  'gray',
  'grey',
  'transparent',
  'rebeccapurple',
]);

/** The value, when it is a colour the editor can draw a swatch of. */
export function colorValue(value: string): string | undefined {
  const trimmed = value.trim();
  if (/^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i.test(trimmed)) {
    return trimmed;
  }
  if (/^(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color)\([^()]*\)$/i.test(trimmed)) {
    return trimmed;
  }
  return NAMED_COLORS.has(trimmed.toLowerCase()) ? trimmed : undefined;
}
