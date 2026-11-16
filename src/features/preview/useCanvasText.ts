import { useTranslate } from '../../lib/i18n/useTranslate';
import type { MessageKey, Translator } from '../../lib/i18n/localeContext';
import type { CanvasTextRefusal } from '../../../shared/properties/canvasText';
import { ENGLISH_TRANSLATE } from '../../../shared/properties/i18n/englishTranslator';
import { cmsTransport } from '../../ipc/editorEnvironment';
import { noteCanvasTextEditing } from '../../editor/canvasTextFocus';
import type { CanvasEditFormat, CanvasTextEdit } from './canvasTextSource';
import type { BoundTextBlockReason } from '../../editor/boundText';
import { parsePreviewMessage } from './previewMessages';
import { useEffect, useRef, type RefObject } from 'react';
import {
  CANVAS_BLOCKED_LIMIT,
  canvasTextUnfolded,
  parseCanvasTextEvent,
  type CanvasTextCatalog,
  type CanvasTextRunValue,
} from '../../../shared/properties/canvasText';
import { applyCanvasText, applyCanvasTexts, canvasTextNodes, canvasTextPlans, type CanvasSourceNode } from './canvasTextSource';
import { createCanvasTextOverlay } from './canvasTextOverlay';
import { onCanvasTextRefresh } from './canvasTextRefresh';
import { canvasSourceCue, canvasSourceHover, clearCanvasSourceCue } from '../../ui/canvasTextSourceCue';
import {
  CANVAS_FOCUS_PATHS_MAX,
  canvasTextFocus,
  parseCanvasTextOverlay,
  parseCanvasTextSelection,
  type CanvasTextBox,
  type CanvasTextSelection,
  type CanvasTextSelectionRange,
} from '../../../shared/properties/canvasTextOverlay';
import { canvasTextSelection, clearCanvasTextSelection, type CanvasFormatAction, type CanvasFormatState } from './canvasTextSelection';
import { canvasTextDraft, clearCanvasTextDraft, canvasTypedText, type CanvasTextDraft } from '../../ui/canvasTextDraft';

export interface CanvasTextDocument {
  readonly projectPath: string;
  readonly file: string;
  readonly source: string;
  readonly nodes: readonly CanvasSourceNode[];
  readonly pathFor: (id: string) => string | undefined;
  readonly apply: (source: string, position: number) => Promise<void>;
  readonly report: (message: string) => void;
  readonly loadContent: (document: CanvasTextDocument) => Promise<readonly CanvasTextEdit[]>;
  /**
   * What the content edits are read from besides the page — the project's
   * components, for the text their props show. A new value rebuilds the
   * catalog, so editing a component's template never leaves its text stale.
   */
  readonly components?: unknown;
  /** The selected node's page path. Absent: no component text is marked. */
  readonly focus?: readonly string[] | undefined;
  /** The Content field's formatting, for words selected on the canvas. Absent: no bar. */
  readonly format?: CanvasTextFormatter | undefined;
}
export interface CanvasTextFormatter {
  /** The lit buttons for a text node, or undefined when it cannot be formatted. */
  readonly states: (textId: string) => CanvasFormatState | undefined;
  /** One press over [start, end) of the text, which reads `value`. False: nothing changed. */
  readonly apply: (textId: string, selection: { readonly start: number; readonly end: number; readonly value: string }, action: CanvasFormatAction) => boolean;
}
interface Options {
  readonly document: CanvasTextDocument | undefined;
  readonly frame: RefObject<HTMLIFrameElement>;
  readonly url: string | undefined;
  readonly post: (message: unknown) => void;
  readonly subscribeLoad: (listener: () => void) => () => void;
  /** Words the notices this module raises; English when absent (tests). */
  readonly translate?: Translator | undefined;
}

export function useCanvasText(options: Options): void {
  const translate = useTranslate();
  const current = useRef(options);
  current.current = { ...options, translate };
  const document = options.document;
  const file = document?.file;
  const source = document?.source;
  const components = document?.components;
  useEffect(() => startCanvasText(current), [file, source, components]);
  const focus = (document?.focus ?? []).join('\n');
  useEffect(() => startCanvasFocus(current, focus), [focus]);
}

