// What a frame changed, read by comparing its document with the page as it was copied (the baseline), element
// by element through their design ids. It is a comparison of two states, never a log of gestures, so undo,
// redo and a gesture undone by hand all read correctly. Pure over two DOM documents.
import { DESIGN_ID_ATTRIBUTE, INSTANCE_ATTRIBUTE, MARKER_ATTRIBUTE, markerPaths } from './designPrepare';
import {
  COMPONENT_ATTRIBUTE,
  COPY_ATTRIBUTE,
  FREE_ATTRIBUTE,
  designIdOf,
  ORIGIN_ATTRIBUTE,
  PROPS_ATTRIBUTE,
  UNLINKED_ATTRIBUTE,
  isTextLeaf,
} from './designDom';
import { DESIGN_LIMITS, type DesignElementId, type DesignInstanceInfo, type DesignNodeSource } from './designTypes';
import type { DesignJson } from '../../../../shared/designMode/designModeContract';

/** An element as a change names it. */
export interface DescribedElement {
  readonly id: DesignElementId | undefined;
  /** `Heading "A shared Stacki editor"`, `section.hero`, `Button`. */
  readonly label: string;
  /** Where it is written: `src/pages/index.astro:12`, or the component file it belongs to. */
  readonly source: string | undefined;
}

export interface StyleChange {
  readonly property: string;
  readonly before: string;
  readonly after: string;
}

export type DesignChange =
  | { readonly kind: 'moved'; readonly element: DescribedElement; readonly parent: DescribedElement; readonly after: DescribedElement | undefined }
  | { readonly kind: 'freed'; readonly element: DescribedElement; readonly parent: DescribedElement; readonly box: string }
  | { readonly kind: 'restyled'; readonly element: DescribedElement; readonly styles: readonly StyleChange[] }
  | { readonly kind: 'text'; readonly element: DescribedElement; readonly before: string; readonly after: string }
  | { readonly kind: 'attribute'; readonly element: DescribedElement; readonly name: string; readonly before: string; readonly after: string }
  | { readonly kind: 'removed'; readonly element: DescribedElement; readonly parent: DescribedElement }
  | { readonly kind: 'hidden'; readonly element: DescribedElement }
  | { readonly kind: 'shown'; readonly element: DescribedElement }
  | { readonly kind: 'added'; readonly element: DescribedElement; readonly parent: DescribedElement; readonly what: string }
  | { readonly kind: 'props'; readonly element: DescribedElement; readonly component: string; readonly props: readonly StyleChange[] }
  | { readonly kind: 'unlinked'; readonly element: DescribedElement; readonly component: string };

export interface ChangeContext {
  readonly instances: ReadonlyMap<string, DesignInstanceInfo>;
  readonly sources: ReadonlyMap<string, DesignNodeSource>;
  /** The page file the page paths belong to, for `file:line` references. */
  readonly pageFile: string | undefined;
}

/** Attributes Design mode and the canvas keep for themselves: never a change of the design. */
function isOwnAttribute(name: string): boolean {
  return (
    name.startsWith('data-dm-') || name.startsWith('data-avb-') || name === 'style' || name === 'data-astro-source-file' || name === 'data-astro-source-loc'
  );
}

/** The properties making an element free, said once as a placement rather than as five style changes. */
const FREE_PROPERTIES = new Set(['position', 'left', 'top', 'right', 'bottom', 'margin', 'width', 'height', 'transform']);

const TEXT_EXCERPT_CHARS_MAX = 48;

/** Every change of `current` against `baseline`, in the order of the current document. */
export function designChanges(baseline: Document, current: Document, context: ChangeContext): readonly DesignChange[] {
  const before = indexById(baseline);
  const after = indexById(current);
  const changes: DesignChange[] = [];
  const rerendered = rerenderedElements(current, baseline);
  const added = new Set<Element>();
  for (const [id, element] of after) {
    if (rerendered.current.has(element)) {
      continue;
    }
    const original = before.get(id);
    if (original === undefined) {
      if (element.parentElement === null || added.has(element.parentElement)) {
        added.add(element);
        continue;
      }
      added.add(element);
      changes.push(addedChange(element, before, context));
      continue;
    }
    changes.push(...elementChanges(original, element, context));
  }
  changes.push(...moves(before, after, rerendered.current, context));
  for (const [id, original] of before) {
    if (after.has(id) || rerendered.baseline.has(original)) {
      continue;
    }
    const parentId = original.parentElement?.getAttribute(DESIGN_ID_ATTRIBUTE) ?? undefined;
    // Only the outermost of what was removed: its descendants went with it.
    if (parentId === undefined || after.has(parentId)) {
      changes.push({ kind: 'removed', element: describe(original, context), parent: describe(original.parentElement ?? original, context) });
    }
  }
  return changes;
}

