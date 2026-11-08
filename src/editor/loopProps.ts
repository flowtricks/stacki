// A component's props as its frontmatter declares them, for the loop settings
// that are bound to one:
//
//   interface Props {
//     filters?: unknown;
//   }
//   const { filters: propFilters = {"filterFor": "ALL", "fields": []} } = Astro.props;
//
// The destructure gives each prop a local name and a default; the default is
// what the component shows on its own, and each page using it may pass its own
// value instead. This module reads that destructure and adds a prop to it (and
// to `interface Props`, when the file has one), as text edits that keep every
// other line as written.

import { parser } from '@lezer/javascript';
import type { SyntaxNode } from '@lezer/common';
import { assert } from '../../shared/core/assert';
import { indentUnitOf, withIndentUnit } from '../../shared/core/indent';
import { LIMITS } from '../../shared/core/limits';
import { LOOP_SYNTAX_LIMITS } from './loopSyntax';

const typescript = parser.configure({ dialect: 'ts' });

interface Span {
  readonly from: number;
  readonly to: number;
}

/** One `key: local = default` of the props destructure. */
export interface PropEntry {
  /** The prop's name, as a page passes it. */
  readonly key: string;
  /** The name the frontmatter reads it by. */
  readonly local: string;
  /** The default's text, when it has one. */
  readonly defaultValue: Span | undefined;
}

export interface PropsDestructure {
  readonly entries: readonly PropEntry[];
  /** The `{ … }` pattern. */
  readonly pattern: Span;
}

