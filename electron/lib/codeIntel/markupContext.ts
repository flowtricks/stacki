// What the cursor is in, in a file with markup: .astro, and the markup half of .md and .mdx. One pass over the text up
// to the cursor with an explicit stack, so markup inside a `{…}` expression (a `.map` that returns elements) and an
// expression inside a tag are both followed. It reads the file as it is while being typed, so nothing has to be closed.
import { assert } from '../../../shared/core/assert';

export type MarkupContext =
  | { readonly kind: 'frontmatter' }
  | { readonly kind: 'expression' }
  | { readonly kind: 'text' }
  | { readonly kind: 'comment' }
  | { readonly kind: 'tag-name'; readonly from: number; readonly closing: boolean }
  | { readonly kind: 'attribute-name'; readonly tag: string; readonly from: number; readonly written: readonly string[] }
  | { readonly kind: 'attribute-value'; readonly tag: string; readonly attribute: string; readonly from: number }
  | EmbeddedBlock;

/** The inside of a `<script>` or `<style>`. */
export interface EmbeddedBlock {
  readonly kind: 'script' | 'style';
  readonly from: number;
  readonly to: number;
  /** The tag's attributes, lower-cased names to their quoted values (`''` for a bare one). */
  readonly attributes: ReadonlyMap<string, string>;
}

export interface MarkupBlocks {
  readonly scripts: readonly EmbeddedBlock[];
  readonly styles: readonly EmbeddedBlock[];
}

/** The frontmatter's content range, `from` after the opening fence and `to` before the closing one. */
export function frontmatterRange(text: string): { readonly from: number; readonly to: number; readonly end: number } | undefined {
  const open = /^﻿?\s*---[^\n]*\n/.exec(text);
  if (open === null) {
    return undefined;
  }
  const from = open[0].length;
  const close = /^---[^\n]*(\n|$)/m.exec(text.slice(from));
  if (close === null) {
    return { from, to: text.length, end: text.length };
  }
  return { from, to: from + close.index, end: from + close.index + close[0].length };
}

const TAG_NAME = /[A-Za-z0-9_.:-]/;
const BLOCK_OPEN = /<(script|style)(?=[\s/>])((?:"[^"]*"|'[^']*'|\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}|[^>"'{])*)>/gi;

/** Every `<script>` and `<style>` of the template, with where its content starts and ends. */
export function embeddedBlocks(text: string): MarkupBlocks {
  const scripts: EmbeddedBlock[] = [];
  const styles: EmbeddedBlock[] = [];
  const fence = frontmatterRange(text);
  const comments = [...text.matchAll(/<!--[\s\S]*?(?:-->|$)/g)].map((match) => [match.index, match.index + match[0].length] as const);
  const pattern = new RegExp(BLOCK_OPEN.source, BLOCK_OPEN.flags);
  pattern.lastIndex = fence?.end ?? 0;
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    const start = match.index;
    if (comments.some(([from, to]) => start > from && start < to)) {
      continue;
    }
    const tag = (match[1] ?? '').toLowerCase();
    const attributes = tagAttributes(match[2] ?? '');
    const from = start + match[0].length;
    if ((match[2] ?? '').trimEnd().endsWith('/')) {
      continue;
    }
    const closing = new RegExp(`</${tag}\\s*>`, 'gi');
    closing.lastIndex = from;
    const closed = closing.exec(text);
    const to = closed?.index ?? text.length;
    const block: EmbeddedBlock = { kind: tag === 'style' ? 'style' : 'script', from, to, attributes };
    (block.kind === 'style' ? styles : scripts).push(block);
    pattern.lastIndex = to;
  }
  return { scripts, styles };
}

function tagAttributes(source: string): ReadonlyMap<string, string> {
  const attributes = new Map<string, string>();
  for (const match of source.matchAll(/([A-Za-z_][\w:.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|(\{[^}]*\}?)|([^\s>]+)))?/g)) {
    attributes.set((match[1] ?? '').toLowerCase(), match[2] ?? match[3] ?? match[4] ?? match[5] ?? '');
  }
  return attributes;
}

interface MarkupFrame {
  readonly kind: 'markup';
}

class TagFrame {
  readonly kind = 'tag';
  readonly written: string[] = [];
  attribute: string | undefined;
  equals = false;
  constructor(readonly name: string) {}

  /** An attribute's name was written. */
  named(attribute: string): void {
    this.attribute = attribute;
    this.written.push(attribute);
    this.equals = false;
  }

  /** The `=` after a name: its value comes next. */
  assigned(): void {
    this.equals = true;
  }

