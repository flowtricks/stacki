import { cmsTransport } from '../../ipc/editorEnvironment';
import type { CanvasTextEdit } from './canvasTextSource';
import { useEffect, useRef, type RefObject } from 'react';
import {
  canvasTextUnfolded,
  parseCanvasTextEvent,
  type CanvasTextCatalog,
} from '../../../shared/properties/canvasText';
import {
  applyCanvasText,
  canvasTextNodes,
  canvasTextPlans,
  type CanvasSourceNode,
} from './canvasTextSource';
import { createCanvasTextOverlay } from './canvasTextOverlay';
import {
  parseCanvasTextOverlay,
  parseCanvasTextSelection,
  type CanvasTextSelection,
  type CanvasTextSelectionRange,
} from '../../../shared/properties/canvasTextOverlay';
import {
  canvasTextSelection,
  clearCanvasTextSelection,
  type CanvasFormatAction,
  type CanvasFormatState,
} from './canvasTextSelection';
import { canvasTextDraft, clearCanvasTextDraft } from '../../ui/canvasTextDraft';

export interface CanvasTextDocument {
  readonly projectPath: string;
  readonly file: string;
  readonly source: string;
  readonly nodes: readonly CanvasSourceNode[];
  readonly pathFor: (id: string) => string | undefined;
  readonly apply: (source: string, position: number) => Promise<void>;
  readonly report: (message: string) => void;
  readonly loadContent: (document: CanvasTextDocument) => Promise<readonly CanvasTextEdit[]>;
  /** The Content field's formatting, for words selected on the canvas. Absent: no bar. */
  readonly format?: CanvasTextFormatter | undefined;
}
export interface CanvasTextFormatter {
  /** The lit buttons for a text node, or undefined when it cannot be formatted. */
  readonly states: (textId: string) => CanvasFormatState | undefined;
  /** One press over [start, end) of the text, which reads `value`. False: nothing changed. */
  readonly apply: (
    textId: string,
    selection: { readonly start: number; readonly end: number; readonly value: string },
    action: CanvasFormatAction,
  ) => boolean;
}
interface Options {
  readonly document: CanvasTextDocument | undefined;
  readonly frame: RefObject<HTMLIFrameElement>;
  readonly url: string | undefined;
  readonly post: (message: unknown) => void;
  readonly subscribeLoad: (listener: () => void) => () => void;
}

export function useCanvasText(options: Options): void {
  const current = useRef(options);
  current.current = options;
  const document = options.document;
  const file = document?.file;
  const source = document?.source;
  useEffect(() => startCanvasText(current), [file, source]);
}

function startCanvasText(current: RefObject<Options>) {
  const initial = current.current?.document;
  if (!initial) {
    return;
  }
  const session = crypto.randomUUID();
  let disposed = false;
  let catalog: CanvasTextCatalog | undefined;
  let plans: readonly CanvasTextEdit[] = [];
  let revision = 0;
  const overlay = createCanvasTextOverlay({
    target: (key) => plans.find((plan) => plan.target.key === key)?.target,
    post: (message) => current.current?.post(message),
  });
  const send = () => catalog && current.current?.post(catalog);
  const refresh = () => {
    revision = (revision + 1) % 1_000_000;
    const version = revision;
    overlay.closeContent();
    void publishCanvasTextSession(initial, session, version, (ready) => {
      if (!disposed && version === revision) {
        plans = ready.plans;
        catalog = ready.catalog;
        send();
      }
    }).catch((error: unknown) => initial.report(String(error)));
  };
  refresh();
  const unsubscribeContent = cmsTransport.onCmsChanged(refresh);
  const unsubscribe = current.current?.subscribeLoad(send);
  const receive = createCanvasTextReceiver({
    current,
    initial,
    session,
    overlay,
    plans: () => plans,
  });
  window.addEventListener('message', receive);
  return () => {
    disposed = true;
    overlay.close();
    clearCanvasTextDraft(session);
    clearCanvasTextSelection(session);
    unsubscribeContent();
    if (catalog) {
      current.current?.post({ ...catalog, session: crypto.randomUUID(), targets: [] });
    }
    unsubscribe?.();
    window.removeEventListener('message', receive);
  };
}

