// Where an MDX file holds code: its imports and exports, every `{…}`, and the browser code of a tag. There is no MDX
// parser among Studio's dependencies, so this reads conservatively: only a code fence that starts its line, or a code
// span that surely closes where this reads it to, hides braces. Anything it is unsure about counts as code, which can
// only refuse more.
import { decodeEntities, declarationsOf, expressionUnit, runsWritten, type CodeUnit } from './codeMarkup';
import { skipper, type Skipper } from './codeText';

export interface MdxCode {
  /** The import and export lines, as one module. */
  readonly module: string;
  readonly units: readonly CodeUnit[];
}

const CHARS_MAX = 1_100_000;
// MDX reads a line that opens with either word as code when a space, a tab or punctuation of the language follows.
// Only plain words after spaces are certainly prose ("export your data"), which no import or export can be.
const ESM = /^(?:import|export)(?=[\s{*'"`(/]|$)/;
const KEYWORDS = 'abstract|async|class|const|declare|default|enum|function|interface|let|namespace|type|var';
const PROSE = new RegExp(`^(?:import|export) +(?!(?:${KEYWORDS})\\b)[A-Za-z]+[,.!?]? +(?!from\\b)[A-Za-z]+(?:[ ,.!?]|$)`);

interface Scan {
  readonly source: string;
  at: number;
  inTag: boolean;
  readonly strings: Skipper;
  /** The name of the tag being read. */
  tag: string;
  /** Set by a backtick that does not close on its line: later ones in the paragraph may pair with it. */
  spansOpen: boolean;
  readonly module: string[];
  readonly units: CodeUnit[];
  /** The names written as tags that are a component or a value, not an HTML element. */
  readonly tags: Set<string>;
}

export function readMdxCode(source: string): MdxCode {
  if (source.length > CHARS_MAX) {
    throw new Error('This file is too large to check');
  }
  // A lone carriage return ends a line for MDX too.
  const text = source.replace(/\r\n?/g, '\n').replace(/^﻿?---\n[\s\S]*?\n---[ \t]*(?:\n|$)/, '');
  const scan: Scan = { source: text, at: 0, inTag: false, tag: '', strings: skipper(text), spansOpen: false, module: [], units: [], tags: new Set() };
  // Every step moves forward, so the file's length bounds the loop.
  while (scan.at < text.length) {
    const before = scan.at;
    step(scan);
    if (scan.at <= before) {
      throw new Error('This file could not be checked');
    }
  }
  const module = scan.module.join('\n');
  return { module, units: [...scan.units, ...tagUnits(module, scan.tags), ...linkUnits(text)] };
}

// A tag named after a value the file declares writes whatever element the value says, so it is code.
function tagUnits(module: string, tags: ReadonlySet<string>): readonly CodeUnit[] {
  const { declared } = declarationsOf(module);
  return [...tags].flatMap((name): readonly CodeUnit[] => {
    const declaration = declared.get(name.split('.')[0] ?? '');
    return declaration === undefined ? [] : [{ kind: 'browser', key: `tag:${name}\n${declaration}` }];
  });
}

// Markdown's own links and bare script addresses. Code samples are not told apart, which can only refuse more.
const SCRIPT_LINK = /(?:\]\(|\]:)\s*(?:<\s*)?(?:javascript|vbscript|data:text\/html):|(?:javascript|vbscript):(?!\s)/gi;
const LINKS_MAX = 1_000;
const LINK_CHARS = 200;
function linkUnits(text: string): readonly CodeUnit[] {
  const written = decodeEntities(text)
    .replace(/\t/g, '')
    .replace(/\\(?=[!-/:-@[-`{-~])/g, '');
  const found: CodeUnit[] = [];
  for (const match of written.matchAll(SCRIPT_LINK)) {
    if (found.length >= LINKS_MAX) {
      throw new Error('This file is too large to check');
    }
    const rest = written.slice(match.index, match.index + LINK_CHARS);
    found.push({ kind: 'browser', key: `link:${rest.split('\n')[0] ?? ''}` });
  }
  return found;
}

function step(scan: Scan): void {
  const atLineStart = scan.at === 0 || scan.source[scan.at - 1] === '\n';
  if (atLineStart && /^[ \t]*(?:\n|$)/.test(scan.source.slice(scan.at, lineEnd(scan.source, scan.at) + 1))) {
    // A blank line ends the paragraph, and with it any span still open.
    scan.spansOpen = false;
  }
  // A module line counts even where this reading believes a tag is open: it may be wrong about that.
  if (atLineStart && ((!scan.inTag && fence(scan)) || moduleBlock(scan))) {
    return;
  }
  const character = scan.source[scan.at];
  if (character === '{') {
    braces(scan);
  } else if (scan.inTag) {
    tagStep(scan, character ?? '');
  } else if (character === '\\') {
    scan.at += 2;
  } else if (character === '`') {
    codeSpan(scan);
  } else if (character === '<' && /^<[A-Za-z/>!]/.test(scan.source.slice(scan.at, scan.at + 2))) {
    openTag(scan);
  } else {
    scan.at += 1;
  }
}

const lineEnd = (source: string, from: number): number => {
  const end = source.indexOf('\n', from);
  return end < 0 ? source.length : end;
};

function fence(scan: Scan): boolean {
  // Only at the line's very start: an indented fence may sit in a list item, which can end without closing it.
  const opening = /^(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})/.exec(scan.source.slice(scan.at, lineEnd(scan.source, scan.at)))?.[1];
  if (opening === undefined) {
    return false;
  }
  const closing = new RegExp(`\\n {0,3}${opening[0]}{${opening.length},}[ \\t]*(?=\\n|$)`, 'g');
  closing.lastIndex = scan.at;
  const found = closing.exec(scan.source);
  scan.at = found === null ? scan.source.length : found.index + found[0].length + 1;
  return true;
}

function moduleBlock(scan: Scan): boolean {
  const line = scan.source.slice(scan.at, Math.min(lineEnd(scan.source, scan.at), scan.at + 200));
  if (!ESM.test(line) || PROSE.test(line)) {
    return false;
  }
  const blank = /\n[ \t]*(?:\n|$)/g;
  blank.lastIndex = scan.at;
  const end = blank.exec(scan.source)?.index ?? scan.source.length;
  scan.module.push(scan.source.slice(scan.at, end));
  scan.at = end + 1;
  return true;
}

// A code span hides braces only when it closes on its own line, with no earlier backtick of the paragraph still open.
function codeSpan(scan: Scan): void {
  const run = /^`+/.exec(scan.source.slice(scan.at, scan.at + 200))?.[0] ?? '`';
  const line = scan.source.slice(scan.at + run.length, lineEnd(scan.source, scan.at));
  const close = scan.spansOpen ? null : new RegExp(`(?<!\`)${run}(?!\`)`).exec(line);
  scan.spansOpen ||= close === null;
  scan.at += close === null ? run.length : run.length + close.index + run.length;
}

function openTag(scan: Scan): void {
  const script = /^<script\b/i.exec(scan.source.slice(scan.at, scan.at + 8));
  if (script !== null) {
    const close = scan.source.toLowerCase().indexOf('</script', scan.at);
    const end = close < 0 ? scan.source.length : close;
    scan.units.push({ kind: 'browser', key: `script:${scan.source.slice(scan.at, end)}` });
  }
  const name = /^<([A-Za-z_$][\w$.:-]*)/.exec(scan.source.slice(scan.at, scan.at + 200))?.[1] ?? '';
  if (/^[A-Z_$]|\./.test(name)) {
    scan.tags.add(name);
  }
  scan.tag = name;
  scan.inTag = true;
  scan.at += 1;
}

function tagStep(scan: Scan, character: string): void {
  if (character === '>') {
    scan.inTag = false;
    scan.at += 1;
    return;
  }
  const attribute = /^([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(scan.source.slice(scan.at, scan.at + 4_000));
  if (attribute !== null && /\s/.test(scan.source[scan.at - 1] ?? '')) {
    const name = (attribute[1] ?? '').toLowerCase();
    const value = attribute[2] ?? attribute[3] ?? '';
    const owner = { element: !/^[A-Z]|\./.test(scan.tag), tag: scan.tag.toLowerCase() };
    if (/^on[a-z]+$/.test(name) || runsWritten(name, value, owner)) {
      scan.units.push({ kind: 'browser', key: `attribute:${name}=${value}` });
    }
    // As for any quote: one holding what could be code is read on, from the attribute's name.
    scan.at += HIDDEN.test(value) ? (attribute[1] ?? '').length : attribute[0].length;
    return;
  }
  if (character === '"' || character === "'") {
    quoted(scan, character);
    return;
  }
  scan.at += 1;
}

// A quoted value hides nothing it holds from this check: what reads as a tag here may be words to MDX, and the
// quote then opens no value. So a quote is passed over only when nothing in it could be code.
const HIDDEN = /\{|\n[ \t>*+-]*(?:import|export)/;
function quoted(scan: Scan, quote: string): void {
  const close = scan.source.indexOf(quote, scan.at + 1);
  if (close < 0 || HIDDEN.test(scan.source.slice(scan.at, close))) {
    scan.at += 1;
    return;
  }
  scan.at = close + 1;
}

function hidesBrace(code: string): boolean {
  const strings = skipper(code);
  for (let at = 0; at < code.length;) {
    const end = strings.endOf(at);
    if (end === undefined) {
      at++;
    } else {
      if (/[{}]/.test(code.slice(at, end))) {
        return true;
      }
      at = end;
    }
  }
  return false;
}

// One `{…}`, matched past strings and comments. A wrong match cannot parse as an expression, so it is refused.
function braces(scan: Scan): void {
  const end = closingBrace(scan.source, scan.at, scan.strings);
  const inner = scan.source.slice(scan.at + 1, end);
  scan.units.push(expressionUnit(inner.replace(/^\s*\.\.\./, ''), new Set(), 'none'));
  // A brace inside a string or a comment is only text if this one is code at all: where MDX reads the opening brace
  // as words, what the string holds is the code. So such an expression is new code unless it was already there.
  if (hidesBrace(inner)) {
    scan.units.push({ kind: 'browser', key: `braces:${inner}` });
  }
  scan.at = Math.min(scan.source.length, end + 1);
}

function closingBrace(source: string, open: number, strings: Skipper): number {
  let depth = 0;
  for (let at = open; at < source.length;) {
    const end = strings.endOf(at);
    if (end !== undefined) {
      at = end;
      continue;
    }
    if (source[at] === '{') {
      depth += 1;
    } else if (source[at] === '}') {
      depth -= 1;
      if (depth === 0) {
        return at;
      }
    }
    at += 1;
  }
  return source.length;
}
