import Popup from '../../ui/Popup';
import React, { useEffect, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import DataPicker from './DataPicker';
import type { DataPickerProps } from './DataPicker';
import { dataTree } from '../../editor/dataSuggest';
import type { DataContext } from '../../editor/dataSuggest';
import { resolvePick } from '../../editor/bindings';
import { deleteChipAtCaret } from './chipKeys';
import { nodesToHtml, isChippable } from './richContentModel';
import type { InlineNode } from './richContentModel';
import {
  richApplyLink,
  richContentNodes,
  richExec,
  richReadStates,
  richWrapTag,
  type FormatState,
  type RichTarget,
} from './richFormat';
import {
  RichFormatButtons,
  RichLinkField,
  richBubblePlace,
  type Bubble,
  type BubblePosition,
} from './RichFormatButtons';
export {
  INLINE_TAGS,
  isSimpleExpr,
  isInlineOnly,
  isChippable,
  nodesToHtml,
} from './richContentModel';
export type { InlineNode } from './richContentModel';

export interface RichContext extends DataContext {
  readonly entryNav?: DataPickerProps['entries'];
  readonly onStepItem?: DataPickerProps['onStepItem'];
  readonly onNeedSample?: (collection: string) => void;
  readonly ensureQuery?: (collection: string) => string | undefined;
}
export interface RichInsertAPI {
  readonly insert: (path: string) => void;
}
interface RichContentProps {
  readonly nodes: readonly InlineNode[];
  readonly onChange: (nodes: InlineNode[]) => void;
  readonly bindContext?: RichContext | undefined;
  readonly insertRef?: MutableRefObject<RichInsertAPI | undefined>;
}
interface ChipMenu {
  readonly chip: Element;
  readonly left: number;
  readonly top: number;
  readonly current: string;
}
export default function RichContent({ nodes, onChange, bindContext, insertRef }: RichContentProps) {
  const state = useRichState();
  const { hostRef } = state;
  const emit = () => richEmit(state, onChange);
  const { onChipMouseDown, pickExpr } = richChipActions(state, emit);
  useRichSync(nodes, state);
  useRichCaret(state);
  useRichInsertion(insertRef, state, emit);
  useRichSelection(state);
  useRichPosition(state);
  const onBlur = useRichBlur(state);
  return (
    <>
      <div
        ref={hostRef}
        className="rich-content"
        contentEditable
        suppressContentEditableWarning
        spellCheck={false}
        onBlur={onBlur}
        onInput={emit}
        onMouseDown={onChipMouseDown}
        onKeyDown={(event) => {
          // Keep formatting shortcuts local; Enter inserts <br> (inline field).
          if (event.key === 'Enter') {
            event.preventDefault();
            document.execCommand('insertHTML', false, '<br>');
            emit();
            return;
          }
          // Backspace against a chip takes that chip, and only that chip —
          // not the sentence it sits in.
          if (deleteChipAtCaret(hostRef.current ?? undefined, event)) {
            event.preventDefault();
            emit();
          }
        }}
      />
      <RichChipMenu state={state} bindContext={bindContext} pickExpr={pickExpr} />
      <RichBubble state={state} emit={emit} />
    </>
  );
}

function useRichState() {
  const hostRef = useRef<HTMLDivElement>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const lastEmittedRef = useRef<string | undefined>(undefined);
  const savedRangeRef = useRef<Range | undefined>(undefined);
  const [bubble, setBubble] = useState<Bubble | undefined>(undefined);
  const [position, setPosition] = useState<BubblePosition | undefined>(undefined);
  const [states, setStates] = useState<FormatState>({}); // {bold, italic, …} at the selection
  const [linkMode, setLinkMode] = useState(false);
  // The chip menu: {chip, left, top, current}.
  const [chipMenu, setChipMenu] = useState<ChipMenu | undefined>(undefined);
  const [linkUrl, setLinkUrl] = useState('');

  const caretRef = useRef<Range | undefined>(undefined);
  return {
    hostRef,
    bubbleRef,
    lastEmittedRef,
    savedRangeRef,
    caretRef,
    bubble,
    setBubble,
    pos: position,
    setPos: setPosition,
    states,
    setStates,
    linkMode,
    setLinkMode,
    chipMenu,
    setChipMenu,
    linkUrl,
    setLinkUrl,
  };
}

type RichState = ReturnType<typeof useRichState>;
function useRichSync(nodes: readonly InlineNode[], state: RichState) {
  const { hostRef, lastEmittedRef } = state;
  const html = nodesToHtml(nodes, isChippable);

  // Load / external updates. lastEmittedRef holds the canonical html of the
  // nodes this editor last emitted, so an incoming value that matches it is
  // just our own edit echoing back through the app — leave the DOM (and the
  // caret) alone. Anything else is a real external change: an undo, a file
  // reload, a chip switched from elsewhere. Keying this off document focus
  // instead used to drop those updates whenever the field happened to hold
  // focus, which is exactly when an undo arrives.
  useEffect(() => {
    const element = hostRef.current;
    if (!element) {
      return;
    }
    if (html !== lastEmittedRef.current) {
      element.innerHTML = html;
      lastEmittedRef.current = html;
    }
  }, [html, hostRef, lastEmittedRef]);
}
function richEmit(state: RichState, onChange: RichContentProps['onChange']): void {
  const { hostRef, lastEmittedRef } = state;
  const element = hostRef.current;
  if (!element) {
    return;
  }
  const next = richContentNodes(element);
  // Canonical, not el.innerHTML: the app hands the nodes back with ids
  // added and the browser normalises markup as you type, so only the
  // serialised form is comparable on the way back in.
  lastEmittedRef.current = nodesToHtml(next, isChippable);
  onChange(next);
}
function useRichCaret(state: RichState): void {
  const { hostRef, caretRef } = state;
  // Where the caret is, saved whenever it is inside the editor. The bubble
  // below only tracks real selections; inserting data needs the collapsed
  // caret too, and by the time the picker is open focus has left the editor.

  useEffect(() => {
    const onSelectionChange = () => {
      const element = hostRef.current;
      const selection = window.getSelection();
      if (!element || !selection?.rangeCount) {
        return;
      }
      const range = selection.getRangeAt(0);
      if (element.contains(range.commonAncestorContainer)) {
        caretRef.current = range.cloneRange();
      }
    };
    document.addEventListener('selectionchange', onSelectionChange);
    return () => document.removeEventListener('selectionchange', onSelectionChange);
  }, [hostRef, caretRef]);
}
function useRichInsertion(
  insertRef: RichContentProps['insertRef'],
  state: RichState,
  emit: () => void,
) {
  const { hostRef, caretRef } = state;
  // Dropping data in from outside — the Content field's own insert button.
  useEffect(() => {
    if (!insertRef) {
      return undefined;
    }
    insertRef.current = {
      insert(path: string) {
        const element = hostRef.current;
        if (!element) {
          return;
        }
        element.focus();
        const selection = window.getSelection();
        const saved = caretRef.current;
        const range = document.createRange();
        if (saved && element.contains(saved.commonAncestorContainer)) {
          range.setStart(saved.startContainer, saved.startOffset);
          range.setEnd(saved.endContainer, saved.endOffset);
        } else {
          range.selectNodeContents(element);
          range.collapse(false);
        }
        if (!selection) {
          return;
        }
        selection.removeAllRanges();
        selection.addRange(range);
        document.execCommand(
          'insertHTML',
          false,
          `<span class="expr-chip" contenteditable="false" data-expr="{${path}}">${path}</span>`,
        );
        emit();
      },
    };
    return () => {
      insertRef.current = undefined;
    };
  });
}
function useRichSelection(state: RichState): void {
  const { linkMode, hostRef, savedRangeRef, setBubble, setStates } = state;
  // Selection bubble: track selections anchored inside the editor.
  useEffect(() => {
    const onSelectionChange = () => {
      if (linkMode) {
        return;
      } // keep the bubble while typing a URL
      const element = hostRef.current;
      const selection = window.getSelection();
      if (
        !element ||
        !selection ||
        selection.rangeCount === 0 ||
        selection.isCollapsed ||
        !element.contains(selection.anchorNode) ||
        !element.contains(selection.focusNode)
      ) {
        setBubble(undefined);
        return;
      }
      const rect = selection.getRangeAt(0).getBoundingClientRect();
      if (!rect.width && !rect.height) {
        setBubble(undefined);
        return;
      }
      savedRangeRef.current = selection.getRangeAt(0).cloneRange();
      setBubble({ x: rect.left + rect.width / 2, top: rect.top, bottom: rect.bottom });
      setStates(richReadStates(hostRef.current ?? undefined));
    };
    document.addEventListener('selectionchange', onSelectionChange);
    return () => document.removeEventListener('selectionchange', onSelectionChange);
  }, [hostRef, savedRangeRef, linkMode, setBubble, setStates]);
}
function useRichPosition(state: RichState): void {
  const { bubbleRef, bubble, linkMode, setPos: setPosition } = state;
  // Measure the rendered bubble and keep it inside the window: clamp
  // horizontally, flip below the selection when it would hit the titlebar,
  // and keep the arrow pointing at the selection midpoint.
  React.useLayoutEffect(() => {
    const element = bubbleRef.current;
    if (!bubble || !element) {
      setPosition(undefined);
      return;
    }
    setPosition(richBubblePlace(bubble, element));
  }, [bubble, linkMode, bubbleRef, setPosition]);
}
// The panel's presses: the shared formatting (richFormat.ts) on this field's
// own editable element, then the new content out and the buttons relit.
const richTarget = (state: RichState): RichTarget => ({
  host: state.hostRef.current ?? undefined,
  savedRange: state.savedRangeRef,
});
function richSettle(state: RichState, emit: () => void): void {
  emit();
  state.setStates(richReadStates(state.hostRef.current ?? undefined));
}
function richApplyLinkField(state: RichState, emit: () => void): void {
  const { linkUrl, setLinkMode, setLinkUrl } = state;
  setLinkMode(false);
  setLinkUrl('');
  if (richApplyLink(richTarget(state), linkUrl)) {
    richSettle(state, emit);
  }
}
function richChipActions(state: RichState, emit: () => void) {
  const { chipMenu, setChipMenu } = state;
  // Clicking a chip offers the other values in scope. mousedown rather than
  // click, and preventDefault, so the caret never lands inside the chip.
  const onChipMouseDown = (event: React.MouseEvent<HTMLDivElement>) => {
    const ElementType = event.currentTarget.ownerDocument.defaultView?.Element;
    const chip =
      ElementType && event.target instanceof ElementType
        ? event.target.closest('.expr-chip')
        : undefined;
    if (!chip) {
      return;
    }
    event.preventDefault();
    const rect = chip.getBoundingClientRect();
    setChipMenu({
      chip,
      left: rect.left,
      top: rect.bottom + 4,
      current: (chip.getAttribute('data-expr') || '').replace(/^\{|\}$/g, ''),
    });
  };

  const pickExpr = (insert: string) => {
    const chip = chipMenu?.chip;
    setChipMenu(undefined);
    if (!chip) {
      return;
    }
    chip.setAttribute('data-expr', '{' + insert + '}');
    chip.textContent = insert;
    emit();
  };

  return { onChipMouseDown, pickExpr };
}
function RichChipMenu({
  state,
  bindContext,
  pickExpr,
}: {
  readonly state: RichState;
  readonly bindContext: RichContext | undefined;
  readonly pickExpr: (path: string) => void;
}) {
  const { chipMenu } = state;
  if (!chipMenu) {
    return undefined;
  }
  return (
    <Popup
      mode="popover"
      portal={false}
      onClose={() => state.setChipMenu(undefined)}
      className="dd-popup bind-menu"
      style={{ left: chipMenu.left, top: chipMenu.top, width: 260 }}
    >
      <DataPicker
        tree={dataTree(bindContext || {})}
        current={chipMenu.current}
        entries={bindContext?.entryNav ?? undefined}
        {...(bindContext?.onStepItem ? { onStepItem: bindContext.onStepItem } : {})}
        onPick={(path, query) =>
          pickExpr(resolvePick(path, query ?? undefined, bindContext ?? undefined))
        }
        onExpand={(node) => node.query && bindContext?.onNeedSample?.(node.query.collection)}
        footer={false}
      />
    </Popup>
  );
}
type BubbleStyle = React.CSSProperties & { readonly '--arrow-x': string };
function RichBubble({ state, emit }: { readonly state: RichState; readonly emit: () => void }) {
  const { bubble, bubbleRef, pos: position, linkMode } = state;
  if (!bubble) {
    return undefined;
  }
  const style: BubbleStyle = {
    left: position ? position.left : bubble.x,
    top: position ? position.top : bubble.top - 10,
    visibility: position ? 'visible' : 'hidden',
    '--arrow-x': position ? `${position.arrowX}px` : '50%',
  };
  return (
    <div
      ref={bubbleRef}
      className={`rich-bubble ${position?.below ? 'below' : ''}`}
      style={style}
      onMouseDown={(event) => event.stopPropagation()}
    >
      {linkMode ? (
        <RichLinkInput state={state} emit={emit} />
      ) : (
        <RichButtons state={state} emit={emit} />
      )}
    </div>
  );
}
function RichLinkInput({ state, emit }: { readonly state: RichState; readonly emit: () => void }) {
  const { linkUrl, setLinkUrl, setLinkMode } = state;
  return (
    <RichLinkField
      value={linkUrl}
      onChange={setLinkUrl}
      onApply={() => richApplyLinkField(state, emit)}
      onCancel={() => {
        setLinkMode(false);
        setLinkUrl('');
      }}
    />
  );
}
function RichButtons({ state, emit }: { readonly state: RichState; readonly emit: () => void }) {
  return (
    <RichFormatButtons
      states={state.states}
      onExec={(command) => {
        richExec(richTarget(state), command);
        richSettle(state, emit);
      }}
      onWrap={(tag) => {
        if (richWrapTag(richTarget(state), tag)) {
          richSettle(state, emit);
        }
      }}
      onLink={() => state.setLinkMode(true)}
    />
  );
}
function useRichBlur(state: RichState): () => void {
  const { linkMode, setBubble } = state;
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(
    () => () => {
      if (timer.current !== undefined) {
        clearTimeout(timer.current);
      }
    },
    [],
  );
  return () => {
    if (timer.current !== undefined) {
      clearTimeout(timer.current);
    }
    timer.current = setTimeout(() => {
      timer.current = undefined;
      setBubble((bubble) => (linkMode ? bubble : undefined));
    }, 150);
  };
}
