// Markdown, MDX and Markdoc entries: YAML frontmatter over a body.
//
// The body is never touched. MDX bodies hold imports, JSX and the odd
// `export const`; Markdoc bodies hold {% tags %}; markdown bodies hold whatever
// the author typed. None of it survives a reformat, none of it is the editor's
// business, and all of it is preserved by only ever replacing the frontmatter
// span — or, when the body itself is edited, only the body span.

const yaml = require('./yaml');

const FRONTMATTER = /^(---)([ \t]*\r?\n)([\s\S]*?)(\r?\n)(---)([ \t]*)(\r?\n?)/;

/** { data, body, frontmatter } — data is null when the file has no frontmatter. */
function parse(text) {
  const m = text.match(FRONTMATTER);
  if (!m) return { data: null, frontmatter: null, body: text, offset: 0 };
  const frontmatter = m[3];
  return {
    data: yaml.parseData(frontmatter + '\n') ?? {},
    frontmatter,
    body: text.slice(m[0].length),
    offset: m[0].length,
  };
}

const parseData = (text) => parse(text).data;

/**
 * Applies edits to the frontmatter, and replaces the body when `body` is given.
 * A file with no frontmatter grows one; a file whose body is not passed keeps
 * the bytes it had.
 */
function applyEdits(text, edits, { body } = {}) {
  const m = text.match(FRONTMATTER);
  if (!m) {
    if (!edits.length) return body === undefined ? text : body;
    const block = yaml.applyEdits('', edits).replace(/\n?$/, '\n');
    return `---\n${block}---\n${body === undefined ? text : body}`;
  }
  const written = edits.length
    ? yaml.applyEdits(m[3] + '\n', edits).replace(/\n$/, '')
    : m[3];
  const head = `${m[1]}${m[2]}${written}${m[4]}${m[5]}${m[6]}${m[7]}`;
  return head + (body === undefined ? text.slice(m[0].length) : body);
}

module.exports = { parse, parseData, applyEdits, DELETE: yaml.DELETE };
