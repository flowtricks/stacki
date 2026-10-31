import Popup from './Popup';
import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent, MutableRefObject, ReactNode, RefObject } from 'react';
import { endDragNotes, hoverNote } from './sound';
import { useSoundHere } from './soundScope';
import { ChevronDownIcon, CheckIcon } from './Icons';
import { assert } from '../../shared/core/assert';
import { LIMITS } from '../../shared/core/limits';

export const POPUP_GAP = 4;
const POPUP_EDGE = 8;
const POPUP_MIN = 120;
const POPUP_PADDING_HEIGHT = 8;
const OPTION_HEIGHT = 26;
const SEARCH_HEIGHT = 36;
// The tallest a list grows before it scrolls: about a dozen options, so a long
// list (time zones, locales) is a list to scroll, not a wall down the window.
const MENU_HEIGHT_MAX = 320;
export function popupBox(
  rectangle: Pick<DOMRect, 'top' | 'bottom'>,
  wanted: number,
  windowHeight: number,
) {
  const below = windowHeight - rectangle.bottom - POPUP_GAP - POPUP_EDGE;
  const above = rectangle.top - POPUP_GAP - POPUP_EDGE;
  const up = wanted > below && above > below;
  const room = Math.max(POPUP_MIN, up ? above : below);
  return {
    top: up ? undefined : rectangle.bottom + POPUP_GAP,
    bottom: up ? windowHeight - rectangle.top + POPUP_GAP : undefined,
    maxHeight: wanted > room ? room : undefined,
  };
}
export interface DropdownOption<T = string> {
  readonly value: T;
  readonly label: string;
  readonly hint?: string;
  readonly group?: string;
  readonly description?: string;
  readonly icon?: ReactNode;
  readonly dim?: boolean;
}
export interface DropdownProps<T = string> {
  readonly disabled?: boolean;
  readonly ariaLabel?: string;
  readonly value: T;
  readonly options: readonly DropdownOption<T>[];
  readonly onChange: (value: T) => void;
  readonly className?: string;
  readonly menuClassName?: string;
  readonly placeholder?: string;
  readonly livePreview?: boolean;
  readonly onPrepare?: () => void;
  readonly onPreview?: (value: T) => void;
  readonly onCancelPreview?: () => void;
  readonly onCommitPreview?: () => void;
  readonly searchable?: boolean;
  readonly searchPlaceholder?: string;
}
interface Selection<T> {
  readonly open: boolean;
  readonly highlight: number;
  readonly query: string;
  readonly visible: readonly DropdownOption<T>[];
  readonly selected: DropdownOption<T> | undefined;
  readonly setOpen: (open: boolean) => void;
  readonly setHighlight: (highlight: number) => void;
  readonly setQuery: (query: string) => void;
  readonly triggerRef: RefObject<HTMLButtonElement>;
  readonly popupRef: RefObject<HTMLDivElement>;
  readonly listRef: RefObject<HTMLDivElement>;
  readonly searchRef: RefObject<HTMLInputElement>;
  readonly committed: MutableRefObject<T>;
  // Boxed, so previewing an option whose value is itself undefined still counts.
  readonly previewed: MutableRefObject<{ readonly value: T } | undefined>;
}
interface Actions<T> {
  readonly openPopup: () => void;
  readonly close: () => void;
  readonly preview: (index: number) => void;
  readonly hover: (index: number) => void;
  readonly pick: (option: DropdownOption<T>) => void;
}
type Controller<T> = Selection<T> & Actions<T>;
type PopupPosition = ReturnType<typeof popupBox> & {
  readonly left: number;
  readonly width: number;
};

