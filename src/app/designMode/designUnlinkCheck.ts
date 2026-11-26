// Design mode (experimental, removable: docs/design-mode/REMOVE.md): whether an unlinked page renders as it did.
//
// An unlink is kept only when the page, rendered again by the dev server after the write, is the page it was:
// the same elements in the same order with the same attributes and text, and the same stylesheets in the same
// order in its head. Stacki's own markers and the dev server's source locations are left out of the comparison
// (they name nodes and lines, which an unlink changes on purpose), and whitespace is compared as a browser lays it
// out (a run of it is one space, except in `pre` and `textarea`).
//
// One difference is expected: a page with its own scoped `<style>` gives its scope attribute to every element it
// writes, which the unlinked elements now are. That changes nothing unless one of the page's scoped rules now
// matches one of them, so each such rule is matched against the page with and without the new attributes, and any
// change in what it matches is a difference.
import { assert } from '../../../shared/core/assert';

export type UnlinkCheck = { readonly kind: 'same' } | { readonly kind: 'different'; readonly detail: string };

/** Entries (elements and runs of text) compared; a page past this is not checked, and so not unlinked. */
const ENTRIES_MAX = 200_000;
const RULES_MAX = 20_000;
const RULE_DEPTH_MAX = 16;

type Entry =
  | { readonly kind: 'element'; readonly element: Element; readonly tag: string; readonly attributes: ReadonlyMap<string, string> }
  | { readonly kind: 'text'; readonly text: string };

/** Whether `after` renders as `before` did, but for the markers and the page's own scope. */
export function compareRenders(before: Document, after: Document): UnlinkCheck {
  const sheetsBefore = sheetsOf(before);
  const sheetsAfter = sheetsOf(after);
  if (sheetsBefore.join('\n') !== sheetsAfter.join('\n')) {
    return { kind: 'different', detail: 'stylesheets' };
  }
  const left = entriesOf(before.body);
  const right = entriesOf(after.body);
  if (left === undefined || right === undefined) {
    return { kind: 'different', detail: 'too large' };
  }
  if (left.length !== right.length) {
    return { kind: 'different', detail: `${String(left.length)} → ${String(right.length)} nodes` };
  }
  const scoped = new Map<Element, string>();
  for (let index = 0; index < left.length; index += 1) {
    const was = left[index];
    const is = right[index];
    assert(was !== undefined, 'compareRenders: the lists are as long');
    assert(is !== undefined, 'compareRenders: the lists are as long');
    const difference = entryDifference(was, is, scoped);
    if (difference !== undefined) {
      return { kind: 'different', detail: difference };
    }
  }
  const scopes = new Set(scoped.values());
  if (scopes.size > 1) {
    return { kind: 'different', detail: 'scopes' };
  }
  const [scope] = scopes;
  return scope === undefined ? { kind: 'same' } : scopedRulesUnchanged(after, scope, [...scoped.keys()]);
}

function entryDifference(was: Entry, is: Entry, scoped: Map<Element, string>): string | undefined {
  if (was.kind === 'text' || is.kind === 'text') {
    return was.kind === is.kind && was.kind === 'text' && is.kind === 'text' && was.text === is.text ? undefined : 'text';
  }
  if (was.tag !== is.tag) {
    return `<${was.tag}> → <${is.tag}>`;
  }
  for (const [name, value] of was.attributes) {
    if (is.attributes.get(name) !== value) {
      return `${is.tag} ${name}`;
    }
  }
  for (const name of is.attributes.keys()) {
    if (!was.attributes.has(name)) {
      if (!name.startsWith('data-astro-cid-')) {
        return `${is.tag} ${name}`;
      }
      // At most one new scope on an element: the page's own.
      if (scoped.has(is.element)) {
        return `${is.tag} ${name}`;
      }
      scoped.set(is.element, name);
    }
  }
  return undefined;
}

/** What a page's head brings in, in order: each stylesheet by what the dev server named it, or by its address. */
function sheetsOf(document: Document): readonly string[] {
  return [...document.querySelectorAll('style, link[rel~="stylesheet"]')].map((sheet) =>
    sheet.localName === 'link'
      ? `link ${sheet.getAttribute('href') ?? ''}`
      : `style ${sheet.getAttribute('data-vite-dev-id') ?? String(sheet.textContent?.length ?? 0)}`,
  );
}

const ignoredAttribute = (name: string): boolean => name.startsWith('data-avb-') || name.startsWith('data-astro-source-');

