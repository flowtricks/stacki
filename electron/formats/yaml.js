// Editing YAML without disturbing what is around the edit.
//
// YAML carries things a value alone cannot: comments, anchors, block scalars
// (`answer: |`), the difference between a plain and a quoted string, and the
// choice of flow or block style. Reading it into plain data and dumping it back
// out throws all of that away, which is why this goes through the `yaml`
// package's document model — the same node tree the file parses into, edited in
// place and re-emitted.
//
// Two rules do most of the work:
//   - a scalar that keeps its type is written into the existing node, so a
//     block scalar stays a block scalar and a quoted string stays quoted;
//   - anything else is set through the document, which quotes defensively.
//     This is the bug that bit the fixture project: an answer containing the
//     text `draft: true` has to come back out quoted, or the file no longer
//     parses.

const YAML = require('yaml');
const { transplant } = require('./transplant');

const PARSE_OPTIONS = { keepSourceTokens: true };
// Long strings are not re-wrapped and flow lists keep their spacing, which is
// what most files already look like.
const STRINGIFY_OPTIONS = { lineWidth: 0, flowCollectionPadding: false };

const parseData = (text) => YAML.parse(text) ?? null;

const parseDocument = (text) => YAML.parseDocument(text, PARSE_OPTIONS);

const isPrimitive = (v) => v === null || ['string', 'number', 'boolean'].includes(typeof v);

const DELETE = Symbol('delete');

/**
 * Applies { path, value } edits to YAML source text. `DELETE` removes the key.
 */
function applyEdits(text, edits) {
  if (!edits.length) return text;
  const doc = parseDocument(text);
  // What the serializer makes of this file before anything is changed. When it
  // differs from the file on disk — a folded scalar it writes flat, a quote it
  // normalises — that difference is subtracted back out below rather than
  // landing in the user's diff.
  const before = doc.toString(STRINGIFY_OPTIONS);
  for (const { path, value, rename } of edits) {
    // A key renamed where it stands: the pair keeps its comments, its style and
    // its place among the others.
    if (rename !== undefined) {
      const parent = path.length > 1 ? doc.getIn(path.slice(0, -1), true) : doc.contents;
      const pair = parent?.items?.find((item) => item?.key?.value === path[path.length - 1]);
      if (pair?.key) pair.key.value = rename;
      continue;
    }
    if (!path.length) {
      if (value === DELETE) continue;
      const next = parseDocument(YAML.stringify(value, STRINGIFY_OPTIONS));
      doc.contents = next.contents;
      continue;
    }
    if (value === DELETE) {
      doc.deleteIn(path);
      continue;
    }
    const node = doc.getIn(path, true);
    // Writing into the node that is already there keeps its style — the block
    // scalar, the quoting, the comment sitting beside it.
    if (node && node.value !== undefined && isPrimitive(value) && typeof node.value === typeof value) {
      node.value = value;
      continue;
    }
    doc.setIn(path, value);
  }
  const after = doc.toString(STRINGIFY_OPTIONS);
  return before === text ? after : transplant(text, before, after);
}

/**
 * True when this text survives a parse and re-emit unchanged. Everything the
 * editor writes goes through the document model, so a file that does not round
 * trip cleanly would pick up unrelated changes on its first save — better to
 * know that before writing than to explain the diff afterwards.
 */
function roundTrips(text) {
  try {
    return parseDocument(text).toString(STRINGIFY_OPTIONS) === text;
  } catch {
    return false;
  }
}

module.exports = { parseData, parseDocument, applyEdits, roundTrips, DELETE, YAML };
