// CSV, where every value is a string and the column order is the file.
//
// Only the row that changed is rewritten, and within it only the cells that
// changed: a cell nobody edited keeps the exact text it had, quotes included.
// That matters more here than in other formats, because a quoted cell and a
// bare one holding the same characters are the same value — so re-quoting the
// whole file on save would be a diff of pure noise.

interface Cell {
  readonly value: string;
  readonly text: string;
}

// A row of cells, keeping each cell's source text alongside its value.
function splitRow(line: string): Cell[] {
  const cells: Cell[] = [];
  let i = 0;
  while (i <= line.length) {
    if (line.charAt(i) === '"') {
      const start = i;
      i++;
      let value = '';
      while (i < line.length) {
        if (line.charAt(i) === '"' && line.charAt(i + 1) === '"') {
          value += '"';
          i += 2;
        } else if (line.charAt(i) === '"') {
          i++;
          break;
        } else {
          value += line.charAt(i++);
        }
      }
      cells.push({ value, text: line.slice(start, i) });
    } else {
      const start = i;
      while (i < line.length && line.charAt(i) !== ',') {
        i++;
      }
      cells.push({ value: line.slice(start, i), text: line.slice(start, i) });
    }
    if (i >= line.length) {
      break;
    }
    if (line.charAt(i) === ',') {
      i++;
    }
    if (i === line.length) {
      cells.push({ value: '', text: '' }); // trailing comma
    }
  }
  return cells;
}

const quote = (value: unknown): string => {
  const text = String(value ?? '');
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

// Comment lines and blank lines are content too — they are kept where they are.
const isSkippable = (line: string): boolean => !line.trim() || line.trimStart().startsWith('#');

interface Row {
  readonly index: number;
  readonly line: string;
  cells: Cell[];
}

interface ParsedCsv {
  readonly lines: string[]; // rewritten in place by applyEdits
  readonly header: readonly string[];
  readonly rows: Row[];
}

function parseLines(text: string): ParsedCsv {
  const lines = text.split('\n');
  let header: string[] | undefined = undefined;
  const rows: Row[] = [];
  lines.forEach((line, index) => {
    if (isSkippable(line)) {
      return;
    }
    if (!header) {
      header = splitRow(line).map((cell) => cell.value.trim());
      return;
    }
    rows.push({ index, line, cells: splitRow(line) });
  });
  return { lines, header: header ?? [], rows };
}

function parseData(text: string): Record<string, string>[] {
  const { header, rows } = parseLines(text);
  return rows.map((row) => Object.fromEntries(header.map((name, i) => [name, row.cells[i] ? row.cells[i].value : ''])));
}

const DELETE = Symbol('delete');

export interface Edit {
  readonly path: readonly (string | number)[];
  readonly value?: unknown;
}

/**
 * Edits are { path: [rowIndex, column], value }. A column the file does not
 * have cannot be written — CSV has no room for one without rewriting every
 * row's header, which is a schema change, not a content edit.
 */
function applyEdits(text: string, edits: readonly Edit[]): string {
  if (!edits.length) {
    return text;
  }
  const { lines, header, rows } = parseLines(text);
  const touched = new Set<number>();
  const removed = new Set<number>();

  for (const { path, value } of edits) {
    const head = path[0];
    if (typeof head !== 'number') {
      continue;
    }
    const row = rows[head];
    if (!row) {
      continue;
    }
    if (path.length === 1 && value === DELETE) {
      removed.add(row.index);
      continue;
    }
    const column = header.indexOf(String(path[1]));
    if (column === -1) {
      continue;
    }
    while (row.cells.length < header.length) {
      row.cells.push({ value: '', text: '' });
    }
    const next = value === DELETE ? '' : String(value ?? '');
    row.cells[column] = { value: next, text: quote(next) };
    touched.add(row.index);
  }

  for (const row of rows) {
    if (!touched.has(row.index)) {
      continue;
    }
    lines[row.index] = row.cells.map((cell) => cell.text).join(',');
  }
  return lines.filter((_, index) => !removed.has(index)).join('\n');
}

export { parseData, applyEdits, DELETE };
