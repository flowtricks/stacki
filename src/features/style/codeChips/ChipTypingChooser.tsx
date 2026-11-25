import { useLayoutEffect, useMemo, useRef, useState, type ComponentProps, type MutableRefObject, type ReactNode } from 'react';
import type { Extension } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { assert } from '../../../../shared/core/assert';
import { codeSlotAt, declarationValueWith, type CodeTypedVariable } from '../model/codeVariableScope';
import { rootSwatchScope, SwatchScopeContext } from '../model/computedColor';
import { declaredPropertyAt } from '../model/panelVariableList';
import { usePanelListing } from '../usePanelListing';
import type { ProjectVariable } from '../model/webflow';
import { VariablePicker, type PickerNavigation } from '../VariablePicker';
import { useChipPreview } from './chipPreview';
import {
  chipTypedCompletion,
  chipTypingExtension,
  nextFollowing,
  type ChipDismissed,
  type ChipFollowing,
  type ChipTypingHandlers,
  type ChipTypingKey,
} from './chipTyping';
import type { CssChipText } from './cssValueChips';

// The variable chooser a code window's CSS opens as a reference is typed (chipTyping.ts says where):
// the Style panel's own VariablePicker, following the typing, under the caret. The list filters by the
// name typed so far; ↑ and ↓ move through it, Enter and Tab take the marked variable, and Escape puts
// it away until the caret leaves that reference. A pick replaces only the typed fragment.

/** What a code editor needs for its typed variables: the extension, and the chooser. */
export interface ChipTyping {
  readonly extension: Extension;
  readonly overlay: ReactNode;
}

type Following = ChipFollowing<EditorView>;
type Dismissed = ChipDismissed<EditorView>;

/** The chooser of a code editor whose text is `text`, listing `vars`. */
export function useChipTyping(text: CssChipText | undefined, catalog: { readonly vars: ProjectVariable[]; readonly loading: boolean }): ChipTyping {
  const { vars, loading } = catalog;
  const [following, setFollowing] = useState<Following | undefined>(undefined);
  const followingRef = useRef(following);
  followingRef.current = following;
  const dismissedRef = useRef<Dismissed | undefined>(undefined);
  const navigationRef = useRef<PickerNavigation | undefined>(undefined);
  const textRef = useRef(text);
  textRef.current = text;
  const dismiss = (): void => {
    const current = followingRef.current;
    if (current !== undefined) {
      dismissedRef.current = { view: current.view, start: current.typed.typed.start };
    }
    setFollowing(undefined);
  };
  const handlersRef = useRef<ChipTypingHandlers>({
    text: () => textRef.current,
    onTyped: (view, typed, cause) => setFollowing(nextFollowing({ view, typed, cause }, followingRef.current, dismissedRef)),
    onKey: (view, key) => {
      const current = followingRef.current;
      if (current === undefined || current.view !== view) {
        return false;
      }
      return chooserKey(key, navigationRef.current, dismiss);
    },
  });
  const [extension] = useState(() => chipTypingExtension(handlersRef));
  const anchor = useCaretAnchor(following);
  const pick = (binding: string): void => {
    const current = followingRef.current;
    setFollowing(undefined);
    if (current === undefined) {
      return;
    }
    const { view, typed } = current;
    const edit = chipTypedCompletion(view.state.doc.toString(), typed, binding);
    view.dispatch({
      changes: { from: edit.from, to: edit.to, insert: edit.insert },
      selection: { anchor: edit.caret },
      userEvent: 'input.complete',
      scrollIntoView: true,
    });
    assert(view.state.sliceDoc(edit.from, edit.caret) === edit.insert, 'useChipTyping: the pick is written where the fragment was');
    view.focus();
  };
  // A stylesheet's swatches are its variables on `:root`, the page's root element (rootColors.ts).
  const swatchScope = useMemo(() => rootSwatchScope(vars), [vars]);
  // A custom property's value (`--x: |`) takes any variable: the chooser lists the Variables panel's,
  // in its groups and order, less the one being declared (panelVariableList.ts).
  const customValue = following !== undefined && following.typed.prop === undefined;
  const self = following === undefined || !customValue ? undefined : declaredPropertyAt(following.view.state.doc.toString(), following.typed.typed.start);
  const listing = usePanelListing({ active: customValue }, self, vars);
  const overlay =
    following === undefined || anchor === undefined ? undefined : (
      <SwatchScopeContext.Provider value={swatchScope}>
        <TypedPicker
          anchor={anchor}
          vars={listing === undefined ? vars : [...listing.variables]}
          loading={loading}
          panel={listing === undefined ? undefined : { blocks: listing.blocks }}
          following={following}
          navigationRef={navigationRef}
          onPick={pick}
          onClose={dismiss}
        />
      </SwatchScopeContext.Provider>
    );
  return { extension, overlay };
}

