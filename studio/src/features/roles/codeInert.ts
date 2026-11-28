// A shortcut for the edits typing makes, so the code check costs nothing a person can notice. It answers only when
// Astro's own compiler shows that an edit changed inert content and nothing else; otherwise the full check runs
// (codeGuard.ts). It never refuses anything.
//
// The proof has two parts, both asked of the compiler rather than guessed about its tokenizer. First, its TSX reading
// of the page changed by exactly the characters the source changed by: anything that became or stopped being markup or
// code is printed differently, and anything the TSX reading leaves out does not change it at all. Second, those
// characters sit, before and after alike, inside one run of markup text, one quoted value of an attribute that is only
// data, one style block's text, or the frontmatter (whose statements are then judged in full).
// roleCodeFastPath.test.ts holds the shortcut to the full check's verdict over thousands of hostile edits.
import ts from 'typescript';
import { textChange } from '../../shared/validation';
import { astroToTSX, type Converted } from './codeCompiler';
import { sinkOf } from './codeMarkup';
import { syntaxErrors } from './codeExpression';

export type InertEdit =
  | { readonly kind: 'markup' }
  | { readonly kind: 'style' }
  /** The template is untouched; these are the frontmatter's statements before and after. */
  | { readonly kind: 'frontmatter'; readonly before: string; readonly after: string };

interface Splice {
  readonly start: number;
  readonly removed: string;
  readonly inserted: string;
}

