// Editing JSON without reformatting it.
//
// The obvious way — parse, change, JSON.stringify — rewrites the whole file:
// every line becomes a candidate for the diff, arrays that were written on one
// line get exploded, and a key nobody touched moves. In a repo that is
// Prettier-formatted and reviewed by humans, that turns a one-word content edit
// into a forty-line diff and hides what actually changed.
//
// So the file is parsed into spans instead, and only the span of the value that
// changed is replaced. Everything else — key order, indentation, blank lines,
// the `$schema` key Astro ignores but the editor must keep — is untouched
// because it is never rewritten.

const WS = /\s/;

// Where every value in the document starts and ends.
//   object → { type, start, end, members: [{ key, keyStart, keyEnd, start, end, value }] }
//   array  → { type, start, end, items: [node] }
//   other  → { type: 'scalar', start, end }
function parse(text) {
  let i = 0;

  const fail = (message) => {
    const line = text.slice(0, i).split('\n').length;
    throw new Error(`${message} (line ${line})`);
  };

  const skip = () => {
    while (i < text.length && WS.test(text[i])) i++;
  };

  const string = () => {
    const start = i;
    i++; // opening quote
    while (i < text.length) {
      if (text[i] === '\\') i += 2;
      else if (text[i] === '"') {
        i++;
        return { start, end: i };
      } else i++;
    }
    return fail('Unterminated string');
  };

  const value = () => {
    skip();
    const start = i;
    const ch = text[i];
    if (ch === '{') {
      i++;
      const members = [];
      skip();
      if (text[i] === '}') return { type: 'object', start, end: ++i, members };
      for (;;) {
        skip();
        if (text[i] !== '"') return fail('Expected a key');
        const keySpan = string();
        const key = JSON.parse(text.slice(keySpan.start, keySpan.end));
        skip();
        if (text[i] !== ':') return fail('Expected ":"');
        i++;
        const v = value();
        members.push({ key, keyStart: keySpan.start, keyEnd: keySpan.end, start: keySpan.start, end: v.end, value: v });
        skip();
        if (text[i] === ',') {
          i++;
          continue;
        }
        if (text[i] === '}') return { type: 'object', start, end: ++i, members };
        return fail('Expected "," or "}"');
      }
    }
    if (ch === '[') {
      i++;
      const items = [];
      skip();
      if (text[i] === ']') return { type: 'array', start, end: ++i, items };
      for (;;) {
        items.push(value());
        skip();
        if (text[i] === ',') {
          i++;
          continue;
        }
        if (text[i] === ']') return { type: 'array', start, end: ++i, items };
        return fail('Expected "," or "]"');
      }
    }
    if (ch === '"') {
      const s = string();
      return { type: 'scalar', start: s.start, end: s.end };
    }
    while (i < text.length && !WS.test(text[i]) && !',}]'.includes(text[i])) i++;
    if (i === start) return fail('Expected a value');
    return { type: 'scalar', start, end: i };
  };

  const root = value();
  skip();
  return root;
}

const parseData = (text) => JSON.parse(text);

// The indentation of the line a position sits on, so an inserted or replaced
// value lines up with what is around it.
function indentAt(text, pos) {
  const lineStart = text.lastIndexOf('\n', pos - 1) + 1;
  const m = text.slice(lineStart, pos).match(/^[ \t]*/);
  return m ? m[0] : '';
}

// One indent level, as the file writes it.
function indentUnit(text) {
  const m = text.match(/\n([ \t]+)\S/);
  if (!m) return '  ';
  return m[1][0] === '\t' ? '\t' : m[1];
}

// A value, printed the way the surrounding file would have printed it.
function print(value, baseIndent, unit) {
  const body = JSON.stringify(value, null, unit);
  if (body === undefined) return 'null';
  return body.split('\n').join(`\n${baseIndent}`);
}

function childAt(node, key) {
  if (!node) return null;
  if (node.type === 'object') return node.members.find((m) => m.key === String(key)) || null;
  if (node.type === 'array') {
    const item = node.items[Number(key)];
    return item ? { key: Number(key), start: item.start, end: item.end, value: item } : null;
  }
  return null;
}

