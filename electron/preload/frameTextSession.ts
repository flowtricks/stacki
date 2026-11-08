import { assert } from '../../shared/core/assert';
import { canvasTextFolded, parseCanvasTextCatalog, type CanvasTextCatalog, type CanvasTextTarget } from '../../shared/properties/canvasText';
import { parseCanvasTextClose, parseCanvasTextFocus } from '../../shared/properties/canvasTextOverlay';
import { canvasTextSourceMatches, pathsOf } from './frameRegions';
import { matchCanvasText, textRunsAround, type TextMatch, type TextRun } from './frameTextMatch';
import { openNativeText, type NativeTextResult } from './frameTextNative';
import { textEditorRoot, textSelection, type TextOffsets } from './frameTextSelection';

interface ActiveText {
  readonly catalog: CanvasTextCatalog;
  readonly editor: NonNullable<ReturnType<typeof openNativeText>>;
}

export function createCanvasTextSession(post: (message: unknown) => void) {
  let catalog: CanvasTextCatalog | undefined;
  let active: ActiveText | undefined;
  // What is being typed in, and where: its words may no longer match the catalog's.
  let typing: { readonly key: string; readonly element: Element } | undefined;
  let focus: ReadonlySet<string> = new Set();
  const finish = (action: 'apply' | 'cancel') => active?.editor.finish(action);
  return {
    catalog: () => catalog,
    focus: () => focus, // The selected node's page path.
    editing: () => (active ? typing?.key : undefined),
    editingElement: () => (active ? typing?.element : undefined),
    contains: (event: MouseEvent) => active?.editor.contains(event) ?? false,
    dismiss: () => finish('apply'),
    reconcile: () => {
      if (active && stale(active)) {
        finish('cancel');
      }
    },
    receive: (input: unknown) => {
      const request = readCanvasTextRequest(input);
      if (!request) {
        return;
      }
      if (request.kind === 'focus') {
        focus = new Set(request.value.paths);
        return;
      }
      if (request.kind === 'close') {
        if (active?.catalog.session === request.value.session) {
          finish(request.value.action);
        }
        return;
      }
      if (catalog?.session !== request.value.session) {
        finish('cancel');
      }
      catalog = request.value;
    },
    open: (target: CanvasTextTarget, match: TextMatch, event: MouseEvent) => {
      finish('apply');
      const current = catalog;
      if (!current) {
        return;
      }
      const opened = { target, match };
      const runs = textRunsAround(current, opened);
      const space = { runs: runs.map((run) => run.match.nodes), primary: runs.indexOf(opened) };
      let stopSelection = () => {};
      const editor = openNativeText(match, space, event, {
        changed: (value) => post({ type: 'avb:text-draft', session: current.session, key: target.key, value }),
        refused: () => post({ type: 'avb:text-refused', message: 'This selection reaches text that cannot be changed along with it.' }),
        done: (result) => {
          active = undefined;
          stopSelection();
          // Save precedes inactive so the panel can retain its draft until the
          // source acknowledges it, without flashing the old text on blur.
          commitCanvasText({ catalog: current, runs }, result, post);
          post({ type: 'avb:text-inactive', session: current.session });
        },
      });
      if (editor) {
        active = { catalog: current, editor };
        typing = { key: target.key, element: match.element };
        stopSelection = reportTextSelection({ catalog: current, opened, root: textEditorRoot(match), editor }, post);
        post({ type: 'avb:text-active', session: current.session, key: target.key });
      } else {
        post({ type: 'avb:text-refused', message: 'This text cannot be edited safely.' });
      }
    },
  };
}

// An open editor whose text the page replaced, or whose source moved on.
function stale(active: ActiveText): boolean {
  if (!active.editor.intact()) {
    return true;
  }
  return !canvasTextSourceMatches(active.catalog.file, active.catalog.checksum);
}

// The selected words, as offsets into the text that holds them and a box,
// whenever they change — so the host can offer formatting over them. Only a
// change is posted: dragging a selection fires selectionchange on every pixel.
//
// The words may sit in the opened text or in other literal text of the same
// editor that inline markup sets apart: "visually" in `Edit <strong>visually</strong>`
// is its own text, and selecting it must offer the bar with Bold lit, or bold
// words could never be unbolded on the canvas. Nothing is offered once words
// changed in a run the press would not save: a press closes the editor and
// saves the selected text alone, which would lose them.
function reportTextSelection(
  context: {
    readonly catalog: CanvasTextCatalog;
    readonly opened: TextRun;
    readonly root: HTMLElement | undefined;
    readonly editor: { readonly spread: () => boolean; readonly edited: () => boolean };
  },
  post: (message: unknown) => void,
): () => void {
  const session = context.catalog.session;
  let last = '';
  let lastKey = context.opened.target.key;
  const report = () => {
    const selection = window.getSelection();
    const held = selectedText(context);
    let range = undefined;
    if (held && selection?.rangeCount) {
      // Offsets cross folded (canvasTextFolded): the host's text may differ
      // from this one in whitespace alone.
      const text = held.nodes.map((node) => node.data).join('');
      const start = canvasTextFolded(text, held.offsets.start);
      const end = canvasTextFolded(text, held.offsets.end);
      if (start < end) {
        const box = selection.getRangeAt(0).getBoundingClientRect();
        range = { start, end, rect: { x: box.left, y: box.top, w: box.width, h: box.height } };
      }
    }
    const key = held && range ? held.key : lastKey;
    const next = range ? JSON.stringify({ key, range }) : 'none';
    if (next !== last) {
      last = next;
      lastKey = key;
      post({ type: 'avb:text-selection', session, key, ...(range ? { range } : {}) });
    }
  };
  document.addEventListener('selectionchange', report);
  return () => {
    document.removeEventListener('selectionchange', report);
    if (last !== '' && last !== 'none') {
      post({ type: 'avb:text-selection', session, key: lastKey });
    }
  };
}

