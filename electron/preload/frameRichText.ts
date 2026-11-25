// Rich text typed on the canvas. A double click on the words of a block inside a component whose rich text setting is
// on (the catalog target says `breaks: 'rich'` and names the instance, `richRoot`) makes the element holding the
// instance's blocks editable, so the browser edits real blocks: Enter starts a new paragraph at once, Shift Enter types
// a line break, Enter on an empty list item leaves the list, Backspace in an empty block removes it and returns the
// caret to the block before. A `+` beside an empty block is drawn by the host (`avb:rich-plus`) and its choice comes
// back as `avb:rich-block`. Finishing reads the instance's blocks back as HTML (the frame's bookkeeping attributes and
// markers stripped) and posts one `avb:rich-save`, puts the rendered blocks back, which the host checks and writes as the instance's content: one
// edit, one undo step. Escape puts every block back as it was and posts nothing.
import { assert } from '../../shared/core/assert';
import { pathsOf } from './frameRegions';
import type { RichBlockChoice } from '../../shared/properties/canvasText';

export interface RichTextCallbacks {
  /** Where the `+` goes (the empty block's box in the frame), or nothing when the caret is not in an empty block. */
  readonly plus: (box: { readonly x: number; readonly y: number; readonly w: number; readonly h: number } | undefined) => void;
  /** The instance's content as HTML, posted once when an edit is kept; undefined when nothing changed or it was cancelled. */
  readonly done: (html: string | undefined) => void;
}

/** Elements a session reads back, and the depth it walks a block for, both bounded. */
const RICH_LIMITS = { childrenMax: 2_000, depthMax: 64 } as const;

export function openRichText(block: Element, richRoot: string, at: { readonly clientX: number; readonly clientY: number }, callbacks: RichTextCallbacks) {
  const top = instanceBlock(block, richRoot);
  const container = top?.parentElement;
  if (!top || !(container instanceof HTMLElement) || container.childNodes.length > RICH_LIMITS.childrenMax) {
    return undefined;
  }
  const original = Array.from(container.childNodes);
  const snapshot = original.map((node) => node.cloneNode(true));
  const startHTML = readInstanceHTML(container, original, richRoot);
  const attribute = container.getAttribute('contenteditable');
  container.setAttribute('contenteditable', 'true');
  container.setAttribute('data-avb-text-editor', '');
  document.execCommand('defaultParagraphSeparator', false, 'p');
  const controller = new AbortController();
  const listen = { capture: true, signal: controller.signal };
  let closed = false;
  const finish = (action: 'apply' | 'cancel') => {
    if (closed) {
      return;
    }
    closed = true;
    controller.abort();
    callbacks.plus(undefined);
    const html = action === 'apply' ? readInstanceHTML(container, original, richRoot) : undefined;
    // The blocks go back as the page rendered them, saved or not: the preview's patch knows its own nodes, and a block
    // made here would stay beside the rendered one. A save shows when the page renders it.
    container.replaceChildren(...snapshot);
    if (attribute === null) {
      container.removeAttribute('contenteditable');
    } else {
      container.setAttribute('contenteditable', attribute);
    }
    container.removeAttribute('data-avb-text-editor');
    container.blur();
    callbacks.done(html !== undefined && html !== startHTML ? html : undefined);
  };
  window.addEventListener(
    'keydown',
    (event) => {
      if (!(event.target instanceof Node) || !container.contains(event.target) || event.isComposing) {
        return;
      }
      event.stopImmediatePropagation();
      if (event.key === 'Escape') {
        event.preventDefault();
        finish('cancel');
      } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        finish('apply');
      }
    },
    listen,
  );
  const report = () => callbacks.plus(emptyBlockBox(container));
  document.addEventListener('selectionchange', report, { signal: controller.signal });
  container.addEventListener('input', report, { signal: controller.signal });
  // Leaving focus does not finish: the `+` menu lives in the host, and choosing from it takes focus out of the frame
  // and back. A click elsewhere on the canvas finishes (the session's dismiss), as ⌘/Ctrl Enter does.
  container.focus({ preventScroll: true });
  // The caret where the double click was: focusing an editable element would otherwise put it at the element's start.
  const caret = document.caretRangeFromPoint(at.clientX, at.clientY);
  if (caret && container.contains(caret.startContainer)) {
    caret.collapse(true);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(caret);
  }
  report();
  return {
    finish,
    container,
    /** Says again where the `+` goes, for a host that has rebuilt its catalog. */
    replus: report,
    choose: (choice: RichBlockChoice) => {
      if (!closed) {
        applyRichChoice(container, choice);
        report();
      }
    },
  };
}

// The instance's own block that holds `element`: the highest ancestor whose page path is a direct child of the instance.
function instanceBlock(element: Element, richRoot: string): Element | undefined {
  const own = new RegExp(`^${richRoot.replaceAll('.', '\\.')}\\.\\d+$`);
  let current: Element | undefined = element;
  for (let depth = 0; current && depth < RICH_LIMITS.depthMax; depth++) {
    if (pathsOf(current).some((path) => own.test(path))) {
      return current;
    }
    current = current.parentElement ?? undefined;
  }
  return undefined;
}

