// Markdown, MDX and Markdoc entries: YAML frontmatter over a body.
//
// The body is never touched. MDX bodies hold imports, JSX and the odd
// `export const`; Markdoc bodies hold {% tags %}; markdown bodies hold whatever
// the author typed. None of it survives a reformat, none of it is the editor's
// business, and all of it is preserved by only ever replacing the frontmatter
// span — or, when the body itself is edited, only the body span.

import * as yaml from './yaml';

const FRONTMATTER = /^(---)([ \t]*\r?\n)([\s\S]*?)(\r?\n)(---)([ \t]*)(\r?\n?)/;

export interface ParsedFrontmatter {
  readonly data: unknown; // undefined when the file has no frontmatter
  readonly frontmatter: string | undefined;
  readonly body: string;
  readonly offset: number;
}

/** { data, body, frontmatter } — data is undefined when the file has no frontmatter. */
function parse(text: string): ParsedFrontmatter {
  const match = text.match(FRONTMATTER);
  const block = match?.[3];
  if (!match || block === undefined) {
    return { data: undefined, frontmatter: undefined, body: text, offset: 0 };
  }
  return {
    data: yaml.parseData(block + '\n') ?? {},
    frontmatter: block,
    body: text.slice(match[0].length),
    offset: match[0].length,
  };
}

const parseData = (text: string): unknown => parse(text).data;

/**
 * Applies edits to the frontmatter, and replaces the body when `body` is given.
 * A file with no frontmatter grows one; a file whose body is not passed keeps
 * the bytes it had.
 */
function applyEdits(text: string, edits: readonly yaml.Edit[], { body }: { readonly body?: string | undefined } = {}): string {
  const match = text.match(FRONTMATTER);
  const block = match?.[3];
  if (!match || block === undefined) {
    if (!edits.length) {
      return body === undefined ? text : body;
    }
    const written = yaml.applyEdits('', edits).replace(/\n?$/, '\n');
    return `---\n${written}---\n${body === undefined ? text : body}`;
  }
  const written = edits.length ? yaml.applyEdits(block + '\n', edits).replace(/\n$/, '') : block;
  const head = `${match[1]}${match[2]}${written}${match[4]}${match[5]}${match[6]}${match[7]}`;
  return head + (body === undefined ? text.slice(match[0].length) : body);
}

export { parse, parseData, applyEdits };
export const DELETE = yaml.DELETE;