interface SelectedText {
  readonly key: string;
  readonly nodes: readonly Text[];
  readonly offsets: TextOffsets;
}

// Which literal text holds the whole selection, and where in it. The opened
// text first; otherwise another text inside the editor, found the way a
// double click finds one, and only while nothing has been typed.
function selectedText(context: Parameters<typeof reportTextSelection>[0]): SelectedText | undefined {
  const { opened, editor } = context;
  const own = textSelection(opened.match.nodes);
  if (own) {
    return editor.spread() ? undefined : { key: opened.target.key, nodes: opened.match.nodes, offsets: own };
  }
  if (editor.edited()) {
    return undefined;
  }
  const selection = window.getSelection();
  const container = selection?.rangeCount ? selection.getRangeAt(0).startContainer : undefined;
  if (!(container instanceof Text) || !container.parentElement || !context.root?.contains(container)) {
    return undefined;
  }
  const target = innerTextTarget(context.catalog, container);
  if (!target) {
    return undefined;
  }
  assert(target.match.nodes.includes(container), 'The found text holds the selection start');
  const offsets = textSelection(target.match.nodes);
  return offsets ? { key: target.target.key, nodes: target.match.nodes, offsets } : undefined;
}

// The literal catalog text whose words include `node`. The catalog is bounded
// by its parser and the ancestor walk by a fixed depth.
function innerTextTarget(catalog: CanvasTextCatalog, node: Text): TextRun | undefined {
  const element = node.parentElement;
  assert(element !== null, 'A selected text sits in an element');
  const ancestors = new Set<string>();
  let current: Element | undefined = element;
  for (let depth = 0; current && depth < 32; depth++) {
    pathsOf(current).forEach((path) => ancestors.add(path));
    current = current.parentElement ?? undefined;
  }
  for (const target of catalog.targets) {
    if (target.literal !== true || !ancestors.has(target.parent)) {
      continue;
    }
    if (target.scope !== undefined && !ancestors.has(target.scope)) {
      continue;
    }
    const match = matchCanvasText(target, element);
    if (match?.nodes.includes(node)) {
      return { target, match };
    }
  }
  return undefined;
}

function commitCanvasText(
  entry: {
    readonly catalog: CanvasTextCatalog;
    readonly runs: readonly TextRun[];
  },
  result: NativeTextResult,
  post: (message: unknown) => void,
) {
  const edits = result.changes.flatMap(({ run, value }) => {
    const entryRun = entry.runs[run];
    assert(entryRun !== undefined, 'A changed run is one of the editor runs');
    return value === entryRun.target.value ? [] : [{ run: entryRun, value }];
  });
  const [first, ...also] = edits;
  if (!first) {
    return;
  }
  const unchanged = edits.every(({ run }) => matchCanvasText(run.target, run.match.element));
  if (!result.restored || !unchanged || !canvasTextSourceMatches(entry.catalog.file, entry.catalog.checksum)) {
    post({
      type: 'avb:text-refused',
      message: 'The page changed while editing. The text was not saved; select it again.',
    });
    return;
  }
  // One message for every run: they are one edit, and must land or fail together.
  post({
    type: 'avb:text-save',
    session: entry.catalog.session,
    key: first.run.target.key,
    value: first.value,
    ...(also.length ? { also: also.map(({ run, value }) => ({ key: run.target.key, value })) } : {}),
  });
  // Until the preview renders the saved source, the page keeps showing what was typed.
  result.keep();
}

function readCanvasTextRequest(input: unknown) {
  try {
    const focus = parseCanvasTextFocus(input);
    if (focus) {
      return { kind: 'focus', value: focus } as const;
    }
    const close = parseCanvasTextClose(input);
    if (close) {
      return { kind: 'close', value: close } as const;
    }
    return { kind: 'catalog', value: parseCanvasTextCatalog(input) } as const;
  } catch {
    // Ignore other protocols and malformed data before running trusted control flow.
    return undefined;
  }
}
