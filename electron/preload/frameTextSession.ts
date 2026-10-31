import {
  canvasTextFolded,
  parseCanvasTextCatalog,
  type CanvasTextCatalog,
  type CanvasTextTarget,
} from '../../shared/properties/canvasText';
import { parseCanvasTextClose } from '../../shared/properties/canvasTextOverlay';
import { canvasTextSourceMatches } from './frameRegions';
import { matchCanvasText, type TextMatch } from './frameTextMatch';
import { openNativeText } from './frameTextNative';
import { textSelection } from './frameTextSelection';

interface ActiveText {
  readonly catalog: CanvasTextCatalog;
  readonly editor: NonNullable<ReturnType<typeof openNativeText>>;
}

export function createCanvasTextSession(post: (message: unknown) => void) {
  let catalog: CanvasTextCatalog | undefined;
  let active: ActiveText | undefined;
  const finish = (action: 'apply' | 'cancel') => active?.editor.finish(action);
  return {
    catalog: () => catalog,
    contains: (event: MouseEvent) => active?.editor.contains(event) ?? false,
    dismiss: () => finish('apply'),
    reconcile: () => {
      if (
        active &&
        (!active.editor.intact() ||
          !canvasTextSourceMatches(active.catalog.file, active.catalog.checksum))
      ) {
        finish('cancel');
      }
    },
    receive: (input: unknown) => {
      const request = readCanvasTextRequest(input);
      if (!request) {
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
      const scope = { session: current.session, key: target.key };
      const stopSelection = reportTextSelection(match.nodes, scope, post);
      const editor = openNativeText(
        match,
        event,
        (value) =>
          post({ type: 'avb:text-draft', session: current.session, key: target.key, value }),
        (result) => {
          active = undefined;
          stopSelection();
          // Save precedes inactive so the panel can retain its draft until the
          // source acknowledges it, without flashing the old text on blur.
          commitCanvasText({ catalog: current, target, match }, result, post);
          post({ type: 'avb:text-inactive', session: current.session });
        },
      );
      if (editor) {
        active = { catalog: current, editor };
        post({ type: 'avb:text-active', session: current.session, key: target.key });
      } else {
        stopSelection();
        post({ type: 'avb:text-refused', message: 'This text cannot be edited safely.' });
      }
    },
  };
}

// The selected words, as offsets into the editor's text and a box, whenever
// they change — so the host can offer formatting over them. Only a change is
// posted: dragging a selection fires selectionchange on every pixel.
function reportTextSelection(
  nodes: readonly Text[],
  scope: { readonly session: string; readonly key: string },
  post: (message: unknown) => void,
): () => void {
  let last = '';
  const report = () => {
    const offsets = textSelection(nodes);
    const selection = window.getSelection();
    let range = undefined;
    // Offsets cross folded (canvasTextFolded): the host's text may differ
    // from this one in whitespace alone.
    const text = nodes.map((node) => node.data).join('');
    const start = offsets ? canvasTextFolded(text, offsets.start) : 0;
    const end = offsets ? canvasTextFolded(text, offsets.end) : 0;
    if (start < end && selection?.rangeCount) {
      const box = selection.getRangeAt(0).getBoundingClientRect();
      const rect = { x: box.left, y: box.top, w: box.width, h: box.height };
      range = { start, end, rect };
    }
    const next = range ? JSON.stringify(range) : 'none';
    if (next !== last) {
      last = next;
      post({ type: 'avb:text-selection', ...scope, ...(range ? { range } : {}) });
    }
  };
  document.addEventListener('selectionchange', report);
  return () => {
    document.removeEventListener('selectionchange', report);
    if (last !== '' && last !== 'none') {
      post({ type: 'avb:text-selection', ...scope });
    }
  };
}

function commitCanvasText(
  entry: {
    readonly catalog: CanvasTextCatalog;
    readonly target: CanvasTextTarget;
    readonly match: TextMatch;
  },
  result: { readonly value: string | undefined; readonly restored: boolean },
  post: (message: unknown) => void,
) {
  const { value, restored } = result;
  if (value === undefined || value === entry.target.value) {
    return;
  }
  if (
    !restored ||
    !matchCanvasText(entry.target, entry.match.element) ||
    !canvasTextSourceMatches(entry.catalog.file, entry.catalog.checksum)
  ) {
    post({
      type: 'avb:text-refused',
      message: 'The page changed while editing. The text was not saved; select it again.',
    });
    return;
  }
  post({ type: 'avb:text-save', session: entry.catalog.session, key: entry.target.key, value });
}

function readCanvasTextRequest(input: unknown) {
  try {
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
