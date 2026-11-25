// The editor's comments taken out of a rendering before comparing, and put
// back after the patch, so its paths point at what the page shows now.

import { isAnchor, MORPH_LIMITS, isStamp, asElement, asText, asComment } from './morphNodes';

export type PreviewHost = 'stacki' | 'browser';

export function previewHost(hash: string): PreviewHost {
  return hash === '#avb-design' ? 'stacki' : 'browser';
}

// Markers take no part in the comparison. Their path is an index, so removing
// one node renumbers every marker after it, and a diff that reads them as
// content sees the whole rest of the page change. They are stripped from both
// fetched copies, skipped over in the live page, and put back afterwards.
export function stripAnchors(root: ParentNode): void {
  const gone: Comment[] = [];
  const walk = (parent: ParentNode, depth: number): void => {
    if (depth > MORPH_LIMITS.domDepthMax) {
      throw new Error('the page nests deeper than the patch walks');
    }
    for (let node = parent.firstChild; node; node = node.nextSibling) {
      if (asComment(node) && isAnchor(node)) {
        gone.push(node);
      } else if (asElement(node)) {
        walk(node, depth + 1);
      }
    }
  };
  walk(root, 0);
  for (const node of gone) {
    node.remove();
  }
}

// The marked module graph is shared by every request to Stacki's dev server, including a
// normal browser tab. The app's iframe identifies itself with #avb-design; everywhere else,
// remove Stacki's in-memory addressing once parsing finishes so the ordinary localhost page
// has the DOM the project authored. The module script itself is hoisted into <head>, so it is
// not a body child and removing these markers cannot change layout or structural selectors.
export function stripPreviewInstrumentation(root: ParentNode): void {
  stripAnchors(root);
  const marked = root.querySelectorAll('[data-avb-p],[data-avb-d]');
  for (let index = 0; index < marked.length; index += 1) {
    marked[index]?.removeAttribute('data-avb-p');
    marked[index]?.removeAttribute('data-avb-d');
  }
}

// Markers are comments: invisible to layout, to selectors and to animation, so
// they can be taken out and put back without the page noticing. Done in one
// pass after the content is settled, from a copy of the new rendering that
// still has them, so the editor's paths point at what is on the page now.
export function syncAnchors(liveRoot: ParentNode, serverRoot: ParentNode): void {
  stripAnchors(liveRoot);

  // Whitespace is not content, and is never matched.
  //
  // It used to be: any text node stood for any other. Two renderings of the
  // same page hardly ever have the same number of blank text nodes — the diff
  // above keeps whichever ones it can — so one server blank could be matched
  // against a live blank on the far side of an element, and the cursor came out
  // PAST that element. Every anchor after it then landed a node too late, and
  // when the cursor ran off the end they were appended to the parent instead:
  // a closing marker after the very element it was supposed to close, and a
  // region that swallowed its next sibling whole. On the docs footer that made
  // a clicked line report the comment above it.
  const blank = (node: Node): boolean => (asText(node) ? node.data.trim() === '' : false);
  const sameKind = (left: Node, right: Node): boolean => {
    if (left.nodeType !== right.nodeType) {
      return false;
    }
    if (right.nodeType !== 1) {
      return true;
    }
    return asElement(left) && asElement(right) && left.tagName === right.tagName;
  };

  const walk = (live: ParentNode, server: ParentNode, depth: number): void => {
    if (depth > MORPH_LIMITS.domDepthMax) {
      throw new Error('the page nests deeper than the patch walks');
    }
    let cursor = live.firstChild;
    for (let sv = server.firstChild; sv; sv = sv.nextSibling) {
      const marker = asComment(sv) && isAnchor(sv) ? sv : undefined;
      if (marker) {
        if (!isStamp(marker)) {
          live.insertBefore(document.createComment(marker.data), cursor);
        }
        continue;
      }
      if (blank(sv)) {
        continue;
      }
      let candidate = cursor;
      while (candidate && (blank(candidate) || !sameKind(candidate, sv))) {
        candidate = candidate.nextSibling;
      }
      if (!candidate) {
        continue;
      }
      if (asElement(candidate) && asElement(sv)) {
        walk(candidate, sv, depth + 1);
      }
      cursor = candidate.nextSibling;
    }
  };
  walk(liveRoot, serverRoot, 0);
}

// Every stamp in the live document goes, wherever it was — before <html>, in
// <head>, in the body — and the new rendering's stamps, from anywhere in it,
// are appended to the document itself. A comment is a legal child of a
// document, and no selector, layout or script counts it.
export function syncStamps(liveDocument: Document, serverDocument: Document): void {
  const gone: Comment[] = [];
  const found: string[] = [];
  const collect = (root: Node, into: (comment: Comment) => void): void => {
    const stack: Node[] = [root];
    while (stack.length) {
      const parent = stack.pop();
      if (!parent) {
        break;
      }
      for (let node = parent.firstChild; node; node = node.nextSibling) {
        if (asComment(node) && isStamp(node)) {
          into(node);
        } else if (asElement(node)) {
          stack.push(node);
        }
      }
    }
  };
  collect(liveDocument, (comment) => gone.push(comment));
  collect(serverDocument, (comment) => found.push(comment.data));
  for (const node of gone) {
    node.remove();
  }
  for (const data of found) {
    liveDocument.appendChild(liveDocument.createComment(data));
  }
}

// The dev server's error overlay (`vite-error-overlay`, a child of <body>) stays over a page the patch has just
// brought up to date: it is client-added, so the patch leaves it, and the app then reloaded the whole canvas to
// take it down (docs/canvas-recovery.md), replaying the page's intro for an edit that fixed nothing the page
// needed reloaded for. A rendering the server just produced and the patch applied is the fix the overlay was
// waiting for, so it goes with it. Returns whether one was removed.
export function dismissErrorOverlay(body: HTMLElement): boolean {
  let removed = false;
  for (const child of Array.from(body.children)) {
    if (child.localName === 'vite-error-overlay') {
      child.remove();
      removed = true;
    }
  }
  return removed;
}