/**
 * The instance's blocks as HTML, in order: an element the page gave the instance (a path under it), or anything the
 * session made (not among the children the container started with). What the component itself draws in the same
 * element is left out, so it is never written into the content.
 */
export function readInstanceHTML(container: Element, original: readonly Node[], richRoot: string): string {
  const own = (node: Node) => !original.includes(node) || (node instanceof Element && pathsOf(node).some((path) => path.startsWith(`${richRoot}.`)));
  const parts: string[] = [];
  for (const node of Array.from(container.childNodes)) {
    if (node instanceof Element && own(node)) {
      parts.push(cleanElement(node).outerHTML);
    } else if (node instanceof Text && own(node) && node.data.trim() !== '') {
      parts.push(escapeText(node.data));
    }
  }
  assert(parts.length <= RICH_LIMITS.childrenMax, 'Rich text reads a bounded number of blocks');
  return parts.join('');
}

// A copy without the preview's bookkeeping: its marker comments and the `data-avb-*` and `data-astro-*` attributes and
// the `astro-*` classes the preview and Astro's scoped styles put on rendered elements.
function cleanElement(element: Element): Element {
  const copy = element.cloneNode(true);
  assert(copy instanceof Element, 'A cloned element is an element');
  const all = [copy, ...Array.from(copy.querySelectorAll('*'))];
  for (const node of all) {
    for (const attribute of Array.from(node.attributes)) {
      if (/^data-(?:avb|astro)/.test(attribute.name) || attribute.name === 'contenteditable') {
        node.removeAttribute(attribute.name);
      }
    }
    const kept = Array.from(node.classList).filter((name) => !name.startsWith('astro-'));
    if (node.hasAttribute('class')) {
      if (kept.length === 0) {
        node.removeAttribute('class');
      } else {
        node.setAttribute('class', kept.join(' '));
      }
    }
  }
  const walker = document.createTreeWalker(copy, NodeFilter.SHOW_COMMENT);
  const comments: Node[] = [];
  for (let node = walker.nextNode(); node && comments.length < RICH_LIMITS.childrenMax; node = walker.nextNode()) {
    comments.push(node);
  }
  comments.forEach((comment) => comment.parentNode?.removeChild(comment));
  return copy;
}

function escapeText(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

// The block the caret is in when it holds nothing yet: a direct child of the container, or a list item.
function emptyBlockBox(container: HTMLElement) {
  const selection = window.getSelection();
  if (!selection?.rangeCount || !selection.isCollapsed) {
    return undefined;
  }
  let node: Node | undefined = selection.getRangeAt(0).startContainer;
  for (let depth = 0; node && depth < RICH_LIMITS.depthMax; depth++) {
    if (node instanceof HTMLElement && (node.parentElement === container || node.tagName === 'LI')) {
      const empty = (node.textContent ?? '').trim() === '' && !node.querySelector('img, hr, video') && !['HR', 'IMG', 'VIDEO'].includes(node.tagName);
      if (!empty) {
        return undefined;
      }
      const box = node.getBoundingClientRect();
      return { x: box.left, y: box.top, w: box.width, h: box.height };
    }
    node = node.parentNode ?? undefined;
  }
  return undefined;
}

/** One `+` choice on the block the caret is in, with the browser's own editing commands (its undo history keeps them). */
export function applyRichChoice(container: HTMLElement, choice: RichBlockChoice): void {
  // Focus comes back from the host's menu; the caret it left in the empty block is put back, not reset by the focus.
  const selection = window.getSelection();
  const kept = selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : undefined;
  container.focus({ preventScroll: true });
  if (kept !== undefined && container.contains(kept.startContainer)) {
    selection?.removeAllRanges();
    selection?.addRange(kept);
  }
  switch (choice.kind) {
    case 'block':
      document.execCommand('formatBlock', false, `<${choice.block}>`);
      return;
    case 'list':
      document.execCommand(choice.list === 'ul' ? 'insertUnorderedList' : 'insertOrderedList');
      return;
    case 'rule':
      document.execCommand('insertHTML', false, '<hr><p><br></p>');
      return;
    case 'link': {
      const href = attributeText(choice.href);
      document.execCommand('insertHTML', false, `<a href="${href}">${escapeText(choice.href)}</a>`);
      return;
    }
    case 'media': {
      const address = attributeText(choice.address);
      document.execCommand('insertHTML', false, choice.media === 'image' ? `<img src="${address}" alt="">` : `<video src="${address}" controls></video>`);
      return;
    }
    default: {
      const exhaustive: never = choice;
      return exhaustive;
    }
  }
}

function attributeText(value: string): string {
  return escapeText(value).replaceAll('"', '&quot;');
}
