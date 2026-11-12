// The list that opens under the caret when the trigger character is typed: candidates in
// groups, one highlighted, chosen by the keys `pickerKeymap` routes from the editor or by a
// click. It knows candidates, not what they stand for.
//
// The editor keeps focus the whole time (a press on a row is stopped from taking it), so the
// highlight is controlled from outside (`activeIndex`) and the rows carry ids a caller can
// point the editor's aria-activedescendant at (`chipPickerOptionId`). Rows render up to
// CHIP_PICKER_ROWS_MAX; the caller narrows the list by the query before passing it in.
import { useCallback, useLayoutEffect, useState } from 'react';
import type { ReactNode, RefCallback } from 'react';
import { assert } from '../../../shared/core/assert';
import Popup from '../Popup';
import { placeMenu } from '../menuModel';
import type { MenuPosition } from '../menuModel';
import './chipEditor.css';

export const CHIP_PICKER_ROWS_MAX = 12;

export interface ChipPickerCandidate {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  /** Candidates with the same group are listed together under its name, in the order groups first appear. */
  readonly group?: string;
  readonly icon?: ReactNode;
}

export interface ChipPickerProps {
  readonly open: boolean;
  /** Viewport coordinates of the caret: the list opens below it, or above when there is no room. */
  readonly anchor: { readonly left: number; readonly top: number; readonly bottom: number } | undefined;
  readonly candidates: readonly ChipPickerCandidate[];
  readonly activeIndex: number;
  /** The listbox's accessible name and the prefix of its row ids. */
  readonly label: string;
  readonly listId: string;
  readonly emptyText: string;
  readonly onActiveChange: (index: number) => void;
  readonly onChoose: (candidate: ChipPickerCandidate) => void;
  readonly onClose: () => void;
}

export function chipPickerOptionId(listId: string, index: number): string {
  return `${listId}-option-${index}`;
}

const WIDTH_PX = 280;

export function ChipPicker(props: ChipPickerProps) {
  assert(props.candidates.length <= CHIP_PICKER_ROWS_MAX, 'ChipPicker: the caller narrows the list to the rows that fit');
  assert(props.activeIndex >= 0, 'ChipPicker: the active row is not negative');
  const [surface, setSurface] = useState<HTMLDivElement | undefined>(undefined);
  const [measured, setMeasured] = useState<MenuPosition | undefined>(undefined);
  const attach = useCallback<RefCallback<HTMLDivElement>>((element) => setSurface(element ?? undefined), []);
  const anchor = props.anchor;
  const box = anchor === undefined ? undefined : { left: anchor.left, top: anchor.top, width: 0, height: anchor.bottom - anchor.top };
  useLayoutEffect(() => {
    if (surface === undefined || box === undefined) {
      return;
    }
    const rectangle = surface.getBoundingClientRect();
    if (rectangle.width > 0 && rectangle.height > 0) {
      setMeasured(placeMenu(box, rectangle, { width: window.innerWidth, height: window.innerHeight }, 'below-start'));
    }
    // The box is rebuilt from `anchor` each render; its fields are the real dependencies.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- depends on the anchor's numbers, not the object
  }, [surface, anchor?.left, anchor?.top, anchor?.bottom, props.candidates.length]);
  if (box === undefined) {
    return undefined;
  }
  const estimate = placeMenu(
    box,
    { width: WIDTH_PX, height: Math.max(1, props.candidates.length) * 34 + 12 },
    { width: window.innerWidth, height: window.innerHeight },
    'below-start',
  );
  const shown = measured ?? estimate;
  let lastGroup: string | undefined;
  return (
    <Popup
      mode="popover"
      open={props.open}
      onClose={props.onClose}
      ref={attach}
      keepOnScroll
      role="listbox"
      label={props.label}
      className="chip-picker"
      style={{ position: 'fixed', left: shown.left, top: shown.top, width: WIDTH_PX }}
      // A press on a row must not move focus out of the editor.
      onMouseDown={(event) => event.preventDefault()}
    >
      {props.candidates.length === 0 ? (
        <div className="chip-picker-empty">{props.emptyText}</div>
      ) : (
        props.candidates.map((candidate, index) => {
          const heading = candidate.group !== undefined && candidate.group !== lastGroup ? candidate.group : undefined;
          lastGroup = candidate.group;
          return (
            <div key={candidate.id} role="presentation">
              {heading !== undefined && (
                <div role="presentation" className="chip-picker-heading">
                  {heading}
                </div>
              )}
              <div
                role="option"
                id={chipPickerOptionId(props.listId, index)}
                aria-selected={index === props.activeIndex}
                className={index === props.activeIndex ? 'chip-picker-option is-active' : 'chip-picker-option'}
                onMouseEnter={() => props.onActiveChange(index)}
                onClick={() => props.onChoose(candidate)}
              >
                {candidate.icon !== undefined && <span className="chip-picker-icon">{candidate.icon}</span>}
                <span className="chip-picker-text">
                  <span className="chip-picker-label">{candidate.label}</span>
                  {candidate.description !== undefined && <span className="chip-picker-description">{candidate.description}</span>}
                </span>
              </div>
            </div>
          );
        })
      )}
    </Popup>
  );
}
