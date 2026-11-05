// Markdown, MDX and Markdoc entries: YAML frontmatter over a body.
//
// The body is never touched. MDX bodies hold imports, JSX and the odd
// `export const`; Markdoc bodies hold {% tags %}; markdown bodies hold whatever
// the author typed. None of it survives a reformat, none of it is the editor's
// business, and all of it is preserved by only ever replacing the frontmatter
// span — or, when the body itself is edited, only the body span.

import * as yaml from './yaml';

const FRONTMATTER = /^(---)([ \t]*\r?\n)([\s\S]*?)(\r?\n)(---)([ \t]*)(\r?\n?)/;
// An empty block, `---` straight over `---`: what a new entry starts as. The
// pattern above wants a line break before its closing fence, and the only one
// here belongs to the opening line, so it did not match: the empty block read
// as body, and the first field written grew a second frontmatter above it,
// leaving `---\n---` in the entry's body for good.
const EMPTY_FRONTMATTER = /^(---)([ \t]*\r?\n)(---)([ \t]*)(\r?\n?)/;

/** Where a file's frontmatter is: its fences, the YAML between them, and its length. */
interface FrontmatterSpan {
  readonly opening: string; // `---` and its line break
  readonly block: string; // the YAML, without the line break before the closing fence
  readonly separator: string; // that line break; empty when the block is
  readonly closing: string; // the closing fence, its trailing spaces and line break
  readonly length: number;
}

function frontmatterSpan(text: string): FrontmatterSpan | undefined {
  const full = text.match(FRONTMATTER);
  if (full !== null) {
    const [whole, open = '', openBreak = '', block = '', separator = '', close = '', closeSpace = '', closeBreak = ''] = full;
    return { opening: open + openBreak, block, separator, closing: close + closeSpace + closeBreak, length: whole.length };
  }
  const empty = text.match(EMPTY_FRONTMATTER);
  if (empty !== null) {
    const [whole, open = '', openBreak = '', close = '', closeSpace = '', closeBreak = ''] = empty;
    return { opening: open + openBreak, block: '', separator: '', closing: close + closeSpace + closeBreak, length: whole.length };
  }
  return undefined;
}

export interface ParsedFrontmatter {
  readonly data: unknown; // undefined when the file has no frontmatter
  readonly frontmatter: string | undefined;
  readonly body: string;
  readonly offset: number;
}

/** { data, body, frontmatter } — data is undefined when the file has no frontmatter. */
function parse(text: string): ParsedFrontmatter {
  const span = frontmatterSpan(text);
  if (span === undefined) {
    return { data: undefined, frontmatter: undefined, body: text, offset: 0 };
  }
  return {
    data: span.block === '' ? {} : (yaml.parseData(span.block + '\n') ?? {}),
    frontmatter: span.block,
    body: text.slice(span.length),
    offset: span.length,
  };
}

const parseData = (text: string): unknown => parse(text).data;

/**
 * Applies edits to the frontmatter, and replaces the body when `body` is given.
 * A file with no frontmatter grows one; a file whose body is not passed keeps
 * the bytes it had.
 */
function applyEdits(text: string, edits: readonly yaml.Edit[], { body }: { readonly body?: string | undefined } = {}): string {
  const span = frontmatterSpan(text);
  if (span === undefined) {
    if (!edits.length) {
      return body === undefined ? text : body;
    }
    const written = yaml.applyEdits('', edits).replace(/\n?$/, '\n');
    return `---\n${written}---\n${body === undefined ? text : body}`;
  }
  // An empty block is written from empty YAML, as a file with none is: a lone
  // line break to start from would come back as a blank line in the block.
  const source = span.block === '' ? '' : span.block + '\n';
  const written = edits.length ? yaml.applyEdits(source, edits).replace(/\n$/, '') : span.block;
  // A block that was empty gets the line break its fences lacked, in the
  // file's own style (the opening line's).
  const lineBreak = span.opening.endsWith('\r\n') ? '\r\n' : '\n';
  const separator = written === '' ? '' : span.separator === '' ? lineBreak : span.separator;
  const head = `${span.opening}${written}${separator}${span.closing}`;
  return head + (body === undefined ? text.slice(span.length) : body);
}

export { parse, parseData, applyEdits };
export const DELETE = yaml.DELETE;
