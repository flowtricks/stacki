// Read confirmation from the untouched server document, never the live DOM that
// already contains optimistic edits. One bounded walk serves every pending edit.
export function renderedText(document: Document): ReadonlyMap<string, string | undefined> {
  const values = new Map<string, string | undefined>();
  const walker = document.createTreeWalker(document, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_COMMENT);
  for (let count = 0; count < 50_000; count++) {
    const node = walker.nextNode();
    if (!node) {
      return values;
    }
    if (node instanceof Comment && node.data.startsWith('avb-s:')) {
      const path = node.data.slice(6);
      const text = node.nextSibling;
      const end = text?.nextSibling;
      if (text instanceof Text && end instanceof Comment && end.data === `avb-e:${path}`) {
        recordText(values, path, text.data);
      }
    } else if (node instanceof Element && node.childElementCount === 0) {
      // Slot helpers may remove comments. Only an entirely literal marked parent
      // can confirm this fallback; nested markup must keep its own text regions.
      const paths = node.getAttribute('data-avb-p') ?? '';
      if (paths.length <= 10_000) {
        for (const path of paths.split(' ').filter(Boolean)) {
          recordText(values, path, node.textContent ?? '');
        }
      }
    }
  }
  // An incomplete index cannot prove that all rendered instances agree.
  return new Map();
}

function recordText(values: Map<string, string | undefined>, path: string, text: string) {
  const normalized = text.trim();
  if (values.has(path) && values.get(path) !== normalized) {
    values.set(path, undefined);
  } else if (!values.has(path)) {
    values.set(path, normalized);
  }
}