function indexById(document: Document): Map<string, Element> {
  const index = new Map<string, Element>();
  const body = document.body;
  if (body === null) {
    return index;
  }
  for (const element of [body, ...body.querySelectorAll('[' + DESIGN_ID_ATTRIBUTE + ']')].slice(0, DESIGN_LIMITS.elementsMax)) {
    const id = element.getAttribute(DESIGN_ID_ATTRIBUTE);
    if (id !== null && !index.has(id)) {
      index.set(id, element);
    }
  }
  return index;
}

/** Inside an instance rendered again with new props: their insides are the component's, said once as the props change. */
function rerenderedElements(current: Document, baseline: Document): { readonly current: Set<Element>; readonly baseline: Set<Element> } {
  const inCurrent = new Set<Element>();
  const inBaseline = new Set<Element>();
  for (const root of current.querySelectorAll('[' + PROPS_ATTRIBUTE + ']')) {
    for (const inner of root.querySelectorAll('*')) {
      inCurrent.add(inner);
    }
    const key = root.getAttribute(INSTANCE_ATTRIBUTE);
    if (key === null) {
      continue;
    }
    for (const original of baseline.querySelectorAll('[' + INSTANCE_ATTRIBUTE + '="' + key + '"]')) {
      for (const inner of original.querySelectorAll('*')) {
        inBaseline.add(inner);
      }
    }
  }
  return { current: inCurrent, baseline: inBaseline };
}

function elementChanges(original: Element, element: Element, context: ChangeContext): readonly DesignChange[] {
  const changes: DesignChange[] = [];
  const described = describe(element, context);
  const beforeStyles = styleMap(original.getAttribute('style') ?? undefined);
  const afterStyles = styleMap(element.getAttribute('style') ?? undefined);
  const freed = element.hasAttribute(FREE_ATTRIBUTE) && !original.hasAttribute(FREE_ATTRIBUTE);
  const hiddenNow = afterStyles.get('display') === 'none';
  const hiddenBefore = beforeStyles.get('display') === 'none';
  if (hiddenNow && !hiddenBefore) {
    changes.push({ kind: 'hidden', element: described });
  } else if (hiddenBefore && !hiddenNow) {
    changes.push({ kind: 'shown', element: described });
  }
  if (freed) {
    const parent = element.parentElement;
    changes.push({ kind: 'freed', element: described, parent: describe(parent ?? element, context), box: freeBox(afterStyles) });
  }
  const styles: StyleChange[] = [];
  for (const property of new Set([...beforeStyles.keys(), ...afterStyles.keys()])) {
    if (property === 'display' && (hiddenNow || hiddenBefore)) {
      continue;
    }
    if (freed && FREE_PROPERTIES.has(property)) {
      continue;
    }
    const was = beforeStyles.get(property) ?? '';
    const now = afterStyles.get(property) ?? '';
    if (was !== now) {
      styles.push({ property, before: was, after: now });
    }
  }
  if (styles.length > 0) {
    changes.push({ kind: 'restyled', element: described, styles });
  }
  for (const name of new Set([...original.getAttributeNames(), ...element.getAttributeNames()])) {
    if (isOwnAttribute(name)) {
      continue;
    }
    const was = original.getAttribute(name) ?? '';
    const now = element.getAttribute(name) ?? '';
    if (was !== now) {
      changes.push({ kind: 'attribute', element: described, name, before: was, after: now });
    }
  }
  if (isTextLeaf(element) || isTextLeaf(original)) {
    const was = normalisedText(original);
    const now = normalisedText(element);
    if (was !== now) {
      changes.push({ kind: 'text', element: described, before: was, after: now });
    }
  }
  const propsNow = element.getAttribute(PROPS_ATTRIBUTE);
  const key = element.getAttribute(INSTANCE_ATTRIBUTE);
  if (propsNow !== null && key !== null) {
    const info = context.instances.get(key);
    if (info !== undefined) {
      changes.push({ kind: 'props', element: described, component: info.component, props: propChanges(info.props, propsNow) });
    }
  }
  const unlinked = element.getAttribute(UNLINKED_ATTRIBUTE);
  if (unlinked !== null && !original.hasAttribute(UNLINKED_ATTRIBUTE)) {
    changes.push({ kind: 'unlinked', element: described, component: unlinked });
  }
  return changes;
}

