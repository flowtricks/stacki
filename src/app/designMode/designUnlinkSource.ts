// Design mode (experimental, removable: docs/design-mode/REMOVE.md): the page text an unlink writes.
//
// The unlinked markup (designUnlinkMarkup.ts) takes the instance's place in the page's text, byte for byte around
// it, and the page's imports follow: a component the markup keeps is imported (from where the page can reach it),
// and the unlinked component's own import goes only when nothing else on the page names it. Even then its styles
// must stay, since the markup carries its scope attributes: Astro gives a page the styles of the components it
// imports, and an import nothing renders is dropped by the compiler, so it becomes a bare `import "…";`, which is
// kept and renders nothing. It is removed outright only when the component can bring no style at all.
//
// Pure text in, text out; every offset is the located parse's (UTF-16).
import type { ImportDecl, PageNode } from '../../../shared/page/pageNode';
import { assert } from '../../../shared/core/assert';
import { LIMITS } from '../../../shared/core/limits';
import type { PropBinding, SlotChild } from './designUnlinkMarkup';

/** A frontmatter's characters scanned for its `Astro.props` destructuring. */
const FRONTMATTER_CHARS_MAX = 400_000;
/** Names one destructuring binds. */
const BINDINGS_MAX = 500;
/** Aliases tried for a component whose name the page already uses. */
const ALIASES_MAX = 50;

/** The frontmatter of an .astro file's text (between its `---` fences), or '' when it has none. */
export function frontmatterOf(text: string): string {
  const match = /^﻿?\s*---\r?\n([\s\S]*?)\r?\n---/.exec(text.slice(0, FRONTMATTER_CHARS_MAX));
  return match?.[1] ?? '';
}

/**
 * The names a component's frontmatter binds from `Astro.props` with one `const { … } = Astro.props` and never
 * assigns again: local name → the prop it is and its default's source. Anything else (`let`, a second destructuring,
 * an assignment) leaves the name out, so an expression using it is not read as the prop.
 */
export function propBindings(frontmatter: string): ReadonlyMap<string, PropBinding> {
  const bindings = new Map<string, PropBinding>();
  const text = frontmatter.slice(0, FRONTMATTER_CHARS_MAX);
  if (/\b(let|var)\s*\{[^}]*\}\s*=\s*Astro\.props\b/.test(text)) {
    return bindings;
  }
  const opening = /\bconst\s*\{/g;
  const found: { readonly from: number; readonly to: number; readonly inner: string }[] = [];
  for (let match = opening.exec(text); match !== null && found.length < 2; match = opening.exec(text)) {
    const start = match.index + match[0].length;
    const close = closingBrace(text, start);
    if (close !== undefined && /^\s*=\s*Astro\.props\b/.test(text.slice(close + 1))) {
      found.push({ from: match.index, to: close + 1, inner: text.slice(start, close) });
    }
  }
  const [only] = found;
  if (found.length !== 1 || only === undefined) {
    return bindings;
  }
  const rest = text.slice(0, only.from) + text.slice(only.to);
  for (const entry of topLevelParts(only.inner).slice(0, BINDINGS_MAX)) {
    const binding = bindingOf(entry);
    if (binding !== undefined && !assignedIn(rest, binding.local)) {
      bindings.set(binding.local, { key: binding.key, fallback: binding.fallback });
    }
  }
  assert(bindings.size <= BINDINGS_MAX, 'propBindings: bounded');
  return bindings;
}

