// Scanning .astro source without parsing it: strings and comments skipped,
// matching braces, parentheses and close tags found, and loop and statement
// heads split, all within the bounds the parser states.

import { assert } from '../../shared/core/assert';
import { RAW_ELEMENTS, required } from './astroAttrs';

import { findMatchingBrace, skipStringOrComment, findMatchingParen } from './astroLexical';
import { scanTag } from './astroTag';

export { findMatchingBrace, findMatchingParen, skipStringOrComment };

// Recognizes {items.map((item) => ( <JSX/> ))} and turns it into a 'map'
// node whose JSX body is a parsed child tree (editable in the navigator).
// Returns undefined when the expression doesn't fit the pattern.
// The head as one line, for the Loop panel's field and for comparing an edited
// head against the source it came from.
export const normalizeHead = (text: string) => text.replace(/\s+/g, ' ').trim();

// The head's own lines with their shared indentation removed, so the serializer
// can lay them back out under whatever indent the node ends up at.
export function dedentHead(text: string): string {
  const lines = text.split('\n');
  while (lines.length && !required(lines[0], 'First line exists').trim()) {
    lines.shift();
  }
  if (lines.length < 2) {
    return normalizeHead(text);
  }
  const indents = lines.filter((line) => line.trim()).map((line) => (line.match(/^[ \t]*/)?.[0] ?? '').length);
  const common = Math.min(...indents);
  return lines
    .map((line) => (line.trim() ? line.slice(common) : ''))
    .join('\n')
    .trimEnd();
}

// Splits a statement block on the semicolons that actually end statements —
// not the ones inside strings, template literals, parens, braces, brackets, or
// comments. A comment is skipped whole: prose is allowed a semicolon in it, and
// an apostrophe in it is an apostrophe.
// Each piece says where in `src` it began, so what is found inside it can be
// pointed back at the file it came from.
function topLevelStatements(source: string): { text: string; at: number }[] {
  const out: { text: string; at: number }[] = [];
  const push = (end: number) => out.push({ text: source.slice(start, end), at: start });
  let depth = 0;
  let start = 0;
  for (let i = 0; i < source.length; i++) {
    const skipped = skipStringOrComment(source, i);
    if (skipped !== i) {
      i = skipped - 1;
      continue;
    }
    const character = source.charAt(i);
    if ('([{'.includes(character)) {
      depth++;
    } else if (')]}'.includes(character)) {
      depth--;
    } else if (character === ';' && depth === 0) {
      push(i);
      start = i + 1;
    } else if (character === '\n' && depth === 0) {
      // Semicolons are optional. A newline ends the statement when what
      // follows starts a new one — the same call JavaScript's own insertion
      // makes, without pretending to be a parser.
      if (/^\s*(const|let|return)\b/.test(source.slice(i))) {
        push(i);
        start = i + 1;
      }
    }
  }
  if (source.slice(start).trim()) {
    push(source.length);
  }
  return out;
}

// Where the code in a statement starts — past any comments in front of it, or
// undefined if a `/*` is left open. A comment is not a statement; it is someone
// telling the next reader why. Reading it as one turned a loop that says why it
// exists into a loop this file refused to open.
function afterComments(text: string): number | undefined {
  let i = 0;
  // Every pass returns or skips a comment of at least two characters.
  for (let pass = 0; pass <= text.length; pass++) {
    while (i < text.length && /\s/.test(text.charAt(i))) {
      i++;
    }
    if (i >= text.length) {
      return text.length;
    }
    if (!(text.charAt(i) === '/' && (text.charAt(i + 1) === '*' || text.charAt(i + 1) === '/'))) {
      return i;
    }
    if (text.charAt(i + 1) === '*' && text.indexOf('*/', i + 2) === -1) {
      return undefined;
    }
    const skipped = skipStringOrComment(text, i);
    if (skipped === i) {
      return i;
    }
    i = skipped;
  }
  assert(false, 'Comments in front of a statement end within its text');
}

// Whether a statement's last word is a comment — a `;` written after one would
// be written inside it.
function endsInComment(text: string): boolean {
  let inside = false;
  for (let i = 0; i < text.length; i++) {
    const skipped = skipStringOrComment(text, i);
    if (skipped !== i) {
      // A string ends a statement as well as any other word does; only a
      // comment swallows what is written after it.
      const comment = text.startsWith('//', i) || text.startsWith('/*', i);
      inside = comment && !text.slice(skipped).trim();
      i = skipped - 1;
    } else if (text.charAt(i).trim()) {
      inside = false;
    }
  }
  return inside;
}