  /** A value was written, so no attribute waits for one. */
  settled(): void {
    this.attribute = undefined;
    this.equals = false;
  }
}

class CodeFrame {
  readonly kind = 'code';
  private depth = 0;

  open(): void {
    this.depth += 1;
  }

  /** Counts a `}`, and says whether it ends the code. */
  close(): 'ended' | 'inside' {
    if (this.depth === 0) {
      return 'ended';
    }
    this.depth -= 1;
    return 'inside';
  }
}

type Frame = MarkupFrame | TagFrame | CodeFrame;

export function markupContext(text: string, offset: number): MarkupContext {
  assert(offset >= 0, 'markupContext: the cursor is not before the file');
  assert(offset <= text.length, 'markupContext: the cursor is inside the file');
  const fence = frontmatterRange(text);
  if (fence !== undefined) {
    if (offset >= fence.from && offset <= fence.to) {
      return { kind: 'frontmatter' };
    }
  }
  const blocks = embeddedBlocks(text);
  const all = [...blocks.scripts, ...blocks.styles];
  for (const block of all) {
    if (offset >= block.from && offset <= block.to) {
      return block;
    }
  }
  return new Scan(text, offset, new Map(all.map((block) => [block.from, block.to]))).run(fence?.end ?? 0);
}

class Scan {
  private readonly stack: Frame[] = [{ kind: 'markup' }];
  private position = 0;
  /** The answer, once the scan reaches a construct the cursor is inside. */
  private found: MarkupContext | undefined;

  constructor(
    private readonly text: string,
    private readonly offset: number,
    private readonly skips: ReadonlyMap<number, number>,
  ) {}

  run(from: number): MarkupContext {
    this.position = from;
    // Every step moves forward, so the text's length bounds the loop.
    for (let steps = 0; this.position < this.offset && this.found === undefined; steps++) {
      assert(steps <= this.text.length * 2 + 2, 'markupContext: the scan ends');
      this.step();
    }
    return this.found ?? this.contextAtEnd();
  }

  private step(): void {
    const frame = this.stack.at(-1);
    assert(frame !== undefined, 'markupContext: the root frame stays');
    switch (frame.kind) {
      case 'markup':
        this.markup();
        return;
      case 'tag':
        this.tag(frame);
        return;
      case 'code':
        this.code(frame);
        return;
      default: {
        const exhaustive: never = frame;
        return exhaustive;
      }
    }
  }

  private markup(): void {
    const { text, offset } = this;
    const at = this.position;
    if (text.startsWith('<!--', at)) {
      const close = text.indexOf('-->', at + 4);
      const end = close === -1 ? text.length + 1 : close + 3;
      if (offset < end) {
        this.found = { kind: 'comment' };
      }
      this.position = end;
      return;
    }
    const character = text.charAt(at);
    if (character === '{') {
      this.stack.push(new CodeFrame());
    } else if (character === '}' && this.stack.length > 1) {
      // Markup inside an expression ends where the expression does: the brace is left for the code around it.
      this.stack.pop();
      if (this.stack.at(-1)?.kind === 'code') {
        return;
      }
    } else if (character === '<') {
      this.openTag();
      return;
    }
    this.position = at + 1;
  }

  // At a `<` in markup: a closing tag, a fragment, or a tag whose name is read here.
  private openTag(): void {
    const { text, offset } = this;
    const at = this.position;
    const closing = text.charAt(at + 1) === '/';
    const nameFrom = at + (closing ? 2 : 1);
    let end = nameFrom;
    while (end < text.length && TAG_NAME.test(text.charAt(end))) {
      end++;
    }
    const name = text.slice(nameFrom, end);
    if (name === '' && !/[\s>/]|^$/.test(text.charAt(nameFrom))) {
      this.position = at + 1;
      return;
    }
    if (offset >= nameFrom && offset <= end) {
      this.found = { kind: 'tag-name', from: nameFrom, closing };
      return;
    }
    if (closing) {
      const close = text.indexOf('>', end);
      this.position = close === -1 ? text.length : close + 1;
      return;
    }
    if (name === '') {
      // `<>` opens a fragment; a lone `<` is text.
      this.position = at + (text.charAt(nameFrom) === '>' ? 2 : 1);
      return;
    }
    this.stack.push(new TagFrame(name));
    this.position = end;
  }