// Hover previews remain distinct from committed choices: closing reverts, while
// selecting an already-previewed row avoids writing the same value twice.
export default function Dropdown<T>(props: DropdownProps<T>) {
  const state = useDropdownSelection(props);
  const actions = useDropdownActions(props, state);
  const control = { ...state, ...actions };
  const position = useDropdownPosition(state, { searchable: props.searchable ?? false });
  useDropdownSound(state);
  useDropdownFocus(state, { searchable: props.searchable ?? false });
  useEffect(() => {
    if (props.disabled && state.open) {
      actions.close();
    }
  }, [props.disabled, state.open, actions]);
  const onKey = (event: KeyboardEvent<HTMLElement>) => dropdownKey(event, control, props);
  return (
    <>
      <button
        type="button"
        disabled={props.disabled}
        aria-label={props.ariaLabel}
        aria-expanded={state.open}
        ref={state.triggerRef}
        className={`dd-trigger ${props.className || ''}`}
        onMouseEnter={props.onPrepare}
        onFocus={props.onPrepare}
        onClick={() => (state.open ? actions.close() : actions.openPopup())}
        onKeyDown={onKey}
      >
        {state.selected?.icon && <span className="dd-icon">{state.selected.icon}</span>}
        <span className={`dd-label ${state.selected && !state.selected.dim ? '' : 'dim'}`}>
          {state.selected ? state.selected.label : props.placeholder || ''}
        </span>
        <span className="dd-chevron">
          <ChevronDownIcon size={11} />
        </span>
      </button>
      {position && (
        <DropdownPopup control={control} props={props} position={position} onKey={onKey} />
      )}
    </>
  );
}

function useDropdownSelection<T>(props: DropdownProps<T>): Selection<T> {
  assert(props.options.length <= LIMITS.scanEntriesMax, 'Dropdown option count exceeds limit');
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  const [query, setQuery] = useState('');
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const committed = useRef(props.value);
  const previewed = useRef<{ readonly value: T } | undefined>(undefined);
  const queryText = query.trim().toLowerCase();
  const visible =
    props.searchable && queryText
      ? props.options.filter((option) =>
          `${option.label} ${option.hint || ''} ${option.group || ''}`
            .toLowerCase()
            .includes(queryText),
        )
      : props.options;
  return {
    open,
    setOpen,
    highlight,
    setHighlight,
    query,
    setQuery,
    visible,
    selected: props.options.find((option) => option.value === props.value),
    triggerRef,
    popupRef,
    listRef,
    searchRef,
    committed,
    previewed,
  };
}

// One frame lets an immediate press commit before hover preview rerenders its row.
// Waiting longer makes the canvas feel stale as the pointer crosses options.
function useDropdownActions<T>(props: DropdownProps<T>, state: Selection<T>): Actions<T> {
  const { setOpen, setHighlight, committed, previewed, visible } = state;
  const {
    value,
    options,
    onChange,
    onPreview,
    onPrepare,
    onCancelPreview,
    livePreview = true,
  } = props;
  const hoverFrame = useRef<number | undefined>(undefined);
  const cancelHover = useCallback((): void => {
    if (hoverFrame.current !== undefined) {
      window.cancelAnimationFrame(hoverFrame.current);
      hoverFrame.current = undefined;
    }
  }, []);
  useEffect(() => () => cancelHover(), [cancelHover]);
  const previewOption = (option: DropdownOption<T>): void => {
    if (!livePreview) {
      return;
    }
    const applied = previewed.current?.value ?? committed.current;
    if (option.value !== applied) {
      previewed.current = { value: option.value };
      (onPreview ?? onChange)(option.value);
    }
  };
  const close = useCallback(() => {
    cancelHover();
    setOpen(false);
    if (onCancelPreview) {
      onCancelPreview();
    } else if (previewed.current !== undefined && previewed.current.value !== committed.current) {
      onChange(committed.current);
    }
    previewed.current = undefined;
  }, [setOpen, previewed, committed, onChange, cancelHover, onCancelPreview]);
  return {
    close,
    openPopup: () => {
      cancelHover();
      onPrepare?.();
      initializeDropdown(state, value);
      setHighlight(options.findIndex((option) => option.value === value));
      setOpen(true);
    },
    preview: (index) => {
      cancelHover();
      setHighlight(index);
      const option = visible[index];
      if (option) {
        previewOption(option);
      }
    },
    hover: (index) => {
      cancelHover();
      setHighlight(index);
      const option = visible[index];
      if (option && livePreview) {
        hoverFrame.current = window.requestAnimationFrame(() => previewOption(option));
      }
    },
    pick: (option) => {
      cancelHover();
      commitDropdownOption(props, state, option);
    },
  };
}