/** A prop to add: its name, the local it is read by, its default and its type. */
export interface NewProp {
  readonly key: string;
  readonly local: string;
  readonly defaultCode: string;
  readonly type: string;
  readonly description: string;
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
const LOCAL_SUFFIX_MAX = 100;

/** The first `const { … } = Astro.props` of the frontmatter, if it has one. */
export function readPropsDestructure(frontmatter: string): PropsDestructure | undefined {
  const pattern = propsPattern(frontmatter);
  if (pattern === undefined) {
    return undefined;
  }
  const entries: PropEntry[] = [];
  for (let child = pattern.firstChild; child !== null && entries.length < LIMITS.propSchemaFieldsMax; child = child.nextSibling) {
    if (child.name === 'PatternProperty') {
      const entry = entryOf(child, frontmatter);
      if (entry !== undefined) {
        entries.push(entry);
      }
    }
  }
  return { entries, pattern: { from: pattern.from, to: pattern.to } };
}

/** The destructure entry a local name reads, if a prop gives it. */
export function propNamed(frontmatter: string, local: string): PropEntry | undefined {
  return readPropsDestructure(frontmatter)?.entries.find((entry) => entry.local === local);
}

/**
 * A local name for prop `key` that nothing in the frontmatter binds yet:
 * `propFilters`, as a builder's export names them, then `propFilters2`.
 */
export function freeLocal(key: string, taken: ReadonlySet<string>): string {
  assert(IDENTIFIER.test(key), 'A prop name is an identifier');
  const base = `prop${key.charAt(0).toUpperCase()}${key.slice(1)}`;
  for (let suffix = 1; suffix <= LOCAL_SUFFIX_MAX; suffix++) {
    const name = suffix === 1 ? base : `${base}${suffix}`;
    if (!taken.has(name)) {
      return name;
    }
  }
  assert(false, 'A free local name is found within the suffix bound');
  return base;
}

/**
 * The frontmatter with `prop` added: to the props destructure (a new one is
 * written at `anchor` when there is none) and to `interface Props`.
 */
export function withProp(frontmatter: string, prop: NewProp, anchor: number): string {
  assert(IDENTIFIER.test(prop.key), 'A new prop is named by an identifier');
  assert(IDENTIFIER.test(prop.local), 'A new prop is read by an identifier');
  assert(anchor >= 0, 'A new destructure has a place');
  assert(anchor <= frontmatter.length, 'A new destructure is inside the frontmatter');
  const destructure = readPropsDestructure(frontmatter);
  assert(destructure?.entries.every((entry) => entry.key !== prop.key) ?? true, 'A new prop is not one the component has');
  const entry = `${prop.key}: ${prop.local} = ${prop.defaultCode}`;
  const edits: { readonly at: number; readonly text: string }[] = [];
  if (destructure === undefined) {
    edits.push({ at: anchor, text: `const { ${entry} } = Astro.props;\n` });
  } else {
    // A destructure on one line stays on one line; one entry per line stays so.
    const oneLine = !frontmatter.slice(destructure.pattern.from, destructure.pattern.to).includes('\n');
    const unit = indentUnitOf(frontmatter);
    const separator = oneLine ? ', ' : `,\n${unit}`;
    const first = oneLine ? ` ${entry} ` : `\n${unit}${entry}\n`;
    const restOnly =
      destructure.entries.length === 0 && REST_ELEMENT.test(frontmatter.slice(destructure.pattern.from + 1, destructure.pattern.to - 1).trimEnd());
    if (restOnly) {
      // Only `{ ...rest }`: the new entry goes first, the rest stays last.
      edits.push({ at: destructure.pattern.from + 1, text: oneLine ? ` ${entry},` : `\n${unit}${entry},` });
    } else {
      edits.push({ at: destructureEnd(frontmatter, destructure), text: destructure.entries.length === 0 ? first : `${separator}${entry}` });
    }
  }
  const members = propsInterfaceEnd(frontmatter);
  if (members !== undefined) {
    const lineBreak = frontmatter.slice(0, members).trimEnd().length === members ? '\n' : '';
    edits.push({ at: members, text: withIndentUnit(`${lineBreak}\t/** ${prop.description} */\n\t${prop.key}?: ${prop.type};\n`, indentUnitOf(frontmatter)) });
  }
  // From the end, so an earlier position still points at its text.
  edits.sort((left, right) => right.at - left.at);
  let out = frontmatter;
  for (const edit of edits) {
    out = `${out.slice(0, edit.at)}${edit.text}${out.slice(edit.at)}`;
  }
  assert(propNamed(out, prop.local)?.key === prop.key, 'An added prop reads back');
  return out;
}

/** The doc comment above `key` in `interface Props` (its tooltip), or '' when it has none. */
export function propTooltip(frontmatter: string, key: string): string {
  const body = propsInterfaceBody(frontmatter);
  if (body === undefined) {
    return '';
  }
  let comment = '';
  for (let child = body.firstChild, count = 0; child !== null && count < LIMITS.propSchemaFieldsMax; child = child.nextSibling, count++) {
    if (child.name === 'BlockComment') {
      comment = frontmatter.slice(child.from, child.to);
    } else if (child.name === 'PropertyType') {
      if (textOf(frontmatter, child.getChild('PropertyDefinition') ?? undefined) === key) {
        return comment
          .replace(/^\/\*\*?|\*\/$/g, '')
          .replace(/^\s*\* ?/gm, '')
          .trim();
      }
      comment = '';
    }
  }
  return '';
}

// Where an entry is added: after the last entry, before any trailing comma
// and the closing brace's own line.
export function destructureEnd(frontmatter: string, destructure: PropsDestructure): number {
  const inside = frontmatter.slice(destructure.pattern.from + 1, destructure.pattern.to - 1);
  const kept = inside.replace(/[\s,]*$/, '');
  assert(kept.length <= inside.length, 'Trimming keeps a prefix');
  // A rest element (`...rest`) must stay last, so the end of the named entries is before it.
  const rest = REST_ELEMENT.exec(kept);
  return destructure.pattern.from + 1 + (rest === null ? kept.length : rest.index);
}

/** The `...rest` closing a destructure, with the separator in front of it. */
const REST_ELEMENT = /[\s,]*\.\.\.\s*[A-Za-z_$][\w$]*$/;

// The position just before `interface Props`' closing brace's line.
export function propsInterfaceEnd(frontmatter: string): number | undefined {
  const body = propsInterfaceBody(frontmatter);
  if (body === undefined) {
    return undefined;
  }
  const close = body.to - 1;
  assert(frontmatter.charAt(close) === '}', 'An interface body ends with its brace');
  // Back to the start of the brace's line, so the member goes above it.
  const lineStart = frontmatter.lastIndexOf('\n', close) + 1;
  return frontmatter.slice(lineStart, close).trim() === '' && lineStart > body.from ? lineStart : close;
}

// The `{ … }` of `interface Props`, if the frontmatter declares one.
export function propsInterfaceBody(frontmatter: string): SyntaxNode | undefined {
  const source = frontmatter.length > LOOP_SYNTAX_LIMITS.sourceCharsMax ? '' : frontmatter;
  const tree = typescript.parse(source);
  for (
    let statement = tree.topNode.firstChild, count = 0;
    statement !== null && count < LOOP_SYNTAX_LIMITS.declarationsMax;
    statement = statement.nextSibling, count++
  ) {
    const declaration = statement.name === 'ExportDeclaration' ? statement.getChild('InterfaceDeclaration') : statement;
    if (declaration?.name === 'InterfaceDeclaration' && textOf(source, declaration.getChild('TypeDefinition') ?? undefined) === 'Props') {
      return declaration.getChild('ObjectType') ?? undefined;
    }
  }
  return undefined;
}

export function propsPattern(frontmatter: string): SyntaxNode | undefined {
  const source = frontmatter.length > LOOP_SYNTAX_LIMITS.sourceCharsMax ? '' : frontmatter;
  const tree = typescript.parse(source);
  for (
    let statement = tree.topNode.firstChild, count = 0;
    statement !== null && count < LOOP_SYNTAX_LIMITS.declarationsMax;
    statement = statement.nextSibling, count++
  ) {
    if (statement.name === 'VariableDeclaration') {
      const pattern = statement.getChild('ObjectPattern');
      const value = statement.getChild('MemberExpression');
      if (pattern !== null && value !== null && source.slice(value.from, value.to).replace(/\s/g, '') === 'Astro.props') {
        return pattern;
      }
    }
  }
  return undefined;
}

// `key: local = default`, `key = default`, `key: local` or `key`.
function entryOf(node: SyntaxNode, source: string): PropEntry | undefined {
  if (node.getChild('Spread') !== null) {
    return undefined; // `...rest` is the props not named, not a prop (1.5.6 parses it as a PatternProperty).
  }
  // A shorthand (`{ title = "Hi" }`) names its prop by its binding: @lezer/javascript
  // before 1.5.6 parses that name as a PropertyName, from 1.5.6 (Studio's) as a
  // VariableDefinition alone.
  const key = textOf(source, node.getChild('PropertyName') ?? node.getChild('VariableDefinition') ?? undefined);
  if (key === undefined || !IDENTIFIER.test(key)) {
    return undefined;
  }
  const local = textOf(source, node.getChild('VariableDefinition') ?? undefined) ?? key;
  const equals = node.getChild('Equals');
  const value = equals?.nextSibling ?? undefined;
  return { key, local, defaultValue: value === undefined ? undefined : { from: value.from, to: value.to } };
}

function textOf(source: string, node: SyntaxNode | undefined): string | undefined {
  return node === undefined ? undefined : source.slice(node.from, node.to);
}
