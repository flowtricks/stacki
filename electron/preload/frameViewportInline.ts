import { assert } from '../../shared/core/assert';
import { freezeViewportValue } from './frameViewportUnits';

const INLINE_ELEMENTS_MAX = 20_000;
const INLINE_PROPERTIES_MAX = 512;

// These documents are the non-editable full-page canvas copies. Only their live
// DOM changes; the project's source and normal editable preview stay untouched.
export function freezeInlineViewport(report: () => void): void {
  freezeInlineTree(document.documentElement);
  new MutationObserver((records) => {
    assert(records.length <= INLINE_ELEMENTS_MAX, 'Viewport: inline mutation limit exceeded');
    let changed = false;
    for (const record of records) {
      if (record.type === 'attributes' && record.target instanceof Element) {
        changed = freezeInlineElement(record.target) || changed;
      } else {
        assert(record.addedNodes.length <= INLINE_ELEMENTS_MAX, 'Viewport: added node limit');
        for (const node of Array.from(record.addedNodes)) {
          if (node instanceof Element) {
            changed = freezeInlineTree(node) || changed;
          }
        }
      }
    }
    if (changed) {
      report();
    }
  }).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['style'],
    childList: true,
    subtree: true,
  });
}

function freezeInlineTree(root: Element): boolean {
  const elements = root.querySelectorAll('[style]');
  assert(elements.length <= INLINE_ELEMENTS_MAX, 'Viewport: inline element limit exceeded');
  let changed = freezeInlineElement(root);
  for (const element of Array.from(elements)) {
    changed = freezeInlineElement(element) || changed;
  }
  return changed;
}

function freezeInlineElement(element: Element): boolean {
  const view = element.ownerDocument.defaultView;
  if (!view) {
    return false;
  }
  if (!(element instanceof view.HTMLElement || element instanceof view.SVGElement)) {
    return false;
  }
  const style = element.style;
  assert(style.length <= INLINE_PROPERTIES_MAX, 'Viewport: inline property limit exceeded');
  let changed = false;
  for (let index = 0; index < style.length; index++) {
    const property = style.item(index);
    const value = style.getPropertyValue(property);
    const next = freezeViewportValue(value);
    if (next !== value) {
      style.setProperty(property, next, style.getPropertyPriority(property));
      changed = true;
    }
  }
  return changed;
}