function initializeDropdown<T>(state: Selection<T>, value: T): void {
  const { committed, previewed, setQuery } = state;
  committed.current = value;
  previewed.current = undefined;
  setQuery('');
}

function commitDropdownOption<T>(
  props: DropdownProps<T>,
  state: Selection<T>,
  option: DropdownOption<T>,
): void {
  const { onPreview, onCancelPreview, onCommitPreview, onChange } = props;
  const { committed, previewed, setOpen, triggerRef } = state;
  const applied = onPreview ? committed.current : (previewed.current?.value ?? committed.current);
  if (onPreview) {
    onPreview(option.value);
    if (option.value === committed.current) {
      onCancelPreview?.();
    } else {
      onCommitPreview?.();
    }
  }
  committed.current = option.value;
  previewed.current = undefined;
  setOpen(false);
  if (option.value !== applied) {
    onChange(option.value);
  }
  triggerRef.current?.focus();
}

function useDropdownPosition<T>(state: Selection<T>, options: { readonly searchable: boolean }) {
  const [position, setPosition] = useState<PopupPosition | undefined>(undefined);
  const { open, triggerRef, visible } = state;
  const { searchable } = options;
  useLayoutEffect(() => {
    if (!open || !triggerRef.current) {
      return;
    }
    const rectangle = triggerRef.current.getBoundingClientRect();
    // The popup constrains its scrolling list. Measuring the constrained popup
    // makes a long list alternate between capped and uncapped heights until
    // React aborts the render loop, so derive its intrinsic height from the
    // dimensions this component owns instead.
    const wanted =
      (visible.length + dropdownGroupCount(visible)) * OPTION_HEIGHT +
      POPUP_PADDING_HEIGHT +
      (searchable ? SEARCH_HEIGHT : 0);
    const shown = Math.min(wanted, MENU_HEIGHT_MAX);
    const box = popupBox(rectangle, shown, window.innerHeight);
    const next = {
      left: rectangle.left,
      width: rectangle.width,
      ...box,
      maxHeight: wanted > shown ? Math.min(box.maxHeight ?? shown, shown) : box.maxHeight,
    };
    setPosition((previous) =>
      previous &&
      previous.left === next.left &&
      previous.width === next.width &&
      previous.top === next.top &&
      previous.bottom === next.bottom &&
      previous.maxHeight === next.maxHeight
        ? previous
        : next,
    );
  }, [open, triggerRef, visible, searchable]);
  return position;
}

function useDropdownSound<T>({ open, highlight, visible }: Selection<T>): void {
  const sounds = useSoundHere();
  const placed = useRef(false);
  useEffect(() => {
    if (!sounds) {
      return;
    }
    if (!open) {
      if (placed.current) {
        placed.current = false;
        endDragNotes();
      }
      return;
    }
    if (!placed.current) {
      placed.current = true;
      return;
    }
    if (visible[highlight]) {
      hoverNote(highlight, visible.length);
    }
  }, [sounds, open, highlight, visible]);
}

