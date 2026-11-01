import { elementsWithPath, inFocus, pathsOf, runsOf } from '../../../vendor/stacki/electron/preload/frameRegions';

// Stacki queries marker runs as well as tagged elements: fragments, slots and
// text nodes need the same rendered target that its measurement code sees.
export function styleElements(path: string): Element[] {
  const elements = new Set<Element>();
  for (const run of runsOf(path) ?? []) {
    for (const node of run) {
      if (node instanceof Element && node.isConnected && node.tagName !== 'TEMPLATE') {
        elements.add(node);
      }
    }
  }
  for (const element of elementsWithPath(path)) {
    elements.add(element);
  }
  if (elements.size === 0) {
    const descendant = [...document.querySelectorAll('[data-avb-p]')]
      .slice(0, 10_000)
      .find((element) => inFocus(element) && pathsOf(element).some((p) => p.startsWith(path + '.')));
    if (descendant) {
      elements.add(descendant);
    }
  }
  return [...elements];
}

export function textStyleHost(path: string, parent: string | undefined): Element | undefined {
  const runs = runsOf(path) ?? [];
  let visited = 0;
  for (const run of runs) {
    for (const node of run) {
      if (++visited > 10_000) {
        return undefined;
      }
      if (node instanceof Text && node.isConnected && node.data.trim()) {
        return node.parentElement ?? undefined;
      }
    }
  }
  if (runs.length === 0 && parent && path.startsWith(parent + '.') && /^\d+$/.test(path.slice(parent.length + 1))) {
    return elementsWithPath(parent)[0];
  }
  return undefined;
}
