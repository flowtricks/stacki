// Changing a component instance's props in a frame: the dev server renders the component again with the new
// props (designBridge.ts requestRender, a read-only route), and the rendering replaces the occurrence's
// elements in that frame only. The instance's slot content is kept as it is in the frame, edits included.
//
// Where the slot content sits: the component is rendered twice with a placeholder in each slot, once with the
// props the frame shows now and once with the new ones. The first rendering has the frame's structure, so the
// placeholder's place in it says which of the frame's nodes are slot content; the second says where they go.
import type { DesignJson } from '../../../../shared/designMode/designModeContract';
import { MARKER_ATTRIBUTE, INSTANCE_ATTRIBUTE, DESIGN_ID_ATTRIBUTE, markerPaths } from '../model/designPrepare';
import { PROPS_ATTRIBUTE, instanceRoots, isElementNode, parseFragment, type ElementIdMint } from '../model/designDom';
import { DESIGN_LIMITS, type DesignInstanceInfo } from '../model/designTypes';
import { requestRender, requestPreview, type BridgeResult } from './designBridge';

const SLOT_TAG = 'dm-slot';
const SLOT_NAME = 'data-dm-slot';

/** The props an occurrence renders with now: the ones Design mode set, else the page's own. */
export function currentProps(document: Document, key: string, info: DesignInstanceInfo): Readonly<Record<string, DesignJson>> {
  const root = instanceRoots(document, key)[0];
  const json = root?.getAttribute(PROPS_ATTRIBUTE);
  if (json === null || json === undefined) {
    return info.props;
  }
  try {
    const parsed: unknown = JSON.parse(json);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? Object.fromEntries(Object.entries(parsed)) : info.props;
  } catch {
    return info.props;
  }
}

function placeholders(info: DesignInstanceInfo): Readonly<Record<string, string>> {
  return Object.fromEntries(info.slots.map((name) => [name, `<${SLOT_TAG} ${SLOT_NAME}="${name}"></${SLOT_TAG}>`]));
}

function renderBody(info: DesignInstanceInfo, props: Readonly<Record<string, DesignJson>>) {
  // The page path rides along as the canvas marker does, so the new roots name the same page node.
  const marked = info.path === '' ? props : { ...props, [MARKER_ATTRIBUTE]: info.path };
  return { component: info.component, props: marked, slots: placeholders(info) };
}

export type RerenderPlan =
  { readonly ok: true; readonly apply: (document: Document, mint: ElementIdMint) => readonly Element[] } | { readonly ok: false; readonly detail: string };

/**
 * Renders an occurrence with `nextProps` and answers how to put it in the frame. The render runs first (it is
 * asynchronous); `apply` then changes the document synchronously, inside one undo step.
 */
export async function planRerender(
  document: Document,
  key: string,
  info: DesignInstanceInfo,
  nextProps: Readonly<Record<string, DesignJson>>,
): Promise<RerenderPlan> {
  const now = currentProps(document, key, info);
  const [shown, next] = await Promise.all([
    info.slots.length === 0 ? Promise.resolve<BridgeResult<string>>({ ok: true, value: '' }) : requestRender(renderBody(info, now)),
    requestRender(renderBody(info, nextProps)),
  ]);
  if (!next.ok) {
    return { ok: false, detail: next.detail === '' ? next.reason : next.detail };
  }
  const shownHTML = shown.ok ? shown.value : '';
  const nextHTML = next.value;
  return {
    ok: true,
    apply: (target, mint) => {
      const roots = instanceRoots(target, key);
      if (roots.length === 0) {
        return [];
      }
      const slotContent = info.slots.length === 0 || shownHTML === '' ? new Map<string, readonly Node[]>() : locateSlots(target, roots, shownHTML);
      const fragment = parseFragment(target, nextHTML);
      fillSlots(fragment, slotContent);
      const tops = [...fragment.children];
      keepIds(roots, tops, mint);
      for (const top of tops) {
        top.setAttribute(INSTANCE_ATTRIBUTE, key);
        top.setAttribute(PROPS_ATTRIBUTE, JSON.stringify(nextProps));
      }
      const first = roots[0];
      const parent = first?.parentNode;
      if (first === undefined || parent === null || parent === undefined) {
        return [];
      }
      parent.insertBefore(fragment, first);
      for (const root of roots) {
        root.remove();
      }
      return tops;
    },
  };
}

/** The element-index path from a fragment's top to `node`, and the element siblings around it. */
function placeOf(node: Element, top: ParentNode): { readonly trail: readonly number[]; readonly before: number; readonly after: number } | undefined {
  const trail: number[] = [];
  let at: Element = node;
  for (let depth = 0; depth < DESIGN_LIMITS.elementsMax; depth += 1) {
    const parent = at.parentElement;
    if (parent === null) {
      if (at.parentNode !== top) {
        return undefined;
      }
      trail.unshift([...top.children].indexOf(at));
      break;
    }
    trail.unshift([...parent.children].indexOf(at));
    at = parent;
  }
  const siblings = [...(node.parentElement?.children ?? top.children)];
  const index = siblings.indexOf(node);
  // Elements before the placeholder count from the start, elements after it from the end: the slot's own
  // elements sit between them in the frame, however many there are.
  return { trail, before: index, after: siblings.length - 1 - index };
}

