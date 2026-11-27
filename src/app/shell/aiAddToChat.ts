// Desktop's side of "Add to chat" (src/features/ai/addToChat.ts): which file a selection is in and what that file
// is, and showing the panel. Every way of adding the selected element comes through `addNodeToChat` here: the
// "+" menu's "Add selected" row, the element menus of the canvas and the Navigator, ⌘L with an element selected
// (the canvas forwards the key, frameDesign.ts) and the Code panel's button with no text selected. There is one
// path so they cannot come to add different things.
import { useEffect, useRef } from 'react';
import type { Translator } from '../../lib/i18n/localeContext';
import { useTranslate } from '../../lib/i18n/useTranslate';
import { addSelectionToChat, offerSelectedElement } from '../../features/ai/addToChat';
import { isComponentCanvasPage } from '../../features/preview/componentCanvas/componentCanvasSession';
import { cleanError } from '../../lib/cleanError';
import { followedNode } from '../../editor/editorTree';
import type { EditorModel } from '../../editor/pageView';
import { pageDisplayLabel } from '../../lib/pageName';
import { nodeSelectionOf, offeredNodeOf, type CodeAddRequest, type SourceSelection } from '../../features/code/codePanelModel';
import { currentDesktopPlatform, isAddToChatKey } from '../../lib/shortcutLabel';
import { reportErrorToast } from '../../ui/errorNotices';
import { selectionChipsOf } from './aiSelection';
import type { ShellView } from '../App';

interface Offer {
  readonly app: ShellView;
  readonly translate: Translator;
  readonly openPanel: () => void;
}

// Set while the panel is mounted for a role that has it; the element menus read it as they are drawn.
let offer: { readonly current: Offer } | undefined;

/** Adds `selection`, made in the open file, to the chat, and shows the panel. */
function addSelectionOfOpenFile(app: ShellView, selection: SourceSelection, translate: Translator): void {
  const present = offer?.current;
  const open = app.currentPage;
  if (present === undefined || open === undefined || open.kind === 'route') {
    return;
  }
  const host = app.editStack[0];
  const chips = selectionChipsOf(
    {
      projectPath: app.project.path,
      platform: window.avb.platform,
      openPath: open.path,
      canvasPagePath: host?.kind === 'page' ? host.path : undefined,
      pages: app.scan.pages,
      layouts: app.scan.layouts,
      components: app.scan.components,
      pageName: (page) => pageDisplayLabel(page, translate),
    },
    selection,
  );
  if (chips === undefined) {
    reportErrorToast(translate('ai.add.noCode'));
    return;
  }
  present.openPanel();
  void addSelectionToChat(app.project.path, chips, translate);
}

/**
 * Adds element `id`'s whole code, as the open file has it with every edit made so far. Edits not yet saved are
 * saved first: the code is cut from the file by the places a parse of it gives, and an edit still on its way has
 * neither the new text nor the new places.
 */
async function addNodeToChat(id: string): Promise<void> {
  const present = offer?.current;
  if (present === undefined) {
    return;
  }
  const { app, translate } = present;
  // The component canvas's own page is generated scratch markup: its instances are previews, not the project's code.
  if (app.editStack.length <= 1 && isComponentCanvasPage(app.currentPage?.path)) {
    reportErrorToast(translate('componentCanvas.error.pageReadOnly'));
    return;
  }
  try {
    await app.flushSave();
  } catch (error: unknown) {
    reportErrorToast(cleanError(error));
    return;
  }
  const { currentPage, pageState } = app.pageStateRef.current;
  if (currentPage === undefined || currentPage.kind === 'route' || currentPage.path !== app.currentPage?.path) {
    return; // Another file opened while the save ran: the element is not on screen any more.
  }
  const selection =
    pageState?.editable === true && pageState.parsedFrom === pageState.source
      ? nodeSelectionOf(pageState.source, pageState.model, savedIdOf(app.model, pageState.model, id), currentPage.path)
      : undefined;
  if (selection === undefined) {
    reportErrorToast(translate('ai.add.noCode'));
    return;
  }
  addSelectionOfOpenFile(app, selection, translate);
}

// The element's handle in the saved page: a save of typed code gives an element whose words changed a new one.
function savedIdOf(shown: ShellView['model'], saved: EditorModel, id: string): string {
  if (shown === undefined || id === 'layout' || id === 'frontmatter') {
    return id;
  }
  return followedNode(shown.nodes, saved.nodes, id)?.id ?? id;
}

/** The Code panel's "Add to chat": the text selected there exactly, or else the selected element as every route adds it. */
export function addCodeToChat(app: ShellView, request: CodeAddRequest, translate: Translator): void {
  switch (request.kind) {
    case 'text':
      addSelectionOfOpenFile(app, request.selection, translate);
      return;
    case 'node':
      void addNodeToChat(request.id);
      return;
    default: {
      const exhaustive: never = request;
      return exhaustive;
    }
  }
}

/** The element menus' "Add to chat", or undefined where the role has no AI panel. */
export function addNodeToChatOffer(): ((id: string) => void) | undefined {
  return offer === undefined ? undefined : (id) => void addNodeToChat(id);
}

/** Mounted with the shell: offers "Add to chat" while the panel is available, and hears ⌘L. */
export function useAddToChat(app: ShellView, panel: { readonly available: boolean; readonly openPanel: () => void }): void {
  const translate = useTranslate();
  const latest = useRef<Offer>({ app, translate, openPanel: panel.openPanel });
  latest.current = { app, translate, openPanel: panel.openPanel };
  const { available } = panel;
  useEffect(() => {
    if (!available) {
      return undefined;
    }
    offer = latest;
    const onKeyDown = (event: KeyboardEvent): void => {
      const selected = latest.current.app.selectedId;
      if (event.defaultPrevented || selected === undefined || !isAddToChatKey(event, currentDesktopPlatform())) {
        return;
      }
      // Another code editor's ⌘L is its own; the chat's message box is not one, and adds the selected element.
      const editor = event.target instanceof Element ? event.target.closest('.cm-editor') : undefined;
      if (editor !== null && editor !== undefined && editor.closest('.ai-editor') === null) {
        return;
      }
      event.preventDefault();
      void addNodeToChat(selected);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      offer = undefined;
    };
  }, [available]);
  useOfferSelectedElement(app, panel);
}

// What the "+" menu offers: the selected node, where it has code of its own in the open file.
function useOfferSelectedElement(app: ShellView, panel: { readonly available: boolean }): void {
  const { available } = panel;
  const id = app.selectedId;
  const open = app.currentPage !== undefined && app.currentPage.kind !== 'route';
  const node = available && open && id !== undefined ? offeredNodeOf(app.model, id) : undefined;
  const offered = node !== undefined;
  const name = node?.name;
  useEffect(() => {
    if (!offered || id === undefined) {
      return undefined;
    }
    offerSelectedElement({ name, add: () => void addNodeToChat(id) });
    return () => offerSelectedElement(undefined);
  }, [offered, id, name]);
}