function propChanges(written: Readonly<Record<string, DesignJson>>, json: string): readonly StyleChange[] {
  let now: unknown;
  try {
    now = JSON.parse(json);
  } catch {
    return [];
  }
  if (typeof now !== 'object' || now === null || Array.isArray(now)) {
    return [];
  }
  const changes: StyleChange[] = [];
  const names = new Set([...Object.keys(written), ...Object.keys(now)]);
  for (const name of names) {
    const was = name in written ? JSON.stringify(written[name]) : '(unset)';
    const value: unknown = Reflect.get(now, name);
    const is = value === undefined ? '(unset)' : JSON.stringify(value);
    if (was !== is) {
      changes.push({ property: name, before: was, after: is });
    }
  }
  return changes;
}

/** Elements whose parent or place among their siblings changed. Order within a parent uses a longest increasing run. */
function moves(
  before: ReadonlyMap<string, Element>,
  after: ReadonlyMap<string, Element>,
  skipped: ReadonlySet<Element>,
  context: ChangeContext,
): readonly DesignChange[] {
  const changes: DesignChange[] = [];
  const reported = new Set<string>();
  for (const [id, element] of after) {
    const original = before.get(id);
    if (original === undefined || skipped.has(element) || element.hasAttribute(FREE_ATTRIBUTE)) {
      continue;
    }
    const parentBefore = original.parentElement?.getAttribute(DESIGN_ID_ATTRIBUTE) ?? undefined;
    const parentNow = element.parentElement?.getAttribute(DESIGN_ID_ATTRIBUTE) ?? undefined;
    if (parentBefore !== parentNow && element.parentElement !== null) {
      reported.add(id);
      changes.push(movedChange(element, context));
    }
  }
  for (const [, parent] of after) {
    const parentId = parent.getAttribute(DESIGN_ID_ATTRIBUTE);
    const originalParent = parentId === null ? undefined : before.get(parentId);
    if (originalParent === undefined || skipped.has(parent)) {
      continue;
    }
    const kept = childIds(parent).filter((id) => !reported.has(id) && childIds(originalParent).includes(id));
    const order = childIds(originalParent).filter((id) => kept.includes(id));
    const stay = new Set(longestRun(kept.map((id) => order.indexOf(id))).map((index) => order[index] ?? ''));
    for (const id of kept) {
      const element = after.get(id);
      if (!stay.has(id) && element !== undefined && !element.hasAttribute(FREE_ATTRIBUTE)) {
        changes.push(movedChange(element, context));
      }
    }
  }
  return changes;
}

function childIds(element: Element): readonly string[] {
  return [...element.children].map((child) => child.getAttribute(DESIGN_ID_ATTRIBUTE)).filter((id): id is string => id !== null);
}

/** The indexes (into `values`' own values) of one longest strictly increasing subsequence: O(n log n). */
export function longestRun(values: readonly number[]): readonly number[] {
  const tails: number[] = [];
  const tailIndex: number[] = [];
  const previous: number[] = new Array<number>(values.length).fill(-1);
  values.forEach((value, index) => {
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if ((tails[middle] ?? 0) < value) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    tails[low] = value;
    tailIndex[low] = index;
    previous[index] = low > 0 ? (tailIndex[low - 1] ?? -1) : -1;
  });
  const run: number[] = [];
  for (let index = tailIndex[tails.length - 1] ?? -1; index >= 0 && run.length <= values.length; index = previous[index] ?? -1) {
    run.unshift(values[index] ?? 0);
  }
  return run;
}

function movedChange(element: Element, context: ChangeContext): DesignChange {
  const parent = element.parentElement ?? element;
  const sibling = element.previousElementSibling;
  return {
    kind: 'moved',
    element: describe(element, context),
    parent: describe(parent, context),
    after: sibling === null ? undefined : describe(sibling, context),
  };
}