// `(item) => { const x = …; return ( <jsx/> ); }` — the block form of a loop
// body. It's a loop like any other as long as the statements before the
// `return` are plain declarations: they're kept verbatim on the node and
// written back out, while the returned markup becomes the loop's children.
// Anything else in there (an if, a side effect, more than one return) can't be
// represented, so the whole expression stays code.
// A comment counts as none of that. It rides on the statement it introduces —
// including the `return` — so what it says is still there when the loop is
// written back.
// Returns { body: string[], markup: string, at: number } or undefined, where `at`
// is where the markup starts in `block` — the returned tree is a tree of the
// file, and every node in it has to be able to say which lines are its own.
export function splitBlockLoopBody(block: string): { body: string[]; markup: string; at: number } | undefined {
  const statements = topLevelStatements(block);
  if (!statements.length) {
    return undefined;
  }
  const body = [];
  for (let i = 0; i < statements.length; i++) {
    const statement = required(statements[i], 'Statement index is in bounds');
    const lead = statement.text.length - statement.text.trimStart().length;
    const raw = statement.text.trim();
    const rawAt = statement.at + lead;
    if (!raw) {
      continue;
    }
    const at = afterComments(raw);
    if (at === undefined) {
      return undefined;
    }
    const after = raw.slice(at);
    const text = after.trim();
    if (!text) {
      // A line of prose standing on its own, between the declarations.
      body.push(raw);
      continue;
    }
    if (/^return\b/.test(text)) {
      // The return must be the last thing in the block.
      if (statements.slice(i + 1).some((rest) => rest.text.trim())) {
        return undefined;
      }
      let markup = text.slice('return'.length);
      if (/^[ \t]*(?:\r|\n)/.test(markup)) {
        return undefined; // Automatic semicolon insertion makes this an empty return.
      }
      let markupAt = rawAt + at + (after.length - after.trimStart().length) + 'return'.length;
      const trimLeft = () => {
        const space = markup.length - markup.trimStart().length;
        markup = markup.trim();
        markupAt += space;
      };
      trimLeft();
      while (markup.startsWith('(') && findMatchingParen(markup, 0) === markup.length - 1) {
        markup = markup.slice(1, -1);
        markupAt += 1;
        trimLeft();
      }
      if (!markup.startsWith('<')) {
        return undefined;
      }
      if (at) {
        body.push(raw.slice(0, at).trim());
      }
      return { body, markup, at: markupAt };
    }
    if (!/^(const|let)\s/.test(text)) {
      return undefined;
    }
    body.push(endsInComment(raw) ? raw : raw.replace(/;*$/, ';'));
  }
  return undefined; // no return statement — nothing is rendered
}

