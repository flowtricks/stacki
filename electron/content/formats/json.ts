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

import { assert } from '../../../shared/core/assert';
import { LIMITS } from '../../../shared/core/limits';

const WS = /\s/;

export interface ScalarNode {
  readonly type: 'scalar';
  readonly start: number;
  readonly end: number;
}

export interface Member {
  readonly key: string;
  readonly keyStart: number;
  readonly keyEnd: number;
  readonly start: number;
  readonly end: number;
  readonly value: JsonNode;
}

export interface ObjectNode {
  readonly type: 'object';
  readonly start: number;
  readonly end: number;
  readonly members: Member[];
}

export interface ArrayNode {
  readonly type: 'array';
  readonly start: number;
  readonly end: number;
  readonly items: JsonNode[];
}

export type JsonNode = ScalarNode | ObjectNode | ArrayNode;

// Where every value in the document starts and ends.
function parse(text: string): JsonNode {
  const parser = new SpanParser(text);
  const root = parser.value(0);
  parser.skip();
  return root;
}

// A JSON document read into spans, one value at a time. The cursor is the parser's only state,
// and only these methods move it.
class SpanParser {
  readonly #text: string;
  #position = 0;

  constructor(text: string) {
    this.#text = text;
  }

  fail(message: string): never {
    const line = this.#text.slice(0, this.#position).split('\n').length;
    throw new Error(`${message} (line ${line})`);
  }

  skip(): void {
    while (this.#position < this.#text.length && WS.test(this.#text.charAt(this.#position))) {
      this.#position++;
    }
  }