function addedChange(element: Element, before: ReadonlyMap<string, Element>, context: ChangeContext): DesignChange {
  const parent = describe(element.parentElement ?? element, context);
  const copyOf = element.getAttribute(COPY_ATTRIBUTE);
  const original = copyOf === null ? undefined : before.get(copyOf);
  const origin = element.getAttribute(ORIGIN_ATTRIBUTE);
  const styles = styleMap(element.getAttribute('style') ?? undefined);
  let what: string;
  if (original !== undefined) {
    what = 'a copy of ' + describe(original, context).label;
  } else if (origin === 'text') {
    what = 'text "' + excerpt(normalisedText(element)) + '"';
  } else if (origin === 'box') {
    what = 'a box ' + freeBox(styles) + boxLook(styles);
  } else if (origin === 'image') {
    what = 'an image';
  } else if (origin === 'component') {
    const component = element.getAttribute(COMPONENT_ATTRIBUTE) ?? '';
    what = `a ${
      component
        .split('/')
        .pop()
        ?.replace(/\.astro$/, '') ?? 'component'
    } component (${component})`;
  } else {
    what = describe(element, context).label;
  }
  return { kind: 'added', element: describe(element, context), parent, what };
}

function boxLook(styles: ReadonlyMap<string, string>): string {
  const look = ['background', 'background-color', 'border-radius', 'border']
    .map((property) => [property, styles.get(property)] as const)
    .filter((entry): entry is readonly [string, string] => entry[1] !== undefined && entry[1] !== '')
    .map(([property, value]) => property + ': ' + value);
  return look.length === 0 ? '' : ' (' + look.join('; ') + ')';
}

function freeBox(styles: ReadonlyMap<string, string>): string {
  const left = styles.get('left') ?? '0px';
  const top = styles.get('top') ?? '0px';
  const width = styles.get('width') ?? 'auto';
  const height = styles.get('height') ?? 'auto';
  return `at left ${left}, top ${top}, ${width} × ${height}`;
}

/** An inline style attribute as property → value, declaration order kept. */
export function styleMap(style: string | undefined): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  if (style === undefined) {
    return map;
  }
  for (const declaration of style.split(';')) {
    const colon = declaration.indexOf(':');
    if (colon <= 0) {
      continue;
    }
    const property = declaration.slice(0, colon).trim().toLowerCase();
    const value = declaration.slice(colon + 1).trim();
    if (property !== '' && !property.startsWith('--design-')) {
      map.set(property, value);
    }
  }
  return map;
}

function normalisedText(element: Element): string {
  return (element.textContent ?? '').replace(/\s+/g, ' ').trim();
}

function excerpt(text: string): string {
  return text.length <= TEXT_EXCERPT_CHARS_MAX ? text : text.slice(0, TEXT_EXCERPT_CHARS_MAX - 1).trimEnd() + '…';
}

/** How a change names an element: its component or tag and first class, a bit of its text, and where it is written. */
export function describe(element: Element, context: ChangeContext): DescribedElement {
  const id = designIdOf(element);
  const key = element.getAttribute(INSTANCE_ATTRIBUTE);
  const instance = key === null ? undefined : context.instances.get(key);
  const tag = element.tagName.toLowerCase();
  const firstClass = (element.getAttribute('class') ?? '').split(/\s+/).find((name) => name !== '' && !name.startsWith('astro-'));
  const name = instance?.name ?? (tag === 'body' ? 'the page' : tag + (firstClass === undefined ? '' : '.' + firstClass));
  const text = normalisedText(element);
  const label = text === '' || tag === 'body' ? name : `${name} "${excerpt(text)}"`;
  return { id, label, source: sourceOf(element, instance, context) };
}

function sourceOf(element: Element, instance: DesignInstanceInfo | undefined, context: ChangeContext): string | undefined {
  if (instance !== undefined) {
    const line = instance.line === undefined || context.pageFile === undefined ? '' : ` at ${context.pageFile}:${String(instance.line)}`;
    return `${instance.component}${line}`;
  }
  // The element's own markers, else the nearest marked ancestor's (an element a gesture made carries none).
  const holder = element.hasAttribute(MARKER_ATTRIBUTE) ? element : element.parentElement?.closest('[' + MARKER_ATTRIBUTE + ']');
  if (holder === null || holder === undefined) {
    return undefined;
  }
  const paths = markerPaths(holder);
  const pagePath = paths.find((path) => !path.includes('|'));
  const source = pagePath === undefined ? undefined : context.sources.get(pagePath);
  if (source !== undefined && context.pageFile !== undefined) {
    return source.line === undefined ? context.pageFile : `${context.pageFile}:${String(source.line)}`;
  }
  const own = paths.find((path) => path.includes('|'));
  return own === undefined ? undefined : own.slice(0, own.lastIndexOf('|'));
}
