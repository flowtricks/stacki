import { useTranslate } from '../../../lib/i18n/useTranslate';
import { useRef, useState } from 'react';
import type { MutableRefObject, ReactNode, RefObject } from 'react';
import type { Extension } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { assert } from '../../../../shared/core/assert';
import { type CodeTypedVariable, type CodeVariableScope } from '../model/codeVariableScope';
import { useSharedVars } from '../sharedVars';
import { ConnectDot } from '../VariableConnect';
import { VariablePicker, type PickerNavigation } from '../VariablePicker';
import { bindInView, codeVariableExtension, completeInView, type CodeVariableHandlers, type CodeVariableKey } from './codeVariableExtension';
import '../embedEditor.css';

// The variables of a code editor that holds CSS values: the same chooser the
// Custom value box opens as `--` is typed, and, where the whole text is one
// property's value, the same purple bind dot in the top-left corner.
//
// Every CSS code editor in the panel is CssCodeEditor's CodeEditor, and that
// component calls this with the scope it is given; the scope is a required
// prop there, so an editor cannot be added without saying what its text is.
// The chooser is the Custom value box's own VariablePicker, portaled to <body>,
// so a popover that clips its overflow (the clip-path editor's) cannot cut it off.

/** What a code editor needs to offer its variables: the extension, the frame, and the popups. */
export interface CodeVariables {
  readonly extension: Extension;
  /** The element the editor and the dot sit in; the chooser opens from it. */
  readonly frameRef: RefObject<HTMLDivElement>;
  /** The bind dot (for a whole value) and the chooser, drawn in the frame. */
  readonly overlay: ReactNode;
}

// How the chooser is open: following typing, or from the dot with its own search.
type ChooserState = { readonly kind: 'closed' } | { readonly kind: 'typing'; readonly typed: CodeTypedVariable } | { readonly kind: 'bind' };

const CLOSED: ChooserState = { kind: 'closed' };

/** The variables of a code editor whose text is `scope`; nothing is offered while it is read-only. */
export function useCodeVariables(scope: CodeVariableScope, access: { readonly readOnly: boolean }): CodeVariables {
  const translate = useTranslate();
  const frameRef = useRef<HTMLDivElement>(null);
  const dotRef = useRef<HTMLButtonElement>(null);
  const viewRef = useRef<EditorView | undefined>(undefined);
  const navigationRef = useRef<PickerNavigation | undefined>(undefined);
  const [chooser, setChooser] = useState<ChooserState>(CLOSED);
  const chooserRef = useRef(chooser);
  chooserRef.current = chooser;
  const readOnlyRef = useRef(access.readOnly);
  readOnlyRef.current = access.readOnly;
  // Read through a ref: callers build the scope inline, and a new object each
  // render must not rebuild the extension and reconfigure the editor.
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const { vars, loading } = useSharedVars({ active: chooser.kind !== 'closed' });
  const handlersRef = useRef<CodeVariableHandlers>(codeVariableHandlers({ scopeRef, viewRef, chooserRef, readOnlyRef, navigationRef, setChooser }));
  const [extension] = useState(() => codeVariableExtension(handlersRef));
  const pickTyped = (binding: string): void => {
    const view = viewRef.current;
    const current = chooserRef.current;
    setChooser(CLOSED);
    if (view === undefined || current.kind !== 'typing') {
      return;
    }
    completeInView(view, current.typed, binding);
  };
  const pickBind = (binding: string): void => {
    const view = viewRef.current;
    setChooser(CLOSED);
    if (view !== undefined) {
      bindInView(view, binding);
    }
  };
  const frame = frameRef.current ?? undefined;
  const overlay = (
    <>
      {scope.kind === 'value' && !access.readOnly ? (
        <ConnectDot
          dotRef={dotRef}
          disabled={false}
          ariaLabel={translate('styleModel.shared.connectVariable', { label: scope.prop })}
          open={chooser.kind === 'bind'}
          onPress={() => undefined}
          onToggle={() => setChooser(chooserRef.current.kind === 'bind' ? CLOSED : { kind: 'bind' })}
        />
      ) : undefined}
      {frame !== undefined && chooser.kind !== 'closed' ? (
        <VariablePicker
          anchor={frame}
          vars={vars}
          loading={loading}
          {...pickerProp(scope, chooser)}
          {...(chooser.kind === 'typing' ? { typing: { query: chooser.typed.typed.query, navigationRef } } : bindSelection(viewRef.current))}
          onPick={chooser.kind === 'typing' ? pickTyped : pickBind}
          onClose={() => setChooser(CLOSED)}
        />
      ) : undefined}
    </>
  );
  return { extension, frameRef, overlay };
}

