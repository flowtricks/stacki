// CSV, where every value is a string and the column order is the file.
//
// Only the row that changed is rewritten, and within it only the cells that
// changed: a cell nobody edited keeps the exact text it had, quotes included.
// That matters more here than in other formats, because a quoted cell and a
// bare one holding the same characters are the same value — so re-quoting the
// whole file on save would be a diff of pure noise.

// A row of cells, keeping each cell's source text alongside its value.
function splitRow(line) {
  const cells = [];
  let i = 0;
  while (i <= line.length) {
    if (line[i] === '"') {
      const start = i;
      i++;
      let value = '';
      while (i < line.length) {
        if (line[i] === '"' && line[i + 1] === '"') {
          value += '"';
          i += 2;
        } else if (line[i] === '"') {
          i++;
          break;
        } else value += line[i++];
      }
      cells.push({ value, text: line.slice(start, i) });
    } else {
      const start = i;
      while (i < line.length && line[i] !== ',') i++;
      cells.push({ value: line.slice(start, i), text: line.slice(start, i) });
    }
    if (i >= line.length) break;
    if (line[i] === ',') i++;
    if (i === line.length) cells.push({ value: '', text: '' }); // trailing comma
  }
  return cells;
}

const quote = (value) => {
  const s = String(value ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// Comment lines and blank lines are content too — they are kept where they are.
const isSkippable = (line) => !line.trim() || line.trimStart().startsWith('#');

function parseLines(text) {
  const lines = text.split('\n');
  let header = null;
  const rows = [];
  lines.forEach((line, index) => {
    if (isSkippable(line)) return;
    if (!header) {
      header = splitRow(line).map((c) => c.value.trim());
      return;
    }
    rows.push({ index, line, cells: splitRow(line) });
  });
  return { lines, header: header || [], rows };
}

function parseData(text) {
  const { header, rows } = parseLines(text);
  return rows.map((row) =>
    Object.fromEntries(header.map((name, i) => [name, row.cells[i] ? row.cells[i].value : '']))
  );
}

const DELETE = Symbol('delete');

/**
 * Edits are { path: [rowIndex, column], value }. A column the file does not
 * have cannot be written — CSV has no room for one without rewriting every
 * row's header, which is a schema change, not a content edit.
 */
function applyEdits(text, edits) {
  if (!edits.length) return text;
  const { lines, header, rows } = parseLines(text);
  const touched = new Set();
  const removed = new Set();

  for (const { path, value } of edits) {
    const row = rows[path[0]];
    if (!row) continue;
    if (path.length === 1 && value === DELETE) {
      removed.add(row.index);
      continue;
    }
    const column = header.indexOf(String(path[1]));
    if (column === -1) continue;
    while (row.cells.length < header.length) row.cells.push({ value: '', text: '' });
    const next = value === DELETE ? '' : String(value ?? '');
    row.cells[column] = { value: next, text: quote(next) };
    touched.add(row.index);
  }

  for (const row of rows) {
    if (!touched.has(row.index)) continue;
    lines[row.index] = row.cells.map((c) => c.text).join(',');
  }
  return lines.filter((_, index) => !removed.has(index)).join('\n');
}

module.exports = { parseData, applyEdits, DELETE };
