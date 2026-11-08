import React, { useContext, useEffect, useRef, useState } from 'react';
import type { VariableCell } from '../../ipc/variablesBridge';
import { VARIABLES_LIMITS } from '../../ipc/variablesBridge';
import { assert } from '../../../shared/core/assert';
import ColorSwatch from '../style/components/ColorSwatch';
import VariableConnect, { connectCustomField } from '../style/VariableConnect';
import EasingEditor, { MiniCurve } from '../style/EasingEditor';
import { easingToBezier, isEasing } from '../style/model/transition';
import FluidBadge from './FluidBadge';
import { VariablePreviewContext } from './liveVariableEdits';
import CustomValue, { doesNotFit, isLong, withBinding } from '../style/CustomValueEditor';

type CellValue = VariableCell & {
  readonly fluid?: React.ComponentProps<typeof FluidBadge>['fluid'];
};
type FluidReport = React.ComponentProps<typeof FluidBadge>['fluid'];
export interface VariableCellProps {
  readonly cell: CellValue | undefined;
  readonly onSave: (cell: VariableCell, value: string) => void | Promise<void>;
  readonly fluidOf?: ((cell: VariableCell) => FluidReport) | undefined;
  readonly onDraft?: ((name: string, value: string | undefined) => void) | undefined;
}
interface PopulatedCellProps extends Omit<VariableCellProps, 'cell'> {
  readonly cell: CellValue;
}
interface CurveFrame {
  readonly left: number;
  readonly width: number;
}
const SAVE_ON = ['Enter', 'Tab'];
// The sheet permits one curve editor; opening the next commits and closes the previous one.
let closeOpenCurve: (() => void) | undefined;

// The sheet reports a refused write itself (a toast, then a reload from the
// file); what reaches here is a write that could not be attempted at all.
function reportSaveFailure(error: unknown): void {
  console.error('[stacki] variable save failed:', error);
}

export default function VariableCellEditor(props: VariableCellProps) {
  if (!props.cell) {
    return <div className="var-cell empty">—</div>;
  }
  // Sparse columns mount their editor only while populated, keeping hook order stable.
  return <PopulatedCell {...props} cell={props.cell} />;
}
function useVariableCell({ cell, onSave, fluidOf, onDraft }: PopulatedCellProps) {
  const [draft, setDraft] = useState<string | undefined>(undefined);
  // The anchor rect while the custom value editor is open.
  const [custom, setCustom] = useState<DOMRect | undefined>(undefined);
  const [curve, setCurve] = useState<CurveFrame | undefined>(undefined);
  const value = draft ?? cell.value;
  assert(value.length <= VARIABLES_LIMITS.fileCharsMax, 'Variable cell: value limit exceeded');
  assert(cell.name.length <= VARIABLES_LIMITS.fileCharsMax, 'Variable cell: name limit exceeded');

  // A reread that brings the value the field holds ends the draft. One that does
  // not is either our own earlier write landing while the field has moved on (a
  // held arrow key), or someone else's edit: the field keeps what is being typed.
  useEffect(() => setDraft((current) => (current === cell.value ? undefined : current)), [cell.value, cell.valueStart]);

  // Each draft straight to the canvas, and its end when it is abandoned. A draft
  // that ends because it was written is released by the save instead, once the
  // page has caught up (liveVariableEdits.ts).
  const preview = useContext(VariablePreviewContext);
  const previewed = useRef<string | undefined>(undefined);
  const cellRef = useRef(cell);
  cellRef.current = cell;
  useEffect(() => {
    if (draft === previewed.current) {
      return;
    }
    previewed.current = draft;
    preview?.(cellRef.current, draft);
  }, [draft, preview]);
  useEffect(
    () => () => {
      if (previewed.current !== undefined) {
        preview?.(cellRef.current, undefined);
      }
    },
    [preview],
  );

  // Every keystroke goes up as well as into the field: another row's badge may
  // be about this value.
  useEffect(() => {
    if (!cell?.name) {
      return undefined;
    }
    onDraft?.(cell.name, draft);
    return () => onDraft?.(cell.name, undefined);
  }, [cell?.name, draft, onDraft]);

  // The draft stays on screen until its write lands: cleared first, the field
  // showed the old value for the length of the write and the reread.
  const write = async (next: string) => {
    if (next === cell.value) {
      setDraft(undefined);
      return;
    }
    try {
      await onSave(cell, next);
    } finally {
      // Unless the field has moved on since: that draft is newer than this write.
      setDraft((current) => (current === next ? undefined : current));
    }
  };
  const commit = (next = value): void => {
    void write(next).catch(reportSaveFailure);
  };

  // Whatever `commit` is this render — the closer below outlives the render it
  // was made in, and must not write a value from an older one.
  const commitRef = useRef(commit);
  commitRef.current = commit;
  useEffect(() => {
    if (!curve) {
      return undefined;
    }
    closeOpenCurve?.(); // never two at once
    const close = () => {
      setCurve(undefined);
      commitRef.current();
    };
    closeOpenCurve = close;
    return () => {
      if (closeOpenCurve === close) {
        closeOpenCurve = undefined;
      }
    };
  }, [curve]);

  const isColor = !!cell.color || cell.unknownColor;

  // Where a press lands decides what it does. The field is not always the
  // <input>: as soon as a value carries a variable, the token editor takes its
  // place and the input is hidden behind it — so a long value full of
  // references (which is most long values) never saw the press at all when this
  // was bound to the input. It is bound to the cell instead.
  //
  // Two things keep their own press wherever they are: the colour box and the
  // connect dot, which do not edit the value at all. A chip keeps its own only
  // while the value FITS — in a cell showing half an expression the chip is
  // most of what there is to click, and swapping a variable you cannot see the
  // rest of is not what that press means. It opens the value instead, where the
  // chip is there to click at full size.
  const alwaysOwn = (target: EventTarget) => target instanceof Element && !!target.closest('.embed-editor_varconnect-dot, .u-color-swatch');

  const openCustom = (node: Element) => setCustom(node.getBoundingClientRect());

  return {
    cell,
    fluidOf,
    draft,
    setDraft,
    custom,
    setCustom,
    curve,
    setCurve,
    value,
    commit,
    isColor,
    alwaysOwn,
    openCustom,
  };
}