  value(depth: number): JsonNode {
    // A project's file may nest without end. Past the depth any value crossing a boundary may
    // have, the document is refused like any other malformed one.
    if (depth > LIMITS.ipcDepthMax) {
      return this.fail('Nested too deeply');
    }
    this.skip();
    const start = this.#position;
    const first = this.#text.charAt(start);
    if (first === '{') {
      return this.object(start, depth);
    }
    if (first === '[') {
      return this.array(start, depth);
    }
    if (first === '"') {
      const span = this.string();
      return { type: 'scalar', start: span.start, end: span.end };
    }
    const text = this.#text;
    while (this.#position < text.length && !WS.test(text.charAt(this.#position)) && !',}]'.includes(text.charAt(this.#position))) {
      this.#position++;
    }
    if (this.#position === start) {
      return this.fail('Expected a value');
    }
    return { type: 'scalar', start, end: this.#position };
  }

  private string(): { start: number; end: number } {
    const text = this.#text;
    const start = this.#position;
    this.#position++; // opening quote
    while (this.#position < text.length) {
      if (text.charAt(this.#position) === '\\') {
        this.#position += 2;
      } else if (text.charAt(this.#position) === '"') {
        this.#position++;
        return { start, end: this.#position };
      } else {
        this.#position++;
      }
    }
    return this.fail('Unterminated string');
  }

  private object(start: number, depth: number): ObjectNode {
    const text = this.#text;
    assert(text.charAt(start) === '{', 'An object starts at its brace');
    this.#position = start + 1;
    const members: Member[] = [];
    this.skip();
    if (text.charAt(this.#position) === '}') {
      this.#position++;
      return { type: 'object', start, end: this.#position, members };
    }
    // Every pass consumes a key and its value, so the text length bounds it.
    for (let pass = 0; pass <= text.length; pass++) {
      this.skip();
      if (text.charAt(this.#position) !== '"') {
        return this.fail('Expected a key');
      }
      const keySpan = this.string();
      // The span is a quoted string, so this parses to one; the guard is
      // unreachable but keeps the boundary honest.
      const parsedKey: unknown = JSON.parse(text.slice(keySpan.start, keySpan.end));
      if (typeof parsedKey !== 'string') {
        return this.fail('Expected a key');
      }
      this.skip();
      if (text.charAt(this.#position) !== ':') {
        return this.fail('Expected ":"');
      }
      this.#position++;
      const child = this.value(depth + 1);
      members.push({
        key: parsedKey,
        keyStart: keySpan.start,
        keyEnd: keySpan.end,
        start: keySpan.start,
        end: child.end,
        value: child,
      });
      this.skip();
      if (text.charAt(this.#position) === ',') {
        this.#position++;
        continue;
      }
      if (text.charAt(this.#position) === '}') {
        this.#position++;
        return { type: 'object', start, end: this.#position, members };
      }
      return this.fail('Expected "," or "}"');
    }
    assert(false, 'An object ends within its text');
  }

  private array(start: number, depth: number): ArrayNode {
    const text = this.#text;
    assert(text.charAt(start) === '[', 'An array starts at its bracket');
    this.#position = start + 1;
    const items: JsonNode[] = [];
    this.skip();
    if (text.charAt(this.#position) === ']') {
      this.#position++;
      return { type: 'array', start, end: this.#position, items };
    }
    // Every pass consumes a value, so the text length bounds it.
    for (let pass = 0; pass <= text.length; pass++) {
      items.push(this.value(depth + 1));
      this.skip();
      if (text.charAt(this.#position) === ',') {
        this.#position++;
        continue;
      }
      if (text.charAt(this.#position) === ']') {
        this.#position++;
        return { type: 'array', start, end: this.#position, items };
      }
      return this.fail('Expected "," or "]"');
    }
    assert(false, 'An array ends within its text');
  }
}

const parseData = (text: string): unknown => {
  const data: unknown = JSON.parse(text);
  return data;
};

// The indentation of the line a position sits on, so an inserted or replaced
// value lines up with what is around it.
function indentAt(text: string, position: number): string {
  const lineStart = text.lastIndexOf('\n', position - 1) + 1;
  const match = text.slice(lineStart, position).match(/^[ \t]*/);
  return match ? match[0] : '';
}

// One indent level, as the file writes it.
function indentUnit(text: string): string {
  const match = text.match(/\n([ \t]+)\S/);
  const unit = match?.[1];
  if (unit === undefined) {
    return '  ';
  }
  return unit.charAt(0) === '\t' ? '\t' : unit;
}

// A value, printed the way the surrounding file would have printed it.
function print(value: unknown, baseIndent: string, unit: string): string {
  const body = JSON.stringify(value, null, unit);
  // A value JSON cannot hold (undefined, a function) is written as JSON's own null.
  if (body === undefined) {
    return 'null';
  }
  return body.split('\n').join(`\n${baseIndent}`);
}

// A located member: the pair shape for object members (with key spans), the
// item shape for array elements, and the bare span when the root itself lands.
type Child =
  | Member
  | { readonly key: number; readonly start: number; readonly end: number; readonly value: JsonNode }
  | { readonly start: number; readonly end: number; readonly value: JsonNode };

function childAt(node: JsonNode | undefined, key: string | number | undefined): Child | undefined {
  if (!node) {
    return undefined;
  }
  if (node.type === 'object') {
    return node.members.find((member) => member.key === String(key));
  }
  if (node.type === 'array') {
    const item = node.items[Number(key)];
    return item ? { key: Number(key), start: item.start, end: item.end, value: item } : undefined;
  }
  return undefined;
}

interface Located {
  readonly parent: JsonNode | undefined;
  readonly key: string | number | undefined;
  readonly member: Child | undefined;
}

// The member a path names, plus the container it lives in — which is what an
// insert needs when the member is not there yet.
function locate(root: JsonNode, path: readonly (string | number)[]): Located | undefined {
  let node: JsonNode = root;
  for (let level = 0; level < path.length; level++) {
    const member = childAt(node, path[level]);
    if (!member) {
      return level === path.length - 1 ? { parent: node, key: path[level], member: undefined } : undefined;
    }
    if (level === path.length - 1) {
      return { parent: node, key: path[level], member };
    }
    node = member.value;
  }
  return {
    parent: undefined,
    key: undefined,
    member: { start: node.start, end: node.end, value: node },
  };
}

// Where a new member goes, and what has to be written around it: after the last
// one (with a comma), or on its own line inside an empty container.
function insertion(text: string, container: JsonNode, unit: string): { at: number; before: string; after: string; inner: string } {
  const parts: readonly { start: number; end: number }[] = container.type === 'object' ? container.members : container.type === 'array' ? container.items : [];
  const openIndent = indentAt(text, container.start);
  const inner = openIndent + unit;
  if (!parts.length) {
    // `{}` or `[]` — open it up rather than writing on one line, which is what
    // the rest of the file looks like.
    return { at: container.start + 1, before: `\n${inner}`, after: `\n${openIndent}`, inner };
  }
  const last = parts[parts.length - 1];
  const lastIndent = indentAt(text, last?.start ?? container.start);
  return {
    at: last?.end ?? container.end - 1,
    before: `,\n${lastIndent}`,
    after: '',
    inner: lastIndent,
  };
}

const DELETE = Symbol('delete');

export interface Edit {
  readonly path: readonly (string | number)[];
  readonly value?: unknown;
  readonly rename?: string;
}

/**
 * Applies edits to JSON source text, changing only the spans that changed.
 * Each edit is { path: [key | index, ...], value } — `DELETE` as the value
 * removes the member. Paths that name something inside a value that does not
 * exist yet create the intermediate objects.
 */
function applyEdits(text: string, edits: readonly Edit[]): string {
  const unit = indentUnit(text);
  let out = text;

  for (const edit of edits) {
    const root = parse(out);
    const path = edit.path;

    // Renaming a key is not the same as removing one and adding another: the
    // record keeps its place in the file, and its value is never rewritten.
    if (edit.rename !== undefined) {
      const found = locate(root, path);
      const member = found?.member;
      if (member && 'keyEnd' in member) {
        out = out.slice(0, member.keyStart) + JSON.stringify(String(edit.rename)) + out.slice(member.keyEnd);
      }
      continue;
    }
    if (!path.length) {
      out = print(edit.value, '', unit) + (out.endsWith('\n') ? '\n' : '');
      continue;
    }

    // Walk as far as the document goes; anything missing below that is written
    // as one nested value rather than a series of empty containers.
    let node: JsonNode = root;
    let depth = 0;
    while (depth < path.length - 1) {
      const member = childAt(node, path[depth]);
      if (!member) {
        break;
      }
      node = member.value;
      depth++;
    }

    const remaining = path.slice(depth);
    const target = childAt(node, remaining[0]);

    if (edit.value === DELETE) {
      if (remaining.length > 1 || !target) {
        continue; // nothing to remove
      }
      out = removeMember(out, node, target);
      continue;
    }

    // Everything below the deepest existing container, wrapped up.
    let value = edit.value;
    for (let level = path.length - 1; level > depth; level--) {
      const key = path[level];
      if (key === undefined) {
        continue; // unreachable: level < path.length
      }
      value = typeof key === 'number' ? [value] : { [key]: value };
    }

    if (remaining.length === 1 && target) {
      const baseIndent = indentAt(out, target.value.start);
      out = out.slice(0, target.value.start) + print(value, baseIndent, unit) + out.slice(target.value.end);
      continue;
    }

    const spot = insertion(out, node, unit);
    const written = node.type === 'object' ? `${JSON.stringify(String(remaining[0]))}: ${print(value, spot.inner, unit)}` : print(value, spot.inner, unit);
    out = out.slice(0, spot.at) + spot.before + written + spot.after + out.slice(spot.at);
  }

  return out;
}

// Removing a member takes its separator with it — the comma before it when it
// is last, the one after it otherwise — so the file stays valid JSON and the
// diff stays limited to those lines.
function removeMember(text: string, container: JsonNode, member: Child): string {
  const parts: readonly Child[] | readonly { start: number; end: number }[] =
    container.type === 'object' ? container.members : container.type === 'array' ? container.items : [];
  const index = parts.findIndex((part) => part.start === member.start);
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
    from = parts[index - 1]?.end ?? from; // the comma and newline before it go too
  } else {
    to = parts[index + 1]?.start ?? to; // as does the comma, newline and indent after
  }
  return text.slice(0, from) + text.slice(to);
}

export { parse, parseData, applyEdits, indentUnit, DELETE };