  private tag(frame: TagFrame): void {
    const { text, offset } = this;
    const at = this.position;
    const character = text.charAt(at);
    if (character === '>') {
      this.stack.pop();
      // A script or style's content is read by its own grammar.
      this.position = Math.max(at + 1, this.skips.get(at + 1) ?? at + 1);
    } else if (character === '<') {
      // A new tag before this one closed: this one is still being typed.
      this.stack.pop();
    } else if (character === '"' || character === "'") {
      this.quoted(frame, character);
    } else if (character === '{') {
      frame.settled();
      this.stack.push(new CodeFrame());
      this.position = at + 1;
    } else if (character === '=') {
      frame.assigned();
      this.position = at + 1;
    } else {
      const word = /^[^\s"'{}<>=/]+/.exec(text.slice(at, at + 200))?.[0];
      if (word === undefined) {
        this.position = at + 1;
      } else if (offset > at && offset <= at + word.length) {
        this.found = { kind: 'attribute-name', tag: frame.name, from: at, written: frame.written };
      } else {
        frame.named(word);
        this.position = at + word.length;
      }
    }
  }

  private quoted(frame: TagFrame, quote: string): void {
    const at = this.position;
    const close = this.text.indexOf(quote, at + 1);
    const end = close === -1 ? this.text.length : close;
    if (this.offset > at && this.offset <= end && frame.attribute !== undefined) {
      this.found = { kind: 'attribute-value', tag: frame.name, attribute: frame.attribute, from: at + 1 };
      return;
    }
    frame.settled();
    this.position = end + 1;
  }

  // JavaScript inside braces: strings and comments are stepped over, braces counted, and a `<` where a value may start
  // begins markup.
  private code(frame: CodeFrame): void {
    const { text, offset } = this;
    const at = this.position;
    const character = text.charAt(at);
    if (character === '"' || character === "'" || character === '`') {
      const end = stringEnd(text, at);
      if (offset > at && offset < end) {
        this.found = { kind: 'expression' };
      }
      this.position = end;
      return;
    }
    if (text.startsWith('/*', at) || text.startsWith('//', at)) {
      const block = text.startsWith('/*', at);
      const close = block ? text.indexOf('*/', at + 2) : text.indexOf('\n', at + 2);
      const end = close === -1 ? text.length + 1 : close + (block ? 2 : 1);
      if (offset > at && offset < end) {
        this.found = { kind: 'comment' };
      }
      this.position = end;
      return;
    }
    if (character === '{') {
      frame.open();
    } else if (character === '}') {
      if (frame.close() === 'ended') {
        this.stack.pop();
      }
    } else if (character === '<' && startsValue(text, at)) {
      if (/[A-Za-z/>]/.test(text.charAt(at + 1))) {
        this.stack.push({ kind: 'markup' });
        this.openTag();
        return;
      }
      if (at + 1 >= offset) {
        // `<` typed where an element may start: its name is about to be written.
        this.found = { kind: 'tag-name', from: at + 1, closing: false };
        return;
      }
    }
    this.position = at + 1;
  }

  private contextAtEnd(): MarkupContext {
    const frame = this.stack.at(-1);
    assert(frame !== undefined, 'markupContext: the root frame stays');
    if (frame.kind === 'code') {
      return { kind: 'expression' };
    }
    if (frame.kind === 'tag') {
      if (frame.equals && frame.attribute !== undefined) {
        // After `=` with no quote or brace yet: the value is starting.
        return { kind: 'attribute-value', tag: frame.name, attribute: frame.attribute, from: this.offset };
      }
      return { kind: 'attribute-name', tag: frame.name, from: this.offset, written: frame.written };
    }
    if (this.text.slice(0, this.offset).endsWith('<')) {
      return { kind: 'tag-name', from: this.offset, closing: false };
    }
    return { kind: 'text' };
  }
}

function stringEnd(text: string, at: number): number {
  const quote = text.charAt(at);
  for (let index = at + 1; index < text.length; index++) {
    const character = text.charAt(index);
    if (character === '\\') {
      index++;
    } else if (character === quote) {
      return index + 1;
    } else if (character === '\n' && quote !== '`') {
      return index;
    }
  }
  return text.length + 1;
}

function startsValue(text: string, at: number): boolean {
  const before = text.slice(Math.max(0, at - 40), at).trimEnd();
  return before === '' || /(?:[({[,?:&|=>]|\breturn)$/.test(before);
}

/** A tag that names a component rather than an HTML element: capitalised, or reached through a name (`Card.Title`). */
export function isComponentTag(tag: string): boolean {
  return /^[A-Z]/.test(tag) || (tag.includes('.') && !tag.startsWith('.'));
}