type CellState = ReturnType<typeof useVariableCell>;
function PopulatedCell(props: PopulatedCellProps) {
  const state = useVariableCell(props);
  return <CellView state={state} />;
}
function CellView({ state }: { readonly state: CellState }) {
  const { cell, fluidOf, custom, value, alwaysOwn, openCustom } = state;
  return (
    <div
      className="var-cell"
      onMouseDownCapture={(event) => {
        if (custom || alwaysOwn(event.target)) {
          return;
        }
        // Fits: everything in the field keeps its own press, chip included.
        if (!doesNotFit(event.currentTarget, value)) {
          return;
        }
        event.preventDefault();
        // And nothing else gets this press. preventDefault only cancels the
        // browser's own reaction (focus, caret); the chip's handler is another
        // listener further down and ran anyway — so a press on the chip of a
        // value too long to read opened the variable picker ON TOP of the
        // editor it had just opened. Stopping here in the capture phase means
        // the press reaches nothing inside the cell.
        event.stopPropagation();
        openCustom(event.currentTarget);
      }}
      // A held arrow nudges the draft, and the canvas follows each step live;
      // letting go is the moment the value is written, while the caret stays.
      onKeyUpCapture={(event) => {
        if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') {
          return;
        }
        if (state.draft !== undefined && state.draft !== cell.value) {
          state.commit(state.draft);
        }
      }}
      onKeyDownCapture={(event) => {
        // The same shortcut, wherever the caret is — the token editor holds it
        // as often as the input does.
        if (event.key !== '=' || custom) {
          return;
        }
        event.preventDefault();
        openCustom(event.currentTarget);
      }}
    >
      {/* A timing function is a curve, and a curve is easier to judge by eye
          than by four numbers — so it gets the same editor the style panel's
          transitions use. Beside the value, like a colour's swatch: the value
          itself stays editable as text. */}
      <CellCurveButton state={state} />
      <CellCurveEditor state={state} />
      <CellColor state={state} />
      <CellInput state={state} />
      {/* Only drawn when the value is a fluid clamp with something wrong with
          it — see fluidCheck in electron/project/cssVars.ts. */}
      <CellFluidBadge report={fluidOf ? fluidOf(cell) : cell.fluid} />
      <CellCustomValue state={state} />
    </div>
  );
}
// The badge takes no report at all when there is nothing to say.
function CellFluidBadge({ report }: { readonly report: FluidReport }) {
  return <FluidBadge {...(report ? { fluid: report } : {})} />;
}
function CellCurveButton({ state }: { readonly state: CellState }) {
  const { cell, setCurve, value } = state;
  return (
    <>
      {isEasing(value) && (
        <button
          type="button"
          className="var-ease"
          title={`Edit the curve for ${cell.name}`}
          aria-label={`Edit the curve for ${cell.name}`}
          // The editor belongs over the sheet it was opened from, not over the
          // panel beside it — so it is handed the sheet's own box. Read at the
          // press rather than held in state: the sheet is resizable.
          onClick={(event) => {
            const sheet = event.currentTarget.closest('.vars-view') || event.currentTarget.closest('.cms-view');
            const box = sheet?.getBoundingClientRect();
            // Always framed, even when the sheet measures nothing (a mid-layout
            // read): the window is the fallback, never the style panel's box —
            // the shared backdrop is pinned to that panel, and a popup opened
            // from here has nothing to do with it.
            setCurve(box?.width ? { left: box.left, width: box.width } : { left: 0, width: typeof window === 'undefined' ? 0 : window.innerWidth });
          }}
        >
          {/* The value's own curve, at glyph size — the same drawing the
              editor's presets use, so the button says which ease it opens. */}
          <MiniCurve b={easingToBezier(value)} />
        </button>
      )}
    </>
  );
}