// The chooser under the caret. Hovering or arrowing a row shows that variable in the declaration on the
// canvas (chipPreview.ts) while the typed text stays the editor's own; the pick is the only write. Its own
// component so the preview lives exactly as long as the chooser: closing it takes the preview back.
function TypedPicker({
  anchor,
  vars,
  loading,
  panel,
  following,
  navigationRef,
  onPick,
  onClose,
}: {
  readonly anchor: HTMLElement;
  readonly vars: ProjectVariable[];
  readonly loading: boolean;
  readonly panel: ComponentProps<typeof VariablePicker>['panel'] | undefined;
  readonly following: Following;
  readonly navigationRef: MutableRefObject<PickerNavigation | undefined>;
  readonly onPick: (binding: string) => void;
  readonly onClose: () => void;
}) {
  const { typed } = following.typed;
  // The declaration as it would read once `binding` replaced the fragment typed so far, from the editor's live text.
  const valueWith = (binding: string): string | undefined => {
    const text = following.view.state.doc.toString();
    const edit = chipTypedCompletion(text, following.typed, binding);
    return declarationValueWith(text, following.typed, edit.insert)?.trim();
  };
  const preview = useChipPreview({ property: following.typed.prop, valueWith }, { exits: 'window' });
  return (
    <VariablePicker
      anchor={anchor}
      vars={vars}
      loading={loading}
      {...(panel === undefined ? {} : { panel })}
      {...(following.typed.prop === undefined ? {} : { prop: following.typed.prop })}
      {...slotOf(following)}
      typing={{ query: typed.query, navigationRef }}
      previewWhileTyping="canvas"
      onPreview={preview.onPreview}
      previewEpoch={preview.previewEpoch}
      onPreviewEnd={preview.onPreviewEnd}
      onPick={(binding) => {
        preview.handOver(binding);
        onPick(binding);
      }}
      onClose={onClose}
    />
  );
}

// While the chooser follows typing, ↑ and ↓ move through it, Enter and Tab take the marked variable,
// and Escape puts it away: the Custom value box's keys. An arrow with no row on screen (nothing
// matches, or nothing fits the place) is the editor's, so the caret still moves.
function chooserKey(key: ChipTypingKey, navigation: PickerNavigation | undefined, dismiss: () => void): boolean {
  if (key === 'Escape') {
    dismiss();
    return true;
  }
  if (navigation === undefined) {
    return false;
  }
  switch (key) {
    case 'ArrowDown':
    case 'ArrowUp':
      if (document.querySelector('.embed-editor_varpicker .embed-editor_varpicker-item') === null) {
        return false;
      }
      navigation.move(key === 'ArrowDown' ? 1 : -1);
      return true;
    case 'Enter':
    case 'Tab':
      if (navigation.pick()) {
        return true;
      }
      dismiss();
      return false;
    default: {
      const exhaustive: never = key;
      throw new Error(`Assertion failed: chooserKey: unknown key ${String(exhaustive)}`);
    }
  }
}

// Where the typed reference sits in its declaration's value, so the chooser judges each variable there.
function slotOf(following: Following): ReturnType<typeof slotProp> {
  return slotProp(following.view.state.doc.toString(), following.typed);
}

function slotProp(text: string, typed: CodeTypedVariable): { readonly slot?: NonNullable<ReturnType<typeof codeSlotAt>> } {
  const slot = codeSlotAt(text, typed, { kind: 'declarations' });
  return slot === undefined ? {} : { slot };
}

/**
 * A fixed box over the start of the typed fragment, in a row of its own: the picker places itself
 * against its anchor's parent (usePickerPosition), and the caret's line is where it belongs. Made
 * again only when the fragment moves, so the list stays put while a name is spelt.
 */
function useCaretAnchor(following: Following | undefined): HTMLElement | undefined {
  const [anchor, setAnchor] = useState<HTMLElement | undefined>(undefined);
  const view = following?.view;
  const start = following?.typed.typed.start;
  useLayoutEffect(() => {
    if (view === undefined || start === undefined) {
      setAnchor(undefined);
      return undefined;
    }
    const rect = view.coordsAtPos(start) ?? view.contentDOM.getBoundingClientRect();
    const row = document.createElement('span');
    row.className = 'code-chip-anchor';
    row.setAttribute('aria-hidden', 'true');
    Object.assign(row.style, {
      position: 'fixed',
      left: `${rect.left}px`, // physical: a measured client rect
      top: `${rect.top}px`,
      width: '1px',
      height: `${Math.max(0, rect.bottom - rect.top)}px`,
      pointerEvents: 'none',
    });
    const element = document.createElement('span');
    Object.assign(element.style, { display: 'block', width: '100%', height: '100%' });
    row.append(element);
    document.body.append(row);
    assert(element.parentElement === row, 'useCaretAnchor: the anchor sits in its own row');
    setAnchor(element);
    return () => {
      row.remove();
      setAnchor(undefined);
    };
  }, [view, start]);
  return anchor;
}
