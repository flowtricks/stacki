// Which of a component's props nothing in the component reads, for the
// Properties panel's warning. A prop is used when the name the frontmatter
// reads it by (its destructure local: `title`, `propClass` for
// `class: propClass`) appears in an expression of the markup (a binding, a
// spread, a `class:list`, a condition, a loop) or in frontmatter code other
// than its own declaration and destructure, such as a value computed from it.
//
// Read from the file text, the way the Properties panel already holds the
// component (ComponentProperties.source), without running anything. Words in
// the markup's text are not expressions, so a heading that says "title" does
// not count; `<style>` and `<script>` blocks cannot see frontmatter values
// unless they declare `define:vars`, so they are left out otherwise.

import { assert } from '../../shared/core/assert';
import { PROPERTY_LIMITS } from '../../shared/properties/propertyEditing';
import { propsInterfaceBody, propsPattern, readPropsDestructure } from './loopProps';

/** The declared prop names nothing in the component reads. */
export function unusedProps(source: string, names: readonly string[]): ReadonlySet<string> {
  assert(names.length <= PROPERTY_LIMITS.fieldsMax, 'unusedProps: property count is bounded');
  if (source.length > PROPERTY_LIMITS.sourceCharsMax) {
    return new Set();
  }
  const { frontmatter, body } = split(source);
  const locals = new Map((readPropsDestructure(frontmatter)?.entries ?? []).map((entry) => [entry.key, entry.local]));
  const reading = `${withoutDeclarations(frontmatter)}\n${markupExpressions(body).join('\n')}`;
  const unused = new Set<string>();
  for (const name of names) {
    const local = locals.get(name);
    // A prop the destructure does not read may still be read as `Astro.props.name`.
    const used =
      local === undefined
        ? !/^[A-Za-z_$][\w$]*$/.test(name) || new RegExp(`Astro\\.props\\s*(\\.\\s*${name}\\b|\\[\\s*["']${name}["']\\s*\\])`).test(source)
        : identifierIn(reading, local);
    if (!used) {
      unused.add(name);
    }
  }
  assert(unused.size <= names.length, 'unusedProps: only declared props are reported');
  return unused;
}

function split(source: string): { readonly frontmatter: string; readonly body: string } {
  const match = /^\s*---\r?\n([\s\S]*?)\r?\n---[^\n]*\n?/.exec(source) ?? undefined;
  if (match === undefined) {
    return { frontmatter: '', body: source };
  }
  return { frontmatter: match[1] ?? '', body: source.slice(match[0].length) };
}

// The frontmatter without `interface Props` and the destructure pattern, which
// name every prop without reading it; comments go too.
function withoutDeclarations(frontmatter: string): string {
  const spans = [propsInterfaceBody(frontmatter), propsPattern(frontmatter)].filter((node) => node !== undefined);
  let out = frontmatter;
  for (const span of [...spans].sort((left, right) => right.from - left.from)) {
    out = `${out.slice(0, span.from)}${' '.repeat(span.to - span.from)}${out.slice(span.to)}`;
  }
  return out.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

const EXPRESSIONS_MAX = 100_000;

// Every `{…}` of the markup, outermost, with comments, styles and scripts
// that cannot read frontmatter values taken out first.
function markupExpressions(body: string): readonly string[] {
  const markup = body
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(style|script)\b([^>]*)>[\s\S]*?<\/\1>/gi, (block: string, _tag: string, attributes: string) => (/define:vars/.test(attributes) ? block : ' '));
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < markup.length && out.length < EXPRESSIONS_MAX; index++) {
    const character = markup.charAt(index);
    if (character === '{') {
      if (depth === 0) {
        start = index;
      }
      depth++;
    } else if (character === '}' && depth > 0) {
      depth--;
      if (depth === 0) {
        out.push(markup.slice(start, index + 1));
      }
    }
  }
  return out;
}

function identifierIn(text: string, name: string): boolean {
  assert(/^[A-Za-z_$][\w$]*$/.test(name), 'identifierIn: a local is an identifier');
  const escaped = name.replace(/\$/g, '\\$');
  // Not a property of something else (`item.title`), nor part of a longer
  // name; a spread (`{...rest}`) reads it.
  return new RegExp(`(^|[^\\w$.]|\\.\\.\\.)${escaped}(?![\\w$])`).test(text);
}