// `data.map((i) => (` → `data.map((i) => {`, for writing a loop that carries
// declarations back out in the shape it was written in.
export const blockHead = (head: string) => head.replace(/\($/, '{');

// ---------------------------------------------------------------------------
// Conditional markup
// ---------------------------------------------------------------------------

// Top-level `?`, `:` and `&&` in a JS expression — the ones that actually
// split it, not the ones nested in a call, an object, a string, or a JSX tag.
// `?.` and `??` are single tokens, and `client:load` is an attribute name, so
// none of those count.
export function topLevelOps(source: string): { op: '?' | ':' | '&&'; at: number }[] {
  const out: { op: '?' | ':' | '&&'; at: number }[] = [];
  let depth = 0;
  for (let i = 0; i < source.length; i++) {
    const skipped = skipStringOrComment(source, i);
    if (skipped !== i) {
      i = skipped - 1;
      continue;
    }
    const ch = source.charAt(i);
    if (ch === '(' || ch === '[' || ch === '{') {
      depth++;
      continue;
    }
    if (ch === ')' || ch === ']' || ch === '}') {
      depth--;
      continue;
    }
    // Scan the complete opening tag; an arrow or comparison in a prop is
    // not the closing angle bracket and cannot change the surrounding depth.
    if (ch === '<') {
      const tag = scanTag(source, i);
      if (tag) {
        i = tag.end - 1;
        continue;
      }
    }
    if (depth !== 0) {
      continue;
    }
    if (ch === '?') {
      if (source.charAt(i + 1) === '?' || source.charAt(i + 1) === '.') {
        i++;
      } // ?? and ?. aren't ternaries
      else {
        out.push({ op: '?', at: i });
      }
    } else if (ch === ':') {
      out.push({ op: ':', at: i });
    } else if (ch === '&' && source.charAt(i + 1) === '&') {
      out.push({ op: '&&', at: i });
      i++;
    }
  }
  return out;
}

// Where the next `<` and `{` are at or after a position, and the nearer of the
// two; -1 for none.
interface Delimiters {
  readonly lt: number;
  readonly br: number;
  readonly next: number;
}

const NOT_SEARCHED = -2;
export const NOT_YET_FOUND: Delimiters = { lt: NOT_SEARCHED, br: NOT_SEARCHED, next: NOT_SEARCHED };

// The delimiters at or after `from`, reusing the previous answer: the parse
// position only moves forward, so a found index stays valid until the position
// passes it, and "none" (-1) stays none.
export function nextDelimiters(template: string, from: number, previous: Delimiters): Delimiters {
  const lt = nextIndexOf(template, '<', from, previous.lt);
  const br = nextIndexOf(template, '{', from, previous.br);
  if (lt === -1) {
    return { lt, br, next: br };
  }
  if (br === -1) {
    return { lt, br, next: lt };
  }
  return { lt, br, next: Math.min(lt, br) };
}

// `template.indexOf(needle, from)`, reusing `previous` — the answer for an earlier
// `from` — while it is still at or after `from`.
function nextIndexOf(template: string, needle: string, from: number, previous: number): number {
  assert(previous >= NOT_SEARCHED, 'A cached index is a position, -1, or not searched');
  if (previous === -1) {
    return -1;
  }
  if (previous >= from) {
    assert(template.charAt(previous) === needle, 'A cached index still names its needle');
    return previous;
  }
  return template.indexOf(needle, from);
}

// Matching paired tags skips complete attributes and expression bodies. A
// string such as "</div>" in a prop is data, never the parent's closing tag.
export function findMatchingClose(template: string, from: number, name: string): number {
  let depth = 1;
  let found = NOT_YET_FOUND;
  for (let position = from; position < template.length;) {
    found = nextDelimiters(template, position, found);
    const next = found.next;
    if (next === -1) {
      return -1;
    }
    if (next === found.br) {
      const end = findMatchingBrace(template, next);
      if (end === -1) {
        return -1;
      }
      position = end + 1;
    } else if (template.startsWith('<!--', next)) {
      const end = template.indexOf('-->', next + 4);
      position = end === -1 ? template.length : end + 3;
    } else if (template.startsWith(`</${name}`, next)) {
      const suffix = next + name.length + 2;
      const close = /^\s*>/.exec(template.slice(suffix));
      if (close) {
        depth--;
        if (depth === 0) {
          return next;
        }
        position = suffix + close[0].length;
      } else {
        position = suffix;
      }
    } else {
      const tag = scanTag(template, next);
      if (!tag) {
        position = next + 1;
        continue;
      }
      position = tag.end;
      if (tag.selfClose === '/') {
        continue;
      }
      if (tag.name === name) {
        depth++;
      } else if (RAW_ELEMENTS.has(tag.name)) {
        const close = template.indexOf(`</${tag.name}`, position);
        const end = close === -1 ? -1 : template.indexOf('>', close);
        position = end === -1 ? template.length : end + 1;
      }
    }
  }
  return -1;
}

// Fragment delimiters can also occur in quoted attributes, expressions and
// raw scripts. Skip those regions before counting nested <>…</> pairs.
export function findMatchingFragmentClose(template: string, from: number): number {
  let depth = 1;
  for (let position = from; position < template.length;) {
    if (template.charAt(position) === '{') {
      const end = findMatchingBrace(template, position);
      if (end === -1) {
        return -1;
      }
      position = end + 1;
    } else if (template.startsWith('<!--', position)) {
      const end = template.indexOf('-->', position + 4);
      if (end === -1) {
        return -1;
      }
      position = end + 3;
    } else if (template.startsWith('</>', position)) {
      if (--depth === 0) {
        return position;
      }
      position += 3;
    } else if (template.startsWith('<>', position)) {
      depth++;
      position += 2;
    } else if (template.charAt(position) === '<') {
      const tag = scanTag(template, position);
      if (!tag) {
        position++;
        continue;
      }
      position = tag.end;
      if (RAW_ELEMENTS.has(tag.name) && tag.selfClose !== '/') {
        const close = template.indexOf(`</${tag.name}`, position);
        const end = close === -1 ? -1 : template.indexOf('>', close);
        if (end === -1) {
          return -1;
        }
        position = end + 1;
      }
    } else {
      position++;
    }
  }
  return -1;
}