function CellCurveEditor({ state }: { readonly state: CellState }) {
  const { setDraft, curve, setCurve, value, commit } = state;
  return (
    <>
      {curve && (
        <EasingEditor
          value={value}
          frame={curve}
          // Dragging a control point emits a value per frame. Those land in the
          // draft so the field follows the curve, and the file is written once,
          // when the editor closes — a drag is one edit, not sixty.
          onChange={(timing) => setDraft(timing)}
          onClose={() => {
            setCurve(undefined);
            commit();
          }}
        />
      )}
    </>
  );
}

function CellColor({ state }: { readonly state: CellState }) {
  const { cell, setDraft, value, commit, isColor } = state;
  return (
    <>
      {isColor && (
        <ColorSwatch
          // The colour, not the word "transparent". `cell.color` is a literal
          // the app can paint on its own; everything else is a value that
          // refers to something — `color-mix(in srgb, var(--brand-500), white
          // 80%)` is the ordinary way to write a tint — and those were handed
          // over as the string "transparent", which is a colour, so the swatch
          // painted it: a chequerboard beside a row whose colour is perfectly
          // knowable.
          //
          // Handed the value instead, the swatch resolves it the way every
          // other swatch in the app does (see computedColor.ts): substituted text
          // paints anywhere, and a reference that leads outside this file is
          // answered by the page.
          value={cell.color || cell.resolved || value}
          ariaLabel={`Choose the colour for ${cell.name}`}
          // Dragging in the picker fires live updates; only the settled value
          // is written, or a drag would be a hundred edits to the file.
          onChange={(color, live) => {
            if (live) {
              setDraft(color);
            } else {
              commit(color);
            }
          }}
        />
      )}
    </>
  );
}

function CellCustomValue({ state }: { readonly state: CellState }) {
  const { cell, setDraft, custom, setCustom, value, commit } = state;
  return (
    <>
      {custom && (
        <CustomValue
          connectField={connectCustomField}
          value={value}
          label={cell.name}
          anchor={custom}
          onCancel={() => {
            setCustom(undefined);
            setDraft(undefined);
          }}
          onSave={(next) => {
            setCustom(undefined);
            commit(next);
          }}
        />
      )}
    </>
  );
}

function CellInput({ state }: { readonly state: CellState }) {
  const { cell, setDraft, custom, setCustom, value, commit } = state;
  return (
    <VariableConnect
      className="is-fill"
      code
      onPick={(binding) => commit(withBinding(value, binding))}
      // The rich field commits on blur, which is right for writing and wrong
      // for watching: a badge about this value has to answer to the keystroke.
      onDraft={(next) => setDraft(next)}
    >
      <input
        maxLength={VARIABLES_LIMITS.fileCharsMax}
        className="var-input"
        value={value}
        spellCheck={false}
        title={`${cell.name}: ${cell.value}${cell.resolved ? `\n→ ${cell.resolved}` : ''}`}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          if (!custom) {
            commit();
          }
        }}
        // Arriving by keyboard: the value is what you came to replace.
        //
        // Only when the focus is really this input's. The rich field calls
        // this handler itself when IT takes focus (VariableConnect hands it a
        // stand-in event pointing here), and select() on an input focuses it
        // — so clicking a value moved the caret into the hidden input behind
        // the field, where nothing typed and nothing showed.
        onFocus={(event) => {
          if (document.activeElement !== event.currentTarget) {
            return;
          }
          event.currentTarget.select();
        }}
        onMouseDown={(event) => {
          // A value too long for its column edits in the bigger box instead —
          // clicking it there would put the caret in a slot showing a third
          // of what is being changed.
          if (isLong(value)) {
            event.preventDefault();
            setCustom(event.currentTarget.getBoundingClientRect());
            return;
          }
          // Clicking in takes the whole value, because replacing it is what
          // you are nearly always here to do. Selecting on focus alone does
          // not hold — the click that caused the focus then puts the caret
          // where it landed and drops the selection — so the caret placement
          // is what gets skipped. A second click, once the field already has
          // focus, behaves normally and can place the caret or drag over
          // part of the value.
          if (document.activeElement === event.currentTarget) {
            return;
          }
          event.preventDefault();
          event.currentTarget.focus();
          event.currentTarget.select();
        }}
        onKeyDown={(event) => {
          if (event.key === '=') {
            event.preventDefault();
            setCustom(event.currentTarget.getBoundingClientRect());
            return;
          }
          if (SAVE_ON.includes(event.key)) {
            event.preventDefault();
            event.currentTarget.blur();
          }
          if (event.key === 'Escape') {
            event.preventDefault();
            setDraft(undefined);
          }
        }}
      />
    </VariableConnect>
  );
}
