// Goal: one scanner that finds every place a stylesheet or a style object makes an
// element a scroll container, and says whether that place keeps a stable scrollbar
// gutter (docs/scroll-gutter.md). The policy test and the inventory both read it,
// so the count in the docs and the rule the gate holds cannot disagree.
// Method: strip comments, find each `overflow`, `overflow-x` and `overflow-y`
// declaration (kebab-case in CSS, camelCase in a TypeScript style object), take the
// innermost `{ }` block around it as the declaration's owner, and read that
// block's own declarations. Nothing here parses a whole stylesheet: a block is
// the unit the browser's cascade works in too, so "the same rule provides the
// gutter" means "the same block".
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

export type Axis = 'x' | 'y';

export interface ScrollContainer {
  /** Repository-relative path, written with `/`. */
  readonly file: string;
  /** One-based line of the first overflow declaration in the block. */
  readonly line: number;
  /** The selector that opens the block (CSS), or the declaration text (TypeScript). */
  readonly locator: string;
  /** The axes whose overflow is auto, scroll or overlay. */
  readonly axes: readonly Axis[];
  /** Whether the block declares `scrollbar-gutter: stable` (any `stable ...` value). */
  readonly gutterStable: boolean;
  /**
   * True when only the horizontal axis can scroll and the vertical one is hidden or
   * clipped in the same block: the gutter is an inline-axis (vertical-bar) space,
   * so a bar on the horizontal axis cannot move the content's width.
   */
  readonly horizontalOnly: boolean;
  /**
   * True when the same block declares `scrollbar-width: none`: the element still scrolls, but no bar is ever drawn,
   * so no bar can take space or move content.
   */
  readonly barHidden: boolean;
  /** Offset in the file where a `scrollbar-gutter` line would go: the end of the line holding the block's last overflow declaration. */
  readonly insertAt: number;
  /** The indentation of that line. */
  readonly indent: string;
}

/** The largest file the scan reads; a bound so a stray artifact cannot stall the gate. */
export const FILE_BYTES_MAX = 4_000_000;

const SCROLLING = new Set(['auto', 'scroll', 'overlay']);
const CLIPPING = new Set(['hidden', 'clip']);
const SCAN_EXTENSIONS = new Set(['.css', '.ts', '.tsx', '.html']);
// `generated` holds build output (the apps UI kit's CSS copy); its sources are scanned, so counting the copy would count each rule twice.
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', 'vendor', 'test-results', '.git', 'generated']);
const DIRECTORY_DEPTH_MAX = 24;
const BLOCK_SCAN_CHARACTERS_MAX = 20_000;

/** The roots the rule covers: the desktop app, the contract surface, Studio and the demo. */
export const SCAN_ROOTS = ['src', 'shared', 'studio/src', 'studio/demo'] as const;

