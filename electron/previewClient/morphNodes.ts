// The node kinds the patch tells apart, and the editor's own comments in a
// page — node markers and rendering stamps — which take no part in comparing
// renderings.

// A <template> marker is an element, and the page removes those from itself on
// load, so they are taken out of the fetched copies too — otherwise they are
// nodes on one side with nothing to match on the other.
//
// The comment markers are left in place, and they are what makes this safe.
// They wrap every node the editor knows about, they carry its path, and they
// sit in the live document as well as in both fetched ones. Matching walks
// from one to the next, so it can never drift onto the wrong element the way
// guessing from tag names does.
export function stripTemplateMarkers(root: ParentNode): void {
  const gone = root.querySelectorAll('template[data-avb-s],template[data-avb-e]');
  for (let i = 0; i < gone.length; i++) {
    const node = gone[i];
    if (node) {
      node.remove();
    }
  }
}

// A fetched rendering is parsed by DOMParser, and a DOMParser document has
// scripting disabled. The one place the HTML parser builds a different tree
// for that is <noscript>: with scripting on — the canvas — its markup is raw
// text and the element has one text child; with scripting off its markup is
// parsed into real elements. Those elements are harmless in the parsed copy,
// which renders nothing, and live the moment the patch imports them into the
// canvas: a <style> inside a <noscript> becomes a stylesheet, a nav fallback
// that shows the menu applies, and the page looks like it has no JavaScript.
//
// So every parsed rendering is put in the shape the canvas parser gave the
// page: each <noscript> holds its markup as one text node, exactly as the
// live one does. Then nothing the patch inserts can carry live noscript
// content, and the previous and next renderings compare like for like with
// the live page. The text is the markup as serialized, which is the source
// for everything except attribute quoting and character references. Run it
// once per parse: a flattened <noscript> serializes its text escaped, so a
// second pass would turn `<style>` into `&lt;style&gt;`.
export function inertNoscripts(page: ParentNode): void {
  const found = page.querySelectorAll('noscript');
  // Document order puts an outer <noscript> first; flattening it detaches any
  // inner one, so a later turn only rewrites a node that is no longer in the page.
  for (let index = 0; index < found.length; index++) {
    const element = found[index];
    if (element !== undefined) {
      const markup = element.innerHTML;
      element.textContent = markup;
      if (element.childNodes.length > 1) {
        throw new Error('a <noscript> kept more than its text');
      }
    }
  }
  const left = page.querySelectorAll('noscript *');
  if (left.length > 0) {
    throw new Error('a <noscript> still holds elements');
  }
}

// Every comment the editor puts in a page: the node markers (`avb-s:`,
// `avb-e:`) and each marked file's stamp (`avb-d:`, the bytes it was marked
// from — shared/page/previewToken.ts). None of them is content, and none takes part
// in the comparison.
export const isAnchor = (node: Node | undefined): boolean => {
  const comment = node !== undefined && asComment(node) ? node : undefined;
  return comment !== undefined && /^avb-[sed]:/.test(comment.data);
};

// How deep the patch walks a page. An HTML parser stops nesting elements at
// 512 (Chromium's limit), so a deeper tree did not come from the file's
// markup; the patch gives up on it and the page reloads instead. Kept inside
// the part of this file the tests lift out, which starts at `isAnchor`.
export const MORPH_LIMITS = { domDepthMax: 512 } as const;

// A stamp says which rendering the page is, not where a node is, so it is not
// put back beside its neighbours: the patch gathers every stamp of the new
// rendering at the document's end (syncStamps), where the canvas reads its
// manifest from. Left where it was, a stamp in <head> or before <html> would
// outlive the rendering it named, and the canvas would vouch for bytes the
// page no longer shows.
export const isStamp = (node: Node | undefined): boolean => {
  const comment = node !== undefined && asComment(node) ? node : undefined;
  return comment !== undefined && comment.data.startsWith('avb-d:');
};

export const asElement = (node: Node): node is Element => node.nodeType === 1;
export const asText = (node: Node): node is Text => node.nodeType === 3;
export const asComment = (node: Node): node is Comment => node.nodeType === 8;
export const asDocument = (node: Node): node is Document => node.nodeType === 9;