function bindingOf(entry: string): { readonly local: string; readonly key: string; readonly fallback: string | undefined } | undefined {
  const part = entry.trim();
  if (part.length === 0 || part.startsWith('...')) {
    return undefined;
  }
  const match = /^(?:(["']?)([\w$-]+)\1\s*:\s*)?([A-Za-z_$][\w$]*)\s*(?:=\s*([\s\S]+))?$/.exec(part);
  if (match === null) {
    return undefined;
  }
  const local = match[3] ?? '';
  const key = match[2] ?? local;
  assert(local.length > 0, 'bindingOf: a binding names its local');
  return { local, key, fallback: match[4]?.trim() };
}

function assignedIn(text: string, name: string): boolean {
  const escaped = name.replace(/\$/g, '\\$');
  return new RegExp(`(^|[^\\w$.])${escaped}\\s*(\\+\\+|--|([-+*/%&|^]|\\*\\*|<<|>>>?|&&|\\|\\||\\?\\?)?=(?!=))`).test(text);
}

/** The index of the brace that closes the one opened just before `start`, skipping strings; undefined if none. */
function closingBrace(text: string, start: number): number | undefined {
  let depth = 1;
  let quote: string | undefined;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (quote !== undefined) {
      if (character === '\\') {
        index += 1;
      } else if (character === quote) {
        quote = undefined;
      }
      continue;
    }
    if (character === '"' || character === "'" || character === '`') {
      quote = character;
    } else if (character === '{' || character === '[' || character === '(') {
      depth += 1;
    } else if (character === '}' || character === ']' || character === ')') {
      depth -= 1;
      if (depth === 0) {
        return character === '}' ? index : undefined;
      }
    }
  }
  return undefined;
}

/** `a, b = { c, d }, e` split at its top-level commas. */
function topLevelParts(inner: string): readonly string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | undefined;
  let from = 0;
  for (let index = 0; index < inner.length; index += 1) {
    const character = inner[index];
    if (quote !== undefined) {
      if (character === '\\') {
        index += 1;
      } else if (character === quote) {
        quote = undefined;
      }
      continue;
    }
    if (character === '"' || character === "'" || character === '`') {
      quote = character;
    } else if (character === '{' || character === '[' || character === '(') {
      depth += 1;
    } else if (character === '}' || character === ']' || character === ')') {
      depth -= 1;
    } else if (character === ',' && depth === 0) {
      parts.push(inner.slice(from, index));
      from = index + 1;
    }
  }
  parts.push(inner.slice(from));
  return parts;
}

/**
 * Each child of the instance as slot content the page can write elsewhere: its own text, without the `slot`
 * attribute that placed it (outside a component it would be an attribute, or a prop). Undefined for a child whose
 * slot cannot be read (`slot={…}`) or whose text the parse did not locate.
 */
export function slotChildren(source: string, instance: PageNode): readonly (SlotChild | undefined)[] {
  const children = 'children' in instance && Array.isArray(instance.children) ? instance.children : [];
  assert(children.length <= LIMITS.treeNodesMax, 'slotChildren: bounded');
  return children.map((child: PageNode): SlotChild | undefined => {
    if (child.start === undefined || child.end === undefined) {
      return undefined;
    }
    const text = source.slice(child.start, child.end);
    const blank = child.kind === 'comment' || (child.kind === 'text' && child.value.trim().length === 0);
    const slot = child.kind === 'element' || child.kind === 'component' ? child.props?.['slot'] : undefined;
    if (slot === undefined) {
      return { source: text, slot: undefined, blank };
    }
    const span = child.attrSpans?.find((entry) => entry.name === 'slot');
    if (slot.type !== 'string' || span === undefined) {
      return undefined;
    }
    // The attribute and the space before it.
    let from = span.span.start - child.start;
    const to = span.span.end - child.start;
    while (from > 0 && /\s/.test(text[from - 1] ?? '')) {
      from -= 1;
    }
    assert(from >= 0, 'slotChildren: the slot attribute is inside its tag');
    assert(to <= text.length, 'slotChildren: the slot attribute ends inside its tag');
    return { source: text.slice(0, from) + text.slice(to), slot: slot.value, blank };
  });
}

/** A component the markup keeps, as the page imports it. */
export interface PageImport {
  readonly local: string;
  /** The statement to add, or undefined when the page already imports it under `local`. */
  readonly statement: string | undefined;
}

/**
 * How the page imports `decl`, a component the unlinked component's file imports: the page's own import of the
 * same thing, else a new statement under its name or, when the page uses that name already, the first free alias.
 * `spec` is where the page reaches it from. Undefined when no free name is found.
 */
export function pageImportOf(decl: ImportDecl, spec: string, pageImports: readonly ImportDecl[], frontmatter: string, quote: string): PageImport | undefined {
  const imported = decl.named === true ? (decl.imported ?? decl.name) : undefined;
  const same = pageImports.find(
    (entry) => entry.path === spec && entry.typeOnly !== true && (entry.named === true ? (entry.imported ?? entry.name) : undefined) === imported,
  );
  if (same !== undefined) {
    return { local: same.name, statement: undefined };
  }
  for (let attempt = 1; attempt <= ALIASES_MAX; attempt += 1) {
    const local = attempt === 1 ? decl.name : `${decl.name}${String(attempt)}`;
    if (!nameUsed(frontmatter, local)) {
      const binding = imported === undefined ? local : imported === local ? `{ ${local} }` : `{ ${imported} as ${local} }`;
      return { local, statement: `import ${binding} from ${quote}${spec}${quote};` };
    }
  }
  return undefined;
}

function nameUsed(text: string, name: string): boolean {
  return new RegExp(`(^|[^\\w$])${name.replace(/\$/g, '\\$')}($|[^\\w$])`).test(text);
}

/** Where the page reaches a file a component imports with `spec`: a relative spec is rebased onto the page's folder. */
export function rebasedSpec(spec: string, componentFile: string, pageFile: string): string {
  if (!spec.startsWith('./') && !spec.startsWith('../')) {
    return spec;
  }
  const target = normalized([...folderOf(componentFile), ...spec.split('/')]);
  const from = folderOf(pageFile);
  let shared = 0;
  while (shared < from.length && shared < target.length - 1 && from[shared] === target[shared]) {
    shared += 1;
  }
  const up = from.slice(shared).map(() => '..');
  const relative = [...up, ...target.slice(shared)].join('/');
  return up.length === 0 ? `./${relative}` : relative;
}

function folderOf(file: string): readonly string[] {
  return file.split('/').slice(0, -1);
}

function normalized(parts: readonly string[]): readonly string[] {
  const out: string[] = [];
  for (const part of parts) {
    if (part === '..') {
      out.pop();
    } else if (part !== '.' && part !== '') {
      out.push(part);
    }
  }
  return out;
}

/** What becomes of the unlinked component's own import. */
export type OwnImport = 'keep' | 'bare' | 'remove';

export interface PageEdit {
  readonly source: string;
  /** Where the markup starts in the new text. */
  readonly markupAt: number;
}

/**
 * The page's text with the instance (`start`–`end`) replaced by `markup`, its own import statement (`own`, written
 * as `statement`) treated as `ownImport` says, and `added` statements written right after it.
 */
export function editedPage(
  source: string,
  instance: { readonly start: number; readonly end: number },
  markup: string,
  imports: { readonly statement: string | undefined; readonly ownImport: OwnImport; readonly bare: string; readonly added: readonly string[] },
): PageEdit | undefined {
  assert(instance.start < instance.end, 'editedPage: an instance has text');
  assert(instance.end <= source.length, 'editedPage: the instance is in the page');
  const body = source.slice(0, instance.start) + markup + source.slice(instance.end);
  const statement = imports.statement;
  if (statement === undefined) {
    return imports.added.length === 0 && imports.ownImport === 'keep' ? { source: body, markupAt: instance.start } : undefined;
  }
  const at = source.indexOf(statement);
  if (at < 0 || at > instance.start || source.indexOf(statement, at + 1) >= 0) {
    return undefined;
  }
  const lineEnd = /\r\n/.test(source) ? '\r\n' : '\n';
  const indent = /[ \t]*$/.exec(source.slice(0, at))?.[0] ?? '';
  const added = imports.added.map((line) => `${lineEnd}${indent}${line}`).join('');
  let replacement: string;
  switch (imports.ownImport) {
    case 'keep':
      replacement = statement + added;
      break;
    case 'bare':
      replacement = imports.bare + added;
      break;
    case 'remove':
      replacement = added.replace(/^\r?\n[ \t]*/, '');
      break;
    default: {
      const exhaustive: never = imports.ownImport;
      return exhaustive;
    }
  }
  let from = at;
  let to = at + statement.length;
  if (replacement === '') {
    // The whole line goes, with its line break.
    from -= indent.length;
    to = source.startsWith(lineEnd, to) ? to + lineEnd.length : to;
  }
  const shift = replacement.length - (to - from);
  const next = body.slice(0, from) + replacement + body.slice(to);
  assert(next.length === source.length - (instance.end - instance.start) + markup.length + shift, 'editedPage: only the statement and the instance change');
  return { source: next, markupAt: instance.start + shift };
}

/**
 * The text of the statement that imports `decl` (`import Card from "…";`), when it imports that one name alone and is
 * written once: the statement an unlink may rewrite. Undefined otherwise, and the import is then left as it is.
 */
export function importStatementOf(source: string, decl: ImportDecl): string | undefined {
  const frontmatter = frontmatterOf(source);
  const name = decl.name.replace(/\$/g, '\\$');
  const spec = decl.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const binding =
    decl.named === true ? `\\{\\s*${decl.imported !== undefined && decl.imported !== decl.name ? `${decl.imported}\\s+as\\s+` : ''}${name}\\s*\\}` : name;
  const pattern = new RegExp(`import\\s+${binding}\\s+from\\s+(["'])${spec}\\1[ \\t]*;?`, 'g');
  const matches = [...frontmatter.matchAll(pattern)].slice(0, 2);
  const [only] = matches;
  return matches.length === 1 && only !== undefined ? only[0] : undefined;
}