export function listScanFiles(root: string, scanRoots: readonly string[]): readonly string[] {
  const found: string[] = [];
  const pending: { readonly directory: string; readonly depth: number }[] = scanRoots.map((entry) => ({ directory: entry, depth: 0 }));
  let visited = 0;
  while (pending.length > 0) {
    visited += 1;
    if (visited > 200_000) {
      throw new Error('listScanFiles: more than 200000 directories; the roots are not what they should be');
    }
    const next = pending.pop();
    if (next === undefined) {
      break;
    }
    if (next.depth > DIRECTORY_DEPTH_MAX) {
      throw new Error(`listScanFiles: ${next.directory} is nested deeper than ${DIRECTORY_DEPTH_MAX}`);
    }
    let entries;
    try {
      entries = readdirSync(path.join(root, next.directory), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const relative = `${next.directory}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) {
          pending.push({ directory: relative, depth: next.depth + 1 });
        }
      } else if (entry.isFile() && SCAN_EXTENSIONS.has(path.extname(entry.name))) {
        found.push(relative);
      }
    }
  }
  return found.sort();
}

/** Every scroll container declared in one file's text. */
export function scanText(file: string, source: string): readonly ScrollContainer[] {
  const text = stripComments(source);
  const found = new Map<number, ScrollContainer>();
  const declaration = /(?<![\w-])overflow(?:-?([xy]))?\s*:\s*(?:'([^']*)'|"([^"]*)"|([^;,}'"\n]+))/gi;
  let match = declaration.exec(text);
  let guard = 0;
  while (match !== null) {
    guard += 1;
    if (guard > 100_000) {
      throw new Error(`scanText: ${file} has more than 100000 overflow declarations`);
    }
    const block = enclosingBlock(text, match.index);
    if (block !== undefined && !found.has(block.open)) {
      const container = readBlock(file, text, block);
      if (container !== undefined) {
        found.set(block.open, container);
      }
    }
    match = declaration.exec(text);
  }
  return [...found.values()];
}

/** Whether a TypeScript file assigns an overflow style from code (`element.style.overflowY = …`). */
export function scriptAssignsOverflow(source: string): boolean {
  return /\.style\.overflow(?:X|Y)?\s*=\s*[^=]/.test(stripComments(source));
}

export function declaresGutterInText(source: string): boolean {
  return /scrollbar-?gutter\s*[:=]\s*['"]?stable/i.test(stripComments(source));
}

interface Block {
  readonly open: number;
  readonly close: number;
}

function stripComments(source: string): string {
  // Keep the newlines so a line number still counts the original text.
  const withoutBlocks = source.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '));
  return withoutBlocks.replace(/^(\s*)\/\/(.*)$/gm, (_whole, indent: string, rest: string) => indent + ' '.repeat(rest.length + 2));
}

function enclosingBlock(text: string, index: number): Block | undefined {
  let depth = 0;
  let open = -1;
  const lowest = Math.max(0, index - BLOCK_SCAN_CHARACTERS_MAX);
  for (let at = index - 1; at >= lowest; at -= 1) {
    const character = text[at];
    if (character === '}') {
      depth += 1;
    } else if (character === '{') {
      if (depth === 0) {
        open = at;
        break;
      }
      depth -= 1;
    }
  }
  if (open < 0) {
    return undefined;
  }
  depth = 0;
  const highest = Math.min(text.length, index + BLOCK_SCAN_CHARACTERS_MAX);
  for (let at = open + 1; at < highest; at += 1) {
    const character = text[at];
    if (character === '{') {
      depth += 1;
    } else if (character === '}') {
      if (depth === 0) {
        return { open, close: at };
      }
      depth -= 1;
    }
  }
  return undefined;
}

// The block's own text: nested `{ }` bodies are removed so a nested rule's declarations never count for the outer one.
function ownText(body: string): string {
  let depth = 0;
  let own = '';
  for (const character of body) {
    if (character === '{') {
      depth += 1;
    } else if (character === '}') {
      depth -= 1;
    } else if (depth === 0) {
      own += character;
    }
  }
  return own;
}

function modeOf(raw: string): string {
  return raw
    .trim()
    .replace(/\s*!important$/i, '')
    .toLowerCase();
}

function readBlock(file: string, text: string, block: Block): ScrollContainer | undefined {
  const own = ownText(text.slice(block.open + 1, block.close));
  const modes: { x: string; y: string } = { x: 'visible', y: 'visible' };
  const declaration = /(?<![\w-])overflow(?:-?([xy]))?\s*:\s*(?:'([^']*)'|"([^"]*)"|([^;,}'"\n]+))/gi;
  let match = declaration.exec(own);
  while (match !== null) {
    const axis = match[1]?.toLowerCase();
    const parts = modeOf(match[2] ?? match[3] ?? match[4] ?? '')
      .split(/\s+/)
      .filter((part) => part.length > 0);
    const first = parts[0];
    const second = parts[1] ?? first;
    if (first !== undefined && second !== undefined) {
      if (axis === 'x') {
        modes.x = first;
      } else if (axis === 'y') {
        modes.y = first;
      } else {
        modes.x = first;
        modes.y = second;
      }
    }
    match = declaration.exec(own);
  }
  const axes: Axis[] = [];
  if (SCROLLING.has(modes.x)) {
    axes.push('x');
  }
  if (SCROLLING.has(modes.y)) {
    axes.push('y');
  }
  if (axes.length === 0) {
    return undefined;
  }
  const horizontalOnly = axes.length === 1 && axes[0] === 'x' && CLIPPING.has(modes.y);
  const lastDeclarationEnd = lastOverflowEnd(text, block);
  const firstDeclaration = own.search(/(?<![\w-])overflow/i);
  const line = text.slice(0, block.open + 1 + Math.max(0, firstDeclaration)).split('\n').length;
  const prelude = text
    .slice(Math.max(0, lastBoundary(text, block.open) + 1), block.open)
    .replace(/\s+/g, ' ')
    .trim();
  const isScript = /\.[cm]?tsx?$/.test(file);
  const locator = isScript ? scriptLocator(own) : prelude;
  const lineStart = text.lastIndexOf('\n', lastDeclarationEnd - 1) + 1;
  const indent = /^\s*/.exec(text.slice(lineStart, lastDeclarationEnd))?.[0] ?? '';
  return {
    file,
    line,
    locator,
    axes,
    gutterStable: /scrollbar-?gutter\s*:\s*['"]?stable/i.test(own),
    horizontalOnly,
    barHidden: /scrollbar-?width\s*:\s*['"]?none/i.test(own),
    insertAt: lastDeclarationEnd,
    indent,
  };
}

// The end of the line that holds the block's last overflow declaration.
function lastOverflowEnd(text: string, block: Block): number {
  const body = text.slice(block.open + 1, block.close);
  const declaration = /(?<![\w-])overflow(?:-?[xy])?\s*:/gi;
  let last = 0;
  let match = declaration.exec(body);
  while (match !== null) {
    last = match.index;
    match = declaration.exec(body);
  }
  const lineEnd = body.indexOf('\n', last);
  return block.open + 1 + (lineEnd < 0 ? body.length : lineEnd);
}

function lastBoundary(text: string, before: number): number {
  for (let at = before - 1; at >= 0; at -= 1) {
    const character = text[at];
    if (character === '}' || character === ';' || character === '{') {
      return at;
    }
  }
  return -1;
}

function scriptLocator(own: string): string {
  const match = /(?<![\w-])overflow(?:-?[xy])?\s*:\s*(?:'[^']*'|"[^"]*"|[^;,}\n]+)/i.exec(own);
  return match === null ? '' : match[0].replace(/\s+/g, ' ').trim();
}

/** Every scroll container under the roots. */
export function scanRepository(root: string, scanRoots: readonly string[]): readonly ScrollContainer[] {
  const containers: ScrollContainer[] = [];
  for (const file of listScanFiles(root, scanRoots)) {
    const source = readFileSync(path.join(root, file), 'utf8');
    if (source.length > FILE_BYTES_MAX) {
      throw new Error(`scanRepository: ${file} is larger than ${FILE_BYTES_MAX} bytes`);
    }
    if (/overflow/i.test(source)) {
      containers.push(...scanText(file, source));
    }
  }
  return containers;
}