// The frame learns the selection separately from the catalog: selecting is
// frequent, and rebuilding the catalog would reread every component.
function startCanvasFocus(current: RefObject<Options>, focus: string) {
  const paths = focus === '' ? [] : focus.split('\n');
  const message = canvasTextFocus(paths.slice(0, CANVAS_FOCUS_PATHS_MAX));
  const send = () => current.current?.post(message);
  send();
  return current.current?.subscribeLoad(send);
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
  const unsubscribeRefresh = onCanvasTextRefresh(refresh);
  const unsubscribe = current.current?.subscribeLoad(send);
  const receive = createCanvasTextReceiver({
    current,
    initial,
    session,
    overlay,
    plans: () => plans,
  });
  window.addEventListener('message', receive);
  const hover = createSourceHover({ current, session, plans: () => plans });
  window.addEventListener('message', hover);
  return () => {
    window.removeEventListener('message', hover);
    canvasSourceHover.set(undefined);
    disposed = true;
    overlay.close();
    clearCanvasTextDraft(session);
    clearCanvasTextSelection(session);
    unsubscribeContent();
    unsubscribeRefresh();
    clearCanvasSourceCue(session);
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
  const nodes = new Map(canvasTextNodes(options.initial.nodes).map(({ node }) => [node.id ? options.initial.pathFor(node.id) : undefined, node]));
  return (event: MessageEvent<unknown>) => {
    const message = canvasTextSessionMessage(event, options);
    if (!message) {
      return;
    }
    if (message.type === 'avb:text-active' || message.type === 'avb:text-inactive') {
      noteCanvasTextEditing(message.type === 'avb:text-active' ? 'active' : 'inactive');
      options.overlay.receive(message);
      showSourceCue(message, options);
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
      publishCanvasDraft(plan, nodes.get(plan.target.path), message.value, options);
      return;
    }
    busy = true;
    const draft = canvasTextDraft.get();
    void saveCanvasText(plan, message, options)
      .catch((error: unknown) => options.initial.report(String(error)))
      .finally(() => {
        busy = false;
        if (canvasTextDraft.get() === draft) {
          clearCanvasTextDraft(options.session);
        }
      });
  };
}

// One text saves through its own plan. Texts one selection changed together are
// written in one source edit, so they land together and undo as one step.
function saveCanvasText(
  plan: CanvasTextEdit,
  message: CanvasTextRunValue & { readonly also?: readonly CanvasTextRunValue[] },
  options: CanvasTextReceiverOptions,
) {
  if (!message.also) {
    return plan.apply(message.value);
  }
  const edits = [message, ...message.also].flatMap(({ key, value }) => {
    const edit = options.plans().find((entry) => entry.target.key === key);
    return edit?.plan ? [{ plan: edit.plan, value: canvasTypedText(edit.target.value, value) }] : [];
  });
  if (edits.length !== message.also.length + 1) {
    options.initial.report((options.current.current?.translate ?? ENGLISH_TRANSLATE)('preview.text.pageChanged'));
    return Promise.resolve();
  }
  const position = Math.min(...edits.map((edit) => edit.plan.start));
  return options.initial.apply(applyCanvasTexts(options.initial.source, edits), position);
}

// The words being typed, mirrored into the field that shows them: a text
// node's Content field, or the props panel field of the prop that sets them.
function publishCanvasDraft(plan: CanvasTextEdit, node: CanvasSourceNode | undefined, value: string, options: CanvasTextReceiverOptions) {
  const scope = {
    session: options.session,
    projectPath: options.initial.projectPath,
    file: options.initial.file,
    value,
  };
  if (plan.prop) {
    const { nodeID, name } = plan.prop;
    canvasTextDraft.set({
      ...scope,
      kind: 'prop',
      nodeID,
      prop: name,
      value: plan.prop.value(value),
      typed: value,
    });
    return;
  }
  if (node?.id && node.value !== undefined) {
    canvasTextDraft.set({ ...scope, kind: 'text', nodeID: node.id, sourceValue: node.value });
  }
}

function canvasTextSessionMessage(event: MessageEvent<unknown>, options: CanvasTextReceiverOptions) {
  const host = options.current.current;
  const message = canvasTextMessage(event, host ?? undefined);
  if (!message || !host) {
    return undefined;
  }
  if (message.type === 'avb:text-refused') {
    const translate = options.current.current?.translate ?? ENGLISH_TRANSLATE;
    options.initial.report(blockedRefusal(message, options.plans(), options.initial.file, translate) ?? refusalText(message, translate));
    return undefined;
  }
  if (message.session !== options.session) {
    return undefined;
  }
  if (host.document?.source !== options.initial.source || host.document.file !== options.initial.file) {
    return undefined;
  }
  return message;
}

function canvasTextMessage(event: MessageEvent<unknown>, host: Options | undefined) {
  if (!host?.url || event.source !== host.frame.current?.contentWindow || event.origin !== new URL(host.url).origin) {
    return undefined;
  }
  try {
    return parseCanvasTextEvent(event.data) ?? parseCanvasTextOverlay(event.data) ?? parseCanvasTextSelection(event.data);
  } catch {
    return undefined;
  }
}

async function publishCanvasTextSession(
  document: CanvasTextDocument,
  session: string,
  revision: number,
  publish: (ready: { readonly plans: readonly CanvasTextEdit[]; readonly catalog: CanvasTextCatalog }) => void,
) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(document.source));
  const checksum = Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
  const literal = canvasTextPlans(document.source, document.nodes, document.pathFor);
  const plans: readonly CanvasTextEdit[] = [
    ...literal.map((plan) => ({
      target: plan.target,
      plan,
      apply: (value: string) => {
        const typed = canvasTypedText(plan.target.value, value);
        return document.apply(applyCanvasText(document.source, plan, typed), plan.start);
      },
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
    // Text printed from data is traced to its source here, so its target
    // replaces the plain constant the page's own text pass already offered.
    const refreshed = content.map((plan) => ({
      ...plan,
      target: plan.bound === undefined ? { ...plan.target, key: `cms:${revision}:${plan.target.key}` } : plan.target,
    }));
    const claimed = new Set(refreshed.filter((plan) => plan.bound !== undefined).map((plan) => plan.target.path));
    const kept = plans.filter((plan) => !claimed.has(plan.target.path));
    const combined = [...kept, ...refreshed].slice(0, 2_000);
    const editable = combined.filter((plan) => plan.bound?.kind !== 'blocked');
    const blocked = combined.filter((plan) => plan.bound?.kind === 'blocked').slice(0, CANVAS_BLOCKED_LIMIT);
    publish({
      plans: combined,
      catalog: {
        ...catalog,
        targets: editable.map((plan) => plan.target),
        ...(blocked.length === 0 ? {} : { blocked: blocked.map((plan) => ({ key: plan.target.key, path: plan.target.path })) }),
      },
    });
  }
}

// The pointer on the element that prints bound text, while nothing is being typed: a hint that a double
// click edits it, and where. The frame already reports what the pointer is over (avb:hover-node); this
// reads that report and draws nothing of its own on the page.
function createSourceHover(options: { readonly current: RefObject<Options>; readonly session: string; readonly plans: () => readonly CanvasTextEdit[] }) {
  return (event: MessageEvent<unknown>) => {
    const host = options.current.current;
    if (!host?.url || event.source !== host.frame.current?.contentWindow || event.origin !== new URL(host.url).origin) {
      return;
    }
    const message = parseHoverMessage(event.data);
    const frame = host.frame.current;
    if (message === undefined || !frame || canvasSourceCue.get() !== undefined) {
      canvasSourceHover.set(undefined);
      return;
    }
    const bound = options.plans().find((plan) => plan.target.parent === message.path && plan.bound?.kind === 'source')?.bound;
    if (bound?.kind !== 'source' || message.box === undefined) {
      canvasSourceHover.set(undefined);
      return;
    }
    const origin = frame.getBoundingClientRect();
    const scale = frame.clientWidth > 0 ? origin.width / frame.clientWidth : 1;
    canvasSourceHover.set({
      session: options.session,
      expression: bound.expression,
      file: bound.file,
      uses: bound.uses,
      box: { x: origin.left + message.box.x * scale, y: origin.top + message.box.y * scale, w: message.box.w * scale, h: message.box.h * scale },
    });
  };
}

function parseHoverMessage(input: unknown): { readonly path: string; readonly box: CanvasTextBox | undefined } | undefined {
  try {
    const message = parsePreviewMessage(input);
    if (message?.kind !== 'hover-node' || message.path === undefined) {
      return undefined;
    }
    return { path: message.path, box: message.boxes?.[0] };
  } catch {
    return undefined;
  }
}

// The cue over the text being typed in: which source its words are written to.
function showSourceCue(
  message: { readonly type: string; readonly session: string; readonly key?: string; readonly rect?: CanvasTextBox },
  options: CanvasTextReceiverOptions,
) {
  if (message.type !== 'avb:text-active' || message.key === undefined) {
    clearCanvasSourceCue(options.session);
    return;
  }
  const bound = options.plans().find((entry) => entry.target.key === message.key)?.bound;
  const frame = options.current.current?.frame.current;
  if (bound?.kind !== 'source' || message.rect === undefined || !frame) {
    clearCanvasSourceCue(options.session);
    return;
  }
  const origin = frame.getBoundingClientRect();
  const scale = frame.clientWidth > 0 ? origin.width / frame.clientWidth : 1;
  canvasSourceCue.set({
    session: options.session,
    expression: bound.expression,
    file: bound.file,
    uses: bound.uses,
    box: { x: origin.left + message.rect.x * scale, y: origin.top + message.rect.y * scale, w: message.rect.w * scale, h: message.rect.h * scale },
  });
}

// A double click on text whose source cannot be written: the file to edit instead, in the person's language.
function blockedRefusal(
  message: { readonly reason?: CanvasTextRefusal | undefined; readonly key?: string | undefined },
  plans: readonly CanvasTextEdit[],
  pageFile: string,
  translate: Translator,
): string | undefined {
  if (message.reason !== 'source-blocked') {
    return undefined;
  }
  const bound = plans.find((plan) => plan.target.key === message.key)?.bound;
  if (bound?.kind !== 'blocked') {
    return undefined;
  }
  return translate(BLOCKED_KEYS[bound.reason], { file: bound.file === '' ? pageFile : bound.file, path: bound.expression });
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
  const range = message.range;
  const format = plan && editFormat(plan, options.nodes, initial.format);
  const states = format?.states();
  const frame = options.current.current?.frame.current;
  if (!range || !plan || !format || !states || !frame) {
    clearCanvasTextSelection(session);
    return;
  }
  const typed = () => {
    const draft = canvasTextDraft.get();
    return draft?.session === session && draftOf(plan, draft, options.nodes) ? draftTyped(draft) : plan.target.value;
  };
  const takeOver = () => {
    const value = typed();
    takeover.key = message.key;
    options.current.current?.post({ type: 'avb:text-close', session, action: 'cancel' });
    // The frame counts shown characters; this text may space them differently.
    const start = canvasTextUnfolded(value, range.start, 'start');
    const end = canvasTextUnfolded(value, range.end, 'end');
    return typedSelection(plan, { start: start ?? 0, end: end ?? 0, value });
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
      if (selection.start >= selection.end || !format.apply(selection, action)) {
        initial.report((options.current.current?.translate ?? ENGLISH_TRANSLATE)('preview.text.cannotFormat'));
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
      if (url !== undefined && linkable && format.apply(selection, { kind: 'link', url })) {
        return;
      }
      // No link after all: the words typed before the URL field opened still save.
      if (selection.value !== plan.target.value) {
        void plan.apply(selection.value).catch((error: unknown) => initial.report(String(error)));
      }
    },
  });
}

// The format bar for one text: its own, for text that is not the page's inline
// content (a prop's HTML), or the page's, bound to the text node it edits.
function editFormat(
  plan: CanvasTextEdit,
  nodes: ReadonlyMap<string | undefined, CanvasSourceNode>,
  format: CanvasTextFormatter | undefined,
): CanvasEditFormat | undefined {
  if (plan.format) {
    return plan.format;
  }
  // Content loaded beside the page (CMS entries, prop text) formats only with
  // its own formatter: its paths may name page nodes it does not edit.
  if (plan.target.key.startsWith('cms:')) {
    return undefined;
  }
  const node = nodes.get(plan.target.path);
  const textId = node?.kind === 'text' ? node.id : undefined;
  if (!textId || !format) {
    return undefined;
  }
  return {
    states: () => format.states(textId),
    apply: (selection, action) => format.apply(textId, selection, action),
  };
}

// A selection over the editor's text, moved onto the words as they will be
// saved: without the template's whitespace around them (canvasTypedText).
// Prop text keeps its own value; its runs carry no template whitespace.
function typedSelection(plan: CanvasTextEdit, selection: { readonly start: number; readonly end: number; readonly value: string }) {
  if (plan.prop) {
    return selection;
  }
  const value = canvasTypedText(plan.target.value, selection.value);
  // HTML whitespace only, as canvasTypedText strips it: U+00A0 is a word character.
  const dropped = /^[ \t\n\r\f]*/.exec(selection.value)?.[0].length ?? 0;
  const shift = dropped - (value.startsWith(' ') && dropped > 0 ? 1 : 0);
  const clamp = (offset: number) => Math.min(Math.max(offset - shift, 0), value.length);
  return { start: clamp(selection.start), end: clamp(selection.end), value };
}

// Whether a draft is the one this text's editor is writing.
function draftOf(plan: CanvasTextEdit, draft: CanvasTextDraft, nodes: ReadonlyMap<string | undefined, CanvasSourceNode>): boolean {
  if (draft.kind === 'prop') {
    return draft.nodeID === plan.prop?.nodeID && draft.prop === plan.prop.name;
  }
  return draft.nodeID === nodes.get(plan.target.path)?.id;
}

function draftTyped(draft: CanvasTextDraft): string {
  return draft.kind === 'prop' ? draft.typed : draft.value;
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

const REFUSAL_KEYS: Readonly<Record<CanvasTextRefusal, MessageKey>> = {
  'waiting-render': 'preview.text.waitingRender',
  'selection-reaches': 'preview.text.selectionReaches',
  unsafe: 'preview.text.unsafe',
  'page-changed': 'preview.text.pageChanged',
  'source-blocked': 'preview.text.source.blocked.computed',
};

const BLOCKED_KEYS: Readonly<Record<BoundTextBlockReason, MessageKey>> = {
  ambiguous: 'preview.text.source.blocked.ambiguous',
  call: 'preview.text.source.blocked.call',
  computed: 'preview.text.source.blocked.computed',
  concatenation: 'preview.text.source.blocked.concatenation',
  duplicate: 'preview.text.source.blocked.duplicate',
  missing: 'preview.text.source.blocked.missing',
  mutable: 'preview.text.source.blocked.mutable',
  'not-text': 'preview.text.source.blocked.notText',
  prop: 'preview.text.source.blocked.prop',
  runtime: 'preview.text.source.blocked.computed',
  template: 'preview.text.source.blocked.template',
  unreadable: 'preview.text.source.blocked.unreadable',
  unsupported: 'preview.text.source.blocked.unsupported',
};

// The frame sends the English sentence and a code; the sentence is shown when the frame is older than this editor and sent no code.
function refusalText(message: { readonly message: string; readonly reason?: CanvasTextRefusal | undefined }, translate: Translator): string {
  return message.reason === undefined ? message.message : translate(REFUSAL_KEYS[message.reason]);
}