// The member a path names, plus the container it lives in — which is what an
// insert needs when the member is not there yet.
function locate(root, path) {
  let node = root;
  for (let d = 0; d < path.length; d++) {
    const member = childAt(node, path[d]);
    if (!member) return d === path.length - 1 ? { parent: node, key: path[d], member: null } : null;
    if (d === path.length - 1) return { parent: node, key: path[d], member };
    node = member.value;
  }
  return { parent: null, key: null, member: node ? { start: node.start, end: node.end, value: node } : null };
}

// Where a new member goes, and what has to be written around it: after the last
// one (with a comma), or on its own line inside an empty container.
function insertion(text, container, unit) {
  const closing = container.end - 1;
  const parts = container.type === 'object' ? container.members : container.items;
  const openIndent = indentAt(text, container.start);
  const inner = openIndent + unit;
  if (!parts.length) {
    // `{}` or `[]` — open it up rather than writing on one line, which is what
    // the rest of the file looks like.
    return { at: container.start + 1, before: `\n${inner}`, after: `\n${openIndent}`, inner };
  }
  const last = parts[parts.length - 1];
  const lastIndent = indentAt(text, last.start);
  return { at: last.end, before: `,\n${lastIndent}`, after: '', inner: lastIndent };
}

const DELETE = Symbol('delete');

/**
 * Applies edits to JSON source text, changing only the spans that changed.
 * Each edit is { path: [key | index, ...], value } — `DELETE` as the value
 * removes the member. Paths that name something inside a value that does not
 * exist yet create the intermediate objects.
 */
function applyEdits(text, edits) {
  const unit = indentUnit(text);
  let out = text;

  for (const edit of edits) {
    const root = parse(out);
    const path = edit.path;

    // Renaming a key is not the same as removing one and adding another: the
    // record keeps its place in the file, and its value is never rewritten.
    if (edit.rename !== undefined) {
      const found = locate(root, path);
      if (found?.member?.keyEnd != null) {
        out = out.slice(0, found.member.keyStart) + JSON.stringify(String(edit.rename)) + out.slice(found.member.keyEnd);
      }
      continue;
    }
    if (!path.length) {
      out = print(edit.value, '', unit) + (out.endsWith('\n') ? '\n' : '');
      continue;
    }

    // Walk as far as the document goes; anything missing below that is written
    // as one nested value rather than a series of empty containers.
    let node = root;
    let depth = 0;
    while (depth < path.length - 1) {
      const member = childAt(node, path[depth]);
      if (!member) break;
      node = member.value;
      depth++;
    }

    const remaining = path.slice(depth);
    const target = childAt(node, remaining[0]);

    if (edit.value === DELETE) {
      if (remaining.length > 1 || !target) continue; // nothing to remove
      out = removeMember(out, node, target);
      continue;
    }

    // Everything below the deepest existing container, wrapped up.
    let value = edit.value;
    for (let d = path.length - 1; d > depth; d--) {
      value = typeof path[d] === 'number' ? [value] : { [path[d]]: value };
    }

    if (remaining.length === 1 && target) {
      const baseIndent = indentAt(out, target.value.start);
      out = out.slice(0, target.value.start) + print(value, baseIndent, unit) + out.slice(target.value.end);
      continue;
    }

    const spot = insertion(out, node, unit);
    const written =
      node.type === 'object'
        ? `${JSON.stringify(String(remaining[0]))}: ${print(value, spot.inner, unit)}`
        : print(value, spot.inner, unit);
    out = out.slice(0, spot.at) + spot.before + written + spot.after + out.slice(spot.at);
  }

  return out;
}

// Removing a member takes its separator with it — the comma before it when it
// is last, the one after it otherwise — so the file stays valid JSON and the
// diff stays limited to those lines.
function removeMember(text, container, member) {
  const parts = container.type === 'object' ? container.members : container.items;
  const index = parts.findIndex((p) => p.start === member.start);
  const only = parts.length === 1;
  let from = member.start;
  let to = member.end;

  if (only) {
    // Leave the container empty, on one line.
    from = container.start + 1;
    to = container.end - 1;
    return text.slice(0, from) + text.slice(to);
  }
  if (index === parts.length - 1) {
    from = parts[index - 1].end; // the comma and newline before it go too
  } else {
    to = parts[index + 1].start; // as does the comma, newline and indent after
  }
  return text.slice(0, from) + text.slice(to);
}

module.exports = { parse, parseData, applyEdits, indentUnit, DELETE };