/** For each slot, the frame's nodes that fill it, found through the placeholder's place in a rendering of the frame's props. */
function locateSlots(document: Document, roots: readonly Element[], shownHTML: string): Map<string, readonly Node[]> {
  const located = new Map<string, readonly Node[]>();
  const shown = parseFragment(document, shownHTML);
  for (const placeholder of shown.querySelectorAll(SLOT_TAG)) {
    const name = placeholder.getAttribute(SLOT_NAME) ?? 'default';
    const place = placeOf(placeholder, shown);
    if (place === undefined || place.trail.length === 0) {
      continue;
    }
    // Walk the same element path in the frame, starting from the occurrence's roots.
    let parent: Element | undefined;
    let siblings: readonly Element[] = roots;
    for (const index of place.trail.slice(0, -1)) {
      parent = siblings[index];
      siblings = parent === undefined ? [] : [...parent.children];
    }
    if (parent === undefined) {
      continue; // A slot at the top of the component: its content is the roots' siblings, which never move.
    }
    if (siblings.length < place.before + place.after) {
      continue; // The frame no longer has the component's structure here (an element was deleted): the slot is not guessed.
    }
    const nodes: Node[] = [];
    const startAfter = place.before === 0 ? undefined : siblings[place.before - 1];
    const stopAt = place.after === 0 ? undefined : siblings[siblings.length - place.after];
    let collecting = startAfter === undefined;
    for (const child of [...parent.childNodes]) {
      if (child === stopAt) {
        break;
      }
      if (collecting) {
        nodes.push(child);
      }
      if (child === startAfter) {
        collecting = true;
      }
    }
    located.set(name, nodes);
  }
  return located;
}

function fillSlots(fragment: DocumentFragment, content: ReadonlyMap<string, readonly Node[]>): void {
  for (const placeholder of [...fragment.querySelectorAll(SLOT_TAG)]) {
    const nodes = content.get(placeholder.getAttribute(SLOT_NAME) ?? 'default') ?? [];
    placeholder.replaceWith(...nodes);
  }
}

/**
 * The new elements take the design ids of the ones they replace where the component's own markers match
 * (same file, same node), so a gesture's selection and the hand-off's comparison follow them; inline styles
 * the person gave those elements are carried over. Everything else gets a fresh id.
 */
function keepIds(roots: readonly Element[], tops: readonly Element[], mint: ElementIdMint): void {
  const old = new Map<string, Element>();
  for (const root of roots) {
    for (const element of [root, ...root.querySelectorAll('[' + MARKER_ATTRIBUTE + ']')]) {
      const own = markerPaths(element).find((path) => path.includes('|'));
      if (own !== undefined && !old.has(own)) {
        old.set(own, element);
      }
    }
  }
  tops.forEach((top, index) => {
    for (const element of [top, ...top.querySelectorAll('*')].slice(0, DESIGN_LIMITS.elementsMax)) {
      if (element.hasAttribute(DESIGN_ID_ATTRIBUTE)) {
        continue; // Slot content moved in keeps its own id.
      }
      const own = markerPaths(element).find((path) => path.includes('|'));
      const match = own === undefined ? (element === top ? roots[index] : undefined) : old.get(own);
      const id = match?.getAttribute(DESIGN_ID_ATTRIBUTE);
      element.setAttribute(DESIGN_ID_ATTRIBUTE, id ?? mint.mint());
      const style = match?.getAttribute('style');
      if (style !== null && style !== undefined && !element.hasAttribute('style')) {
        element.setAttribute('style', style);
      }
    }
  });
}

/** A component's palette preview as markup and the styles its page carried, for inserting it into a frame. */
export async function componentMarkup(component: string): Promise<BridgeResult<{ readonly html: string; readonly styles: readonly string[] }>> {
  const page = await requestPreview(component);
  if (!page.ok) {
    return page;
  }
  const parsed = new DOMParser().parseFromString(page.value, 'text/html');
  const stage = parsed.getElementById('avb-stage');
  if (stage === null || stage.innerHTML.trim() === '') {
    return { ok: false, reason: 'failed', detail: 'empty preview' };
  }
  // Styles a component renders inline (Astro puts a component's scoped styles beside it in a preview) go to the
  // frame's head with the page's: the markup inserted is the component's elements only.
  const styles = [...parsed.querySelectorAll('style, link[rel~="stylesheet"]')]
    .filter((element) => !(element.tagName === 'STYLE' && (element.textContent ?? '').includes('#avb-stage')))
    .map((element) => element.outerHTML);
  for (const inline of stage.querySelectorAll('style, link, script')) {
    inline.remove();
  }
  return { ok: true, value: { html: stage.innerHTML, styles } };
}

/** Adds the styles an inserted component needs to a frame's head, once each. */
export function addHeadStyles(document: Document, styles: readonly string[]): void {
  const head = document.head;
  if (head === null) {
    return;
  }
  const present = new Set([...head.querySelectorAll('style, link')].map((element) => element.outerHTML));
  for (const style of styles) {
    if (present.has(style)) {
      continue;
    }
    const template = document.createElement('template');
    template.innerHTML = style;
    const element = template.content.firstElementChild;
    if (isElementNode(element)) {
      element.setAttribute('data-dm-added', '');
      head.append(element);
      present.add(style);
    }
  }
}