function useDropdownFocus<T>(state: Selection<T>, options: { readonly searchable: boolean }): void {
  const { open, highlight, listRef, popupRef, searchRef } = state;
  const { searchable } = options;
  useEffect(() => {
    if (!open || highlight < 0) {
      return;
    }
    const timer = window.setTimeout(() => {
      (listRef.current || popupRef.current)
        ?.querySelectorAll('.dd-option')
        [highlight]?.scrollIntoView({
          block: 'nearest',
        });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [open, highlight, listRef, popupRef]);
  useEffect(() => {
    if (!open || !searchable) {
      return undefined;
    }
    const timer = setTimeout(() => searchRef.current?.focus(), 0);
    return () => clearTimeout(timer);
  }, [open, searchable, searchRef]);
}

function dropdownKey<T>(
  event: KeyboardEvent<HTMLElement>,
  control: Controller<T>,
  props: DropdownProps<T>,
): void {
  if (!control.open) {
    if (['Enter', ' ', 'ArrowDown', 'ArrowUp'].includes(event.key)) {
      event.preventDefault();
      control.openPopup();
    }
    return;
  }
  switch (event.key) {
    case 'Escape':
      event.preventDefault();
      control.close();
      break;
    case 'ArrowDown':
      event.preventDefault();
      control.preview(Math.min(control.highlight + 1, control.visible.length - 1));
      break;
    case 'ArrowUp':
      event.preventDefault();
      control.preview(Math.max(control.highlight - 1, 0));
      break;
    case ' ': {
      if (props.searchable) {
        return;
      }
      event.preventDefault();
      const option = control.visible[control.highlight];
      if (option) {
        control.pick(option);
      }
      break;
    }
    case 'Enter': {
      event.preventDefault();
      const option = control.visible[control.highlight];
      if (option) {
        control.pick(option);
      }
      break;
    }
    case 'Tab':
      control.close();
      break;
  }
}

interface PopupProps<T> {
  readonly control: Controller<T>;
  readonly props: DropdownProps<T>;
  readonly position: PopupPosition;
  readonly onKey: (event: KeyboardEvent<HTMLElement>) => void;
}
function DropdownPopup<T>({ control, props, position, onKey }: PopupProps<T>) {
  return (
    <Popup
      mode="popover"
      open={control.open}
      anchor={control.triggerRef.current ?? undefined}
      onClose={control.close}
      ref={control.popupRef}
      className={`dd-popup ${props.searchable ? 'dd-searchable' : ''} ${props.menuClassName || ''}`}
      style={position}
    >
      {props.searchable && (
        <input
          ref={control.searchRef}
          className="dd-search"
          value={control.query}
          placeholder={props.searchPlaceholder ?? 'Search…'}
          spellCheck={false}
          onChange={(event) => {
            control.setQuery(event.target.value);
            control.setHighlight(0);
          }}
          onKeyDown={onKey}
        />
      )}
      <div className="dd-list" ref={control.listRef}>
        {control.visible.map((option, index) => (
          <Fragment key={`${String(option.value)}-${index}`}>
            {option.group && option.group !== control.visible[index - 1]?.group && (
              <div className="dd-group-label">{option.group}</div>
            )}
            <DropdownRow option={option} index={index} control={control} />
          </Fragment>
        ))}
        {!control.visible.length && <div className="dd-empty">Nothing matches</div>}
      </div>
    </Popup>
  );
}
function DropdownRow<T>({
  option,
  index,
  control,
}: {
  readonly option: DropdownOption<T>;
  readonly index: number;
  readonly control: Controller<T>;
}) {
  const highlight = index === control.highlight ? 'highlight' : '';
  const selected = option.value === control.committed.current && control.open ? 'selected' : '';
  return (
    <div
      className={`dd-option ${highlight} ${selected} ${option.dim ? 'dim' : ''}`}
      onMouseEnter={() => control.hover(index)}
      onPointerDown={(event) => {
        if (event.pointerType === 'mouse' && event.button === 0) {
          event.preventDefault();
          control.pick(option);
        }
      }}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => control.pick(option)}
    >
      <span className="dd-check">
        {option.value === control.committed.current ? <CheckIcon size={11} /> : undefined}
      </span>
      {option.icon && <span className="dd-icon">{option.icon}</span>}
      <span className="dd-option-label">{option.label}</span>
      {option.description && <span className="dd-description">{option.description}</span>}
    </div>
  );
}

function dropdownGroupCount<T>(options: readonly DropdownOption<T>[]): number {
  return options.filter(
    (option, index) => option.group && option.group !== options[index - 1]?.group,
  ).length;
}
