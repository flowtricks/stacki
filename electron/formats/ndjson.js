// One JSON object per line. The format's whole point is that a line is a
// record, so a record is rewritten by rewriting its line — and every other line
// comes out byte-identical, which is what keeps a five-record file's diff to
// the one record that changed.
//
// Never pretty-printed: a record spread over several lines is several broken
// records.

const parseLines = (text) =>
  text.split('\n').map((line, index) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//')) return { index, line, record: null };
    try {
      return { index, line, record: JSON.parse(trimmed) };
    } catch {
      return { index, line, record: null, error: true };
    }
  });

const parseData = (text) => parseLines(text).filter((l) => l.record).map((l) => l.record);

const DELETE = Symbol('delete');

const setIn = (target, path, value) => {
  if (!path.length) return value;
  const [key, ...rest] = path;
  const isIndex = typeof key === 'number';
  const next = target == null ? (isIndex ? [] : {}) : target;
  if (rest.length === 0) {
    if (value === DELETE) {
      if (Array.isArray(next)) next.splice(key, 1);
      else delete next[key];
      return next;
    }
    next[key] = value;
    return next;
  }
  next[key] = setIn(next[key], rest, value);
  return next;
};

/**
 * Edits are { path: [recordIndex, ...rest], value }, indexed over the records
 * the file holds rather than its lines — blank lines and comments are neither.
 */
function applyEdits(text, edits) {
  if (!edits.length) return text;
  const lines = parseLines(text);
  const records = lines.filter((l) => l.record);
  const touched = new Set();

  for (const { path, value } of edits) {
    const entry = records[path[0]];
    if (!entry) continue;
    if (path.length === 1 && value === DELETE) {
      entry.removed = true;
      touched.add(entry.index);
      continue;
    }
    setIn(entry.record, path.slice(1), value);
    touched.add(entry.index);
  }

  return lines
    .filter((l) => !l.removed)
    .map((l) => (touched.has(l.index) ? JSON.stringify(l.record) : l.line))
    .join('\n');
}

module.exports = { parseData, applyEdits, DELETE };