interface CanvasTextReceiverOptions {
  readonly current: RefObject<Options>;
  readonly initial: CanvasTextDocument;
  readonly session: string;
  readonly overlay: ReturnType<typeof createCanvasTextOverlay>;
  readonly plans: () => readonly CanvasTextEdit[];
}

function createCanvasTextReceiver(options: CanvasTextReceiverOptions) {
  let busy = false;
  // A formatting press owns the session from the press until the editor
  // closes: its own edit carries the typed text, so the save the editor posts
  // on its way out would be a second, conflicting write of the same words.
  const takeover: Takeover = { key: undefined, linking: false };
  const nodes = new Map(
    canvasTextNodes(options.initial.nodes).map(({ node }) => [
      node.id ? options.initial.pathFor(node.id) : undefined,
      node,
    ]),
  );
  return (event: MessageEvent<unknown>) => {
    const message = canvasTextSessionMessage(event, options);
    if (!message) {
      return;
    }
    if (message.type === 'avb:text-active' || message.type === 'avb:text-inactive') {
      options.overlay.receive(message);
      if (!busy) {
        clearCanvasTextDraft(options.session);
      }
      if (message.type === 'avb:text-inactive' && !takeover.linking) {
        takeover.key = undefined;
        clearCanvasTextSelection(options.session);
      }
      return;
    }
    if (busy || message.key === takeover.key) {
      return;
    }
    if (message.type === 'avb:text-selection') {
      receiveCanvasSelection(message, { ...options, nodes, takeover });
      return;
    }
    const plan = options.plans().find((entry) => entry.target.key === message.key);
    if (!plan) {
      return;
    }
    if (message.type === 'avb:text-draft') {
      const node = nodes.get(plan.target.path);
      if (node?.id && node.value !== undefined) {
        canvasTextDraft.set({
          session: options.session,
          projectPath: options.initial.projectPath,
          file: options.initial.file,
          nodeID: node.id,
          sourceValue: node.value,
          value: message.value,
        });
      }
      return;
    }
    busy = true;
    const draft = canvasTextDraft.get();
    void plan
      .apply(message.value)
      .catch((error: unknown) => options.initial.report(String(error)))
      .finally(() => {
        busy = false;
        if (canvasTextDraft.get() === draft) {
          clearCanvasTextDraft(options.session);
        }
      });
  };
}

function canvasTextSessionMessage(
  event: MessageEvent<unknown>,
  options: CanvasTextReceiverOptions,
) {
  const host = options.current.current;
  const message = canvasTextMessage(event, host ?? undefined);
  if (!message || !host) {
    return undefined;
  }
  if (message.type === 'avb:text-refused') {
    options.initial.report(message.message);
    return undefined;
  }
  if (message.session !== options.session) {
    return undefined;
  }
  if (
    host.document?.source !== options.initial.source ||
    host.document.file !== options.initial.file
  ) {
    return undefined;
  }
  return message;
}

function canvasTextMessage(event: MessageEvent<unknown>, host: Options | undefined) {
  if (
    !host?.url ||
    event.source !== host.frame.current?.contentWindow ||
    event.origin !== new URL(host.url).origin
  ) {
    return undefined;
  }
  try {
    return (
      parseCanvasTextEvent(event.data) ??
      parseCanvasTextOverlay(event.data) ??
      parseCanvasTextSelection(event.data)
    );
  } catch {
    return undefined;
  }
}

