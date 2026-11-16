// Where a page's frontmatter ends, read the way the Astro compiler reads it.
// This is the one place that decides it: the page parser, the component API
// readers, the property syntax and the style blocks all call it, so none of
// them can disagree with another or with the compiler about which bytes are
// code and which are markup.
//
// What the compiler does (checked against its `parse` and a real `astro build`):
//   - whitespace may precede the opening `---`, and spaces may follow it;
//   - the closing fence is the first `---` outside a string, template or
//     comment, so a `---` line inside a block comment does not close it;
//   - with no closing fence, everything after the opening one is code.
// A fence the editor would read differently (code on the opening line, a
// closing `---` that shares its line with anything but spaces, a fence behind a
// comment) is reported as unreadable, never guessed at: the page opens as
// code, with the reason, until the fence is written the plain way.

import { skipStringOrComment } from './astroLexical';

export type FenceRead =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'fence';
      /** Offset of the first code character, after the opening fence's line break. */
      readonly codeStart: number;
      /** Offset of the closing fence's first dash. */
      readonly codeEnd: number;
      /** The code between the fences, closing line break included; empty for an empty block. */
      readonly code: string;
      /** The block as a prefix of the text: through the closing fence and its line break. */
      readonly length: number;
    }
  | { readonly kind: 'unreadable'; readonly what: string; readonly near: string };

const OPENING_FENCE = /^\s*---[ \t]*\r?\n/;
const FENCE_TAIL = /[ \t]*(?:\r?\n|$)/y;
const LEADING_COMMENTS = /^(?:\s|<!--[\s\S]*?-->)*---/;

/** `text` is the page as read, a leading byte-order mark included: offsets index it. */
export function readFence(text: string): FenceRead {
  const start = text.startsWith('﻿') ? 1 : 0;
  const opening = OPENING_FENCE.exec(text.slice(start));
  if (opening === null) {
    // The compiler reads a leading `---` as frontmatter however it continues.
    if (/^\s*---/.test(text.slice(start))) {
      return {
        kind: 'unreadable',
        what: 'a frontmatter fence the editor cannot read (an unclosed fence, or code on the opening line)',
        near: text.slice(start).trimStart().slice(0, 40),
      };
    }
    return LEADING_COMMENTS.test(text.slice(start))
      ? { kind: 'unreadable', what: 'a frontmatter fence after a comment', near: text.slice(start, start + 40) }
      : { kind: 'none' };
  }
  const codeStart = start + opening[0].length;
  const codeEnd = firstFenceIn(text, codeStart);
  if (codeEnd === -1) {
    return {
      kind: 'unreadable',
      what: 'a frontmatter fence the editor cannot read (an unclosed fence, or code on the opening line)',
      near: text.slice(start, start + 40),
    };
  }
  if (codeEnd > codeStart && text.charAt(codeEnd - 1) !== '\n') {
    return { kind: 'unreadable', what: 'a --- that shares its line with frontmatter code', near: text.slice(codeEnd - 20, codeEnd + 20) };
  }
  FENCE_TAIL.lastIndex = codeEnd + 3;
  const tail = FENCE_TAIL.exec(text);
  if (tail === null) {
    return { kind: 'unreadable', what: 'text after the closing frontmatter fence on its line', near: text.slice(codeEnd, codeEnd + 40) };
  }
  return { kind: 'fence', codeStart, codeEnd, code: text.slice(codeStart, codeEnd), length: codeEnd + 3 + tail[0].length };
}

/** The readable frontmatter block of a page, or undefined when it has none or the fence is unreadable. */
export function frontmatterOf(source: string): Extract<FenceRead, { kind: 'fence' }> | undefined {
  const fence = readFence(source);
  return fence.kind === 'fence' ? fence : undefined;
}

// The compiler's closing fence: the first `---` outside strings and comments.
function firstFenceIn(text: string, from: number): number {
  // Each pass moves forward by at least one character.
  for (let position = from; position < text.length; position++) {
    const skipped = skipStringOrComment(text, position);
    if (skipped !== position) {
      position = skipped - 1;
    } else if (text.startsWith('---', position)) {
      return position;
    }
  }
  return -1;
}
