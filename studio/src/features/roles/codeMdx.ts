// Where an MDX file holds code: its imports and exports, every `{…}`, and the browser code of a tag. There is no MDX
// parser among Studio's dependencies, so this reads conservatively: only a code fence that starts its line, or a code
// span that surely closes where this reads it to, hides braces. Anything it is unsure about counts as code, which can
// only refuse more.
import { expressionUnit, scriptAddress, type CodeUnit } from './codeMarkup';

export interface MdxCode {
  /** The import and export lines, as one module. */
  readonly module: string;
  readonly units: readonly CodeUnit[];
}

const CHARS_MAX = 1_100_000;
// MDX reads a line that opens with either word and a space as code. Only plain words after it are certainly prose
// ("export your data"), which no import or export can be.
const ESM = /^(?:import|export) /;
const KEYWORDS = 'abstract|async|class|const|declare|default|enum|function|interface|let|namespace|type|var';
const PROSE = new RegExp(`^(?:import|export) +(?!(?:${KEYWORDS})\\b)[A-Za-z]+[,.!?]? +(?!from\\b)[A-Za-z]+(?:[ ,.!?]|$)`);

interface Scan {
  readonly source: string;
  at: number;
  inTag: boolean;
  /** Set by a backtick that does not close on its line: later ones in the paragraph may pair with it. */
  spansOpen: boolean;
  readonly module: string[];
  readonly units: CodeUnit[];
}

export function readMdxCode(source: string): MdxCode {
  if (source.length > CHARS_MAX) {
    throw new Error('This file is too large to check');
  }
  // A lone carriage return ends a line for MDX too.
  const text = source.replace(/\r\n?/g, '\n').replace(/^﻿?---\n[\s\S]*?\n---[ \t]*(?:\n|$)/, '');
  const scan: Scan = { source: text, at: 0, inTag: false, spansOpen: false, module: [], units: [] };
  // Every step moves forward, so the file's length bounds the loop.
  while (scan.at < text.length) {
    const before = scan.at;
    step(scan);
    if (scan.at <= before) {
      throw new Error('This file could not be checked');
    }
  }
  return { module: scan.module.join('\n'), units: scan.units };
}

function step(scan: Scan): void {
  const atLineStart = scan.at === 0 || scan.source[scan.at - 1] === '\n';
  if (atLineStart && /^[ \t]*(?:\n|$)/.test(scan.source.slice(scan.at, lineEnd(scan.source, scan.at) + 1))) {
    // A blank line ends the paragraph, and with it any span still open.
    scan.spansOpen = false;
  }
  if (atLineStart && !scan.inTag && (fence(scan) || moduleBlock(scan))) {
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
    if (/^on[a-z]+$/.test(name) || scriptAddress(value)) {
      scan.units.push({ kind: 'browser', key: `attribute:${name}=${value}` });
    }
    scan.at += attribute[0].length;
    return;
  }
  if (character === '"' || character === "'") {
    const close = scan.source.indexOf(character, scan.at + 1);
    scan.at = close < 0 ? scan.source.length : close + 1;
    return;
  }
  scan.at += 1;
}

// One `{…}`, matched past strings and comments. A wrong match cannot parse as an expression, so it is refused.
function braces(scan: Scan): void {
  const end = closingBrace(scan.source, scan.at);
  const inner = scan.source.slice(scan.at + 1, end);
  scan.units.push(expressionUnit(inner.replace(/^\s*\.\.\./, ''), new Set(), 'none'));
  scan.at = Math.min(scan.source.length, end + 1);
}

function closingBrace(source: string, open: number): number {
  let depth = 0;
  const token = /[{}]|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g;
  token.lastIndex = open;
  for (let found = token.exec(source); found !== null; found = token.exec(source)) {
    if (found[0] === '{') {
      depth += 1;
    } else if (found[0] === '}') {
      depth -= 1;
      if (depth === 0) {
        return found.index;
      }
    }
  }
  return source.length;
}