// The handlers the extension calls. Built once: everything they read is behind a ref.
function codeVariableHandlers({
  scopeRef,
  viewRef,
  chooserRef,
  readOnlyRef,
  navigationRef,
  setChooser,
}: {
  readonly scopeRef: { readonly current: CodeVariableScope };
  readonly viewRef: MutableRefObject<EditorView | undefined>;
  readonly chooserRef: { readonly current: ChooserState };
  readonly readOnlyRef: { readonly current: boolean };
  readonly navigationRef: { readonly current: PickerNavigation | undefined };
  readonly setChooser: (next: ChooserState) => void;
}): CodeVariableHandlers {
  return {
    scope: () => scopeRef.current,
    onView: (view) => {
      viewRef.current = view;
    },
    onTyped: (typed, cause) => {
      const current = chooserRef.current;
      // The dot's chooser has its own search box, and typing there is not typing here.
      if (current.kind === 'bind') {
        return;
      }
      // A caret moved by hand only updates a chooser that typing opened: clicking
      // into an existing `var(--a)` is not asking for the list.
      if (cause === 'selection' && current.kind === 'closed') {
        return;
      }
      if (typed === undefined || readOnlyRef.current) {
        if (current.kind !== 'closed') {
          setChooser(CLOSED);
        }
        return;
      }
      setChooser({ kind: 'typing', typed });
    },
    onKey: (key) => chooserKey(key, chooserRef.current, navigationRef.current, () => setChooser(CLOSED)),
  };
}

// While the chooser follows typing, ↑ and ↓ move through it, Enter and Tab take
// the marked variable, and Escape puts it away: the Custom value box's keys.
function chooserKey(key: CodeVariableKey, chooser: ChooserState, navigation: PickerNavigation | undefined, dismiss: () => void): boolean {
  if (chooser.kind !== 'typing') {
    return false;
  }
  if (navigation === undefined) {
    return false;
  }
  switch (key) {
    case 'ArrowDown':
      navigation.move(1);
      return true;
    case 'ArrowUp':
      navigation.move(-1);
      return true;
    case 'Enter':
    case 'Tab':
      if (navigation.pick()) {
        return true;
      }
      dismiss();
      return false;
    case 'Escape':
      dismiss();
      return true;
    default: {
      const exhaustive: never = key;
      return exhaustive;
    }
  }
}

// The property the chooser filters by: the typed declaration's, or the value's.
function pickerProp(scope: CodeVariableScope, chooser: ChooserState): { readonly prop?: string } {
  assert(chooser.kind !== 'closed', 'pickerProp: only an open chooser filters');
  if (chooser.kind === 'typing') {
    return chooser.typed.prop === undefined ? {} : { prop: chooser.typed.prop };
  }
  return scope.kind === 'value' ? { prop: scope.prop } : {};
}

// The dot's chooser marks the variable the value already is, when it is one.
function bindSelection(view: EditorView | undefined): { readonly selectedBinding?: string } {
  const text = view?.state.doc.toString().trim() ?? '';
  return /^var\(\s*--[A-Za-z0-9_-]+[^)]*\)$/i.test(text) ? { selectedBinding: text } : {};
}
