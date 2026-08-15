// Moving one edit out of a re-serialized file and onto the original.
//
// Some formats can only be written by handing the whole document back to a
// serializer, and a serializer has opinions: it may unfold a wrapped scalar,
// re-pad a flow list, or normalise a quote the author chose. Those differences
// are harmless to the data and terrible in a diff, because they bury the one
// line that actually changed.
//
// The way out is to serialize twice — once from the untouched document, once
// from the edited one — and compare those two, not the original. Both came out
// of the same serializer, so its opinions cancel out and what is left is the
// edit. That is then placed back into the original text, which is otherwise
// untouched, byte for byte.

// Longest common subsequence over lines, as a map from index in `a` to index in
// `b` for the lines they share.
function align(a, b) {
  const n = a.length;
  const m = b.length;
  // Small files; the quadratic table is a few hundred kilobytes at worst.
  const table = new Int32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * (m + 1) + j] =
        a[i] === b[j]
          ? table[(i + 1) * (m + 1) + j + 1] + 1
          : Math.max(table[(i + 1) * (m + 1) + j], table[i * (m + 1) + j + 1]);
    }
  }
  const map = new Map();
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      map.set(i, j);
      i++;
      j++;
    } else if (table[(i + 1) * (m + 1) + j] >= table[i * (m + 1) + j + 1]) i++;
    else j++;
  }
  return map;
}

// The runs of lines that differ, as { start, end, lines } against `a`.
function hunks(a, b) {
  const map = align(a, b);
  const out = [];
  let open = null;
  let prevB = -1;
  for (let i = 0; i <= a.length; i++) {
    const j = i < a.length ? map.get(i) : b.length;
    if (j === undefined) {
      if (!open) open = { start: i, from: prevB + 1 };
      continue;
    }
    if (open || j > prevB + 1) {
      const start = open ? open.start : i;
      const from = open ? open.from : prevB + 1;
      out.push({ start, end: i, lines: b.slice(from, j) });
      open = null;
    }
    prevB = j;
  }
  return out;
}

/**
 * `original` with the difference between `before` and `after` applied to it.
 * `before` must be what the serializer produces from the unedited document and
 * `after` what it produces from the edited one. Falls back to `after` when the
 * edit cannot be placed, which is the same file the serializer would have
 * written anyway.
 */
function transplant(original, before, after) {
  if (before === after) return original;
  const O = original.split('\n');
  const A = before.split('\n');
  const B = after.split('\n');
  const toOriginal = align(A, O);
  const changes = hunks(A, B);
  if (!changes.length) return original;

  const out = O.slice();
  for (const hunk of changes.reverse()) {
    // The usual case: the lines being replaced are lines the serializer wrote
    // the same way the original has them, so they can be found in the original
    // and swapped on their own.
    const mapped = [];
    for (let i = hunk.start; i < hunk.end; i++) mapped.push(toOriginal.get(i));
    if (mapped.length && mapped.every((at) => at !== undefined)) {
      out.splice(mapped[0], mapped[mapped.length - 1] - mapped[0] + 1, ...hunk.lines);
      continue;
    }

    // Otherwise a line the serializer wrote differently from the original — a
    // folded scalar it unfolded, say — sits in the way and has no counterpart
    // to anchor against. It is taken along: the region it belongs to can only
    // be replaced whole, so the diff grows by those lines and stops there.
    let start = hunk.start;
    while (start > 0 && !toOriginal.has(start - 1)) start--;
    let end = hunk.end;
    while (end < A.length && !toOriginal.has(end)) end++;

    const from = start === 0 ? 0 : toOriginal.get(start - 1) + 1;
    const to = end === A.length ? O.length : toOriginal.get(end);
    if (to < from) return after;

    const lines = [...A.slice(start, hunk.start), ...hunk.lines, ...A.slice(hunk.end, end)];
    out.splice(from, to - from, ...lines);
  }
  return out.join('\n');
}

module.exports = { transplant };
