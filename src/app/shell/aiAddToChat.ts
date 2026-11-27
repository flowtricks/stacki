// Desktop's side of "Add to chat" (src/features/ai/addToChat.ts): which file a selection is in and what that file
// is, showing the panel, and the two askers outside the Code panel: the element menus of the canvas and the
// Navigator, and ⌘L with an element selected (the canvas forwards the key, frameDesign.ts).
import { useEffect, useRef } from 'react';
import type { Translator } from '../../lib/i18n/localeContext';
import { useTranslate } from '../../lib/i18n/useTranslate';
import { addSelectionToChat } from '../../features/ai/addToChat';
import { pageDisplayLabel } from '../../lib/pageName';
import { nodeSelectionOf, type SourceSelection } from '../../features/code/codePanelModel';
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
export function addSelectionOfOpenFile(app: ShellView, selection: SourceSelection, translate: Translator): void {
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

/** Adds element `id`'s code, as the open file reads now. */
function addNodeToChat(id: string): void {
  const present = offer?.current;
  if (present === undefined) {
    return;
  }
  const { app, translate } = present;
  const source = app.pageState?.source;
  const selection = source === undefined ? undefined : nodeSelectionOf(source, app.model, id);
  if (selection === undefined) {
    reportErrorToast(translate('ai.add.noCode'));
    return;
  }
  addSelectionOfOpenFile(app, selection, translate);
}

/** The element menus' "Add to chat", or undefined where the role has no AI panel. */
export function addNodeToChatOffer(): ((id: string) => void) | undefined {
  return offer === undefined ? undefined : addNodeToChat;
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
      addNodeToChat(selected);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      offer = undefined;
    };
  }, [available]);
}