const CONVERSIONS_MAX = 4;
const DEPTH_MAX = 2_000;
// No tag, expression, template or escape can be opened or closed without one of these.
const NEVER = /[<>`\\\u0000-\u0008\u000b\u000c\u000e-\u001f]/;

function splice(before: string, after: string): Splice {
  const change = textChange(before, after);
  return { start: change.start, removed: before.slice(change.start, change.start + change.remove), inserted: change.insert };
}

interface Tree {
  readonly file: ts.SourceFile;
  readonly errors: number;
}

interface Reading extends Converted {
  tree?: Tree;
}

function treeOf(reading: Reading): Tree {
  if (reading.tree === undefined) {
    const file = ts.createSourceFile('page.tsx', reading.code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    reading.tree = { file, errors: syntaxErrors(file) };
  }
  return reading.tree;
}

type Place = { readonly kind: 'markup' | 'style'; readonly start: number; readonly end: number };

// The innermost node holding all of `from`..`to`.
function holding(file: ts.SourceFile, from: number, to: number): ts.Node {
  let node: ts.Node = file;
  for (let depth = 0; depth < DEPTH_MAX; depth++) {
    const child: ts.Node | undefined = node.forEachChild((item) => (item.pos <= from && to <= item.end ? item : undefined));
    if (child === undefined) {
      return node;
    }
    node = child;
  }
  return file;
}

const tagName = (node: ts.Node): string | undefined => (ts.isJsxElement(node) ? node.openingElement.tagName.getText().toLowerCase() : undefined);

// The inert run `from`..`to` sits in, or undefined. Text between tags may be extended at either end; a quoted value
// and a style block's text only between their quotes.
function placeOf(file: ts.SourceFile, from: number, to: number): Place | undefined {
  // The innermost node can be the closing tag that begins where the text ends, so the character before is asked too.
  for (const at of [from, from - 1]) {
    const node = holding(file, at, Math.max(at, to));
    if (ts.isJsxText(node) && node.pos <= from && to <= node.end) {
      const parent = tagName(node.parent);
      return parent === 'script' || parent === 'style' ? undefined : { kind: 'markup', start: node.pos, end: node.end };
    }
  }
  const node = holding(file, from, to);
  const start = node.getStart(file) + 1;
  const end = node.end - 1;
  if (from < start || to > end) {
    return undefined;
  }
  if (ts.isStringLiteral(node) && ts.isJsxAttribute(node.parent) && node.parent.initializer === node) {
    const name = node.parent.name.getText(file);
    const owner = node.parent.parent.parent;
    // A component's `onClick` may be spread onto an element, so every handler name counts, on elements and components.
    const component = /^[A-Z]|\./.test(owner.tagName.getText(file));
    const inert = sinkOf(name, !component) === 'none' && !/^(?:on|set:|is:|define:|client:|server:)/i.test(name);
    return inert ? { kind: 'markup', start, end } : undefined;
  }
  if (ts.isNoSubstitutionTemplateLiteral(node) && ts.isJsxExpression(node.parent) && tagName(node.parent.parent) === 'style') {
    return { kind: 'style', start, end };
  }
  return undefined;
}

// Whether both readings hold the change inside the same run, which grew or shrank by exactly the change.
function sameRun(before: Tree, after: Tree, change: Splice): Place | undefined {
  if (before.errors > 0 || after.errors > 0) {
    return undefined;
  }
  const was = placeOf(before.file, change.start, change.start + change.removed.length);
  const now = placeOf(after.file, change.start, change.start + change.inserted.length);
  if (was === undefined || now === undefined || was.kind !== now.kind || was.start !== now.start) {
    return undefined;
  }
  return now.end - was.end === change.inserted.length - change.removed.length ? was : undefined;
}

/** The frontmatter's text as both versions write it, when the change lies wholly between its fences. */
function frontmatterChange(before: string, after: string, change: Splice): InertEdit | undefined {
  const fence = /^﻿?\s*---[^\S\n]*\n/.exec(before);
  if (fence === null) {
    return undefined;
  }
  const start = fence[0].length - 1;
  const closing = /\n---[^\S\r\n]*(?:\r?\n|$)/g;
  closing.lastIndex = start;
  const end = closing.exec(before)?.index;
  if (end === undefined || change.start <= start || change.start + change.removed.length > end) {
    return undefined;
  }
  const old = before.slice(start, end);
  const now = after.slice(start, end + change.inserted.length - change.removed.length);
  // A new fence line would end the frontmatter somewhere else.
  const fenced = /(?:^|\n)[^\S\n]*---/;
  const rest = after.slice(start + now.length);
  return fenced.test(old) || fenced.test(now) || rest !== before.slice(end) ? undefined : { kind: 'frontmatter', before: old, after: now };
}

/** Reads edits for one workspace, keeping the last few conversions: a page's `after` is its next `before`. */
export class InertEdits {
  private readonly recent = new Map<string, Reading>();

  async read(before: string, after: string): Promise<InertEdit | undefined> {
    const change = splice(before, after);
    if (NEVER.test(change.removed) || NEVER.test(change.inserted)) {
      return undefined;
    }
    // A page the conversion cannot read is the full check's to judge.
    const was = await this.reading(before).catch(() => undefined);
    const now = was === undefined ? undefined : await this.reading(after).catch(() => undefined);
    if (was === undefined || now === undefined) {
      return undefined;
    }
    if (now.errors > was.errors) {
      return undefined;
    }
    const printed = splice(was.code, now.code);
    if (printed.removed !== change.removed || printed.inserted !== change.inserted) {
      return undefined;
    }
    const frontmatter = frontmatterChange(before, after, change);
    if (frontmatter !== undefined) {
      return frontmatter;
    }
    const place = sameRun(treeOf(was), treeOf(now), printed);
    // Braces open and close code everywhere but in a style block.
    if (place === undefined || (place.kind === 'markup' && /[{}]/.test(change.removed + change.inserted))) {
      return undefined;
    }
    return { kind: place.kind };
  }

  private async reading(source: string): Promise<Reading> {
    const found = this.recent.get(source);
    if (found !== undefined) {
      return found;
    }
    const reading: Reading = { ...(await astroToTSX(source)) };
    for (const oldest of this.recent.keys()) {
      if (this.recent.size < CONVERSIONS_MAX) {
        break;
      }
      this.recent.delete(oldest);
    }
    this.recent.set(source, reading);
    return reading;
  }
}