async function publishCanvasTextSession(
  document: CanvasTextDocument,
  session: string,
  revision: number,
  publish: (ready: {
    readonly plans: readonly CanvasTextEdit[];
    readonly catalog: CanvasTextCatalog;
  }) => void,
) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(document.source));
  const checksum = Array.from(new Uint8Array(hash), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  const literal = canvasTextPlans(document.source, document.nodes, document.pathFor);
  const plans: readonly CanvasTextEdit[] = [
    ...literal.map((plan) => ({
      target: plan.target,
      apply: (value: string) =>
        document.apply(applyCanvasText(document.source, plan, value), plan.start),
    })),
  ];
  const catalog: CanvasTextCatalog = {
    type: 'avb:text-catalog',
    session,
    file: document.file,
    checksum,
    targets: plans.map((plan) => plan.target).slice(0, 2_000),
  };
  publish({ plans, catalog });
  const content = await document.loadContent(document);
  if (content.length) {
    // CMS refreshes invalidate only CMS tickets. Literal editing keeps its focus
    // while scans run; an old CMS commit cannot pick up a newer entry snapshot.
    const refreshed = content.map((plan) => ({
      ...plan,
      target: { ...plan.target, key: `cms:${revision}:${plan.target.key}` },
    }));
    const combined = [...plans, ...refreshed].slice(0, 2_000);
    publish({
      plans: combined,
      catalog: { ...catalog, targets: combined.map((plan) => plan.target) },
    });
  }
}

interface Takeover {
  key: string | undefined;
  linking: boolean;
}

interface CanvasSelectionOptions extends CanvasTextReceiverOptions {
  readonly nodes: ReadonlyMap<string | undefined, CanvasSourceNode>;
  readonly takeover: Takeover;
}

// Publishes the selection to the formatting bar, with what each press does.
// Literal text only: a shared variable or CMS field is one value used in many
// places, and markup inside it is not this element's to add.
function receiveCanvasSelection(message: CanvasTextSelection, options: CanvasSelectionOptions) {
  const { initial, session, takeover } = options;
  const plan = options.plans().find((entry) => entry.target.key === message.key);
  const node = plan ? options.nodes.get(plan.target.path) : undefined;
  const range = message.range;
  const format = initial.format;
  if (!range || !plan || !node?.id || node.kind !== 'text' || !format) {
    clearCanvasTextSelection(session);
    return;
  }
  const states = format.states(node.id);
  const frame = options.current.current?.frame.current;
  if (!states || !frame || message.key.startsWith('cms:')) {
    clearCanvasTextSelection(session);
    return;
  }
  const textId = node.id;
  const typed = () => {
    const draft = canvasTextDraft.get();
    return draft?.session === session && draft.nodeID === textId ? draft.value : plan.target.value;
  };
  const takeOver = () => {
    const value = typed();
    takeover.key = message.key;
    options.current.current?.post({ type: 'avb:text-close', session, action: 'cancel' });
    // The frame counts shown characters; this text may space them differently.
    const start = canvasTextUnfolded(value, range.start, 'start');
    const end = canvasTextUnfolded(value, range.end, 'end');
    return { start: start ?? 0, end: end ?? 0, value };
  };
  const release = () => {
    takeover.linking = false;
    takeover.key = undefined;
    clearCanvasTextSelection(session);
  };
  let held: ReturnType<typeof takeOver> | undefined;
  canvasTextSelection.set({
    session,
    bubble: windowBubble(frame, range.rect),
    states,
    press: (action) => {
      const selection = takeOver();
      if (selection.start >= selection.end || !format.apply(textId, selection, action)) {
        initial.report('This text can’t be formatted here. Use the Content field in Settings.');
      }
      release();
    },
    beginLink: () => {
      takeover.linking = true;
      held = takeOver();
    },
    endLink: (url) => {
      const selection = held;
      held = undefined;
      release();
      if (!selection) {
        return;
      }
      const linkable = selection.start < selection.end;
      if (url !== undefined && linkable && format.apply(textId, selection, { kind: 'link', url })) {
        return;
      }
      // No link after all: the words typed before the URL field opened still save.
      if (selection.value !== plan.target.value) {
        void plan.apply(selection.value).catch((error: unknown) => initial.report(String(error)));
      }
    },
  });
}

// The selection's box is in the frame's own pixels, and the frame is scaled
// into the canvas: the window position is its corner plus the scaled box.
function windowBubble(frame: HTMLIFrameElement, rect: CanvasTextSelectionRange['rect']) {
  const box = frame.getBoundingClientRect();
  const scale = frame.clientWidth > 0 ? box.width / frame.clientWidth : 1;
  return {
    x: box.left + (rect.x + rect.w / 2) * scale,
    top: box.top + rect.y * scale,
    bottom: box.top + (rect.y + rect.h) * scale,
  };
}