/** The body as a list of elements and runs of text, in document order; undefined past the bound. */
function entriesOf(body: HTMLElement): readonly Entry[] | undefined {
  const entries: Entry[] = [];
  let text = '';
  const flush = (): void => {
    if (text.length > 0) {
      entries.push({ kind: 'text', text });
      text = '';
    }
  };
  // An element's end is a step of its own, so the text inside it never runs on into the text after it.
  const pending: ({ readonly kind: 'node'; readonly node: Node; readonly exact: boolean } | { readonly kind: 'end' })[] = [
    { kind: 'node', node: body, exact: false },
  ];
  while (pending.length > 0) {
    if (entries.length > ENTRIES_MAX) {
      return undefined;
    }
    const next = pending.pop();
    assert(next !== undefined, 'entriesOf: a pending step');
    if (next.kind === 'end') {
      flush();
      continue;
    }
    const { node, exact } = next;
    if (node.nodeType === 3) {
      const data = node.textContent ?? '';
      text = exact ? text + data : (text + data).replace(/[ \t\n\r\f]+/g, ' ');
      continue;
    }
    if (!isElement(node)) {
      continue;
    }
    flush();
    const attributes = new Map<string, string>();
    for (const attribute of [...node.attributes].sort((left, right) => left.name.localeCompare(right.name))) {
      if (!ignoredAttribute(attribute.name)) {
        // A scope attribute is matched by its presence alone.
        attributes.set(attribute.name, attribute.name.startsWith('data-astro-cid-') ? '' : attribute.value);
      }
    }
    entries.push({ kind: 'element', element: node, tag: node.localName, attributes });
    const keep = exact || node.localName === 'pre' || node.localName === 'textarea';
    const children = isTemplate(node) ? [...node.content.childNodes] : [...node.childNodes];
    // Last first, so they come off the stack in document order.
    pending.push({ kind: 'end' });
    for (const child of children.reverse()) {
      pending.push({ kind: 'node', node: child, exact: keep });
    }
  }
  flush();
  return entries;
}

/** Whether each of the page's scoped rules matches the same elements with and without `scope` on `elements`. */
function scopedRulesUnchanged(document: Document, scope: string, elements: readonly Element[]): UnlinkCheck {
  const selectors = scopedSelectors(document, scope);
  if (selectors === undefined) {
    return { kind: 'different', detail: 'unreadable styles' };
  }
  const matching = (): readonly (readonly Element[])[] | undefined => {
    try {
      return selectors.map((selector) => [...document.querySelectorAll(selector)]);
    } catch {
      return undefined;
    }
  };
  const withScope = matching();
  const values = elements.map((element) => element.getAttribute(scope) ?? '');
  for (const element of elements) {
    element.removeAttribute(scope);
  }
  const withoutScope = matching();
  elements.forEach((element, index) => element.setAttribute(scope, values[index] ?? ''));
  if (withScope === undefined || withoutScope === undefined) {
    return { kind: 'different', detail: 'unreadable styles' };
  }
  const changed = withScope.some((list, index) => {
    const other = withoutScope[index] ?? [];
    return list.length !== other.length || list.some((element, at) => other[at] !== element);
  });
  return changed ? { kind: 'different', detail: 'page styles' } : { kind: 'same' };
}

/** Every selector of the page's stylesheets that names `scope`, nested rules written out whole; undefined if unreadable. */
function scopedSelectors(document: Document, scope: string): readonly string[] | undefined {
  const selectors: string[] = [];
  const pending: { readonly rules: CSSRuleList; readonly parent: string | undefined; readonly depth: number }[] = [];
  for (const style of [...document.querySelectorAll('style')]) {
    if (!(style.textContent ?? '').includes(scope)) {
      continue;
    }
    if (style.sheet === null) {
      return undefined;
    }
    pending.push({ rules: style.sheet.cssRules, parent: undefined, depth: 0 });
  }
  let visited = 0;
  while (pending.length > 0) {
    const next = pending.pop();
    assert(next !== undefined, 'scopedSelectors: a pending list');
    if (next.depth > RULE_DEPTH_MAX) {
      return undefined;
    }
    for (const rule of [...next.rules]) {
      visited += 1;
      if (visited > RULES_MAX) {
        return undefined;
      }
      const own = 'selectorText' in rule && typeof rule.selectorText === 'string' ? rule.selectorText : undefined;
      const whole = own === undefined ? next.parent : nestedSelector(own, next.parent);
      if (own !== undefined && whole !== undefined && whole.includes(scope)) {
        selectors.push(whole);
      }
      const inner: unknown = 'cssRules' in rule ? rule.cssRules : undefined;
      if (isRuleList(inner)) {
        pending.push({ rules: inner, parent: whole, depth: next.depth + 1 });
      }
    }
  }
  return selectors;
}

const isRuleList = (value: unknown): value is CSSRuleList => typeof value === 'object' && value !== null && 'length' in value && 'item' in value;

/** A nested rule's selector written out against its parent's. */
function nestedSelector(own: string, parent: string | undefined): string {
  if (parent === undefined) {
    return own;
  }
  return own.includes('&') ? own.replace(/&/g, `:is(${parent})`) : `:is(${parent}) ${own}`;
}

const isElement = (node: Node): node is Element => node.nodeType === 1;
const isTemplate = (element: Element): element is HTMLTemplateElement => element.localName === 'template' && 'content' in element;
