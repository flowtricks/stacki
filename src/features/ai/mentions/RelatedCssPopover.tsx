// The list a CSS chip opens on click, to swap it for a related class or variable, the way a class tag in the
// Properties panel offers the rest of its family: compact rows with a check at the end of the current one, a
// search field at the top once there are more than a handful, Up and Down to move, Enter to take, Escape or a
// click away to close. The order is the related-list builder's (projectMentions.ts, `relatedItems`): the
// chip's family, then its stylesheet or Variables group, then the rest. Picking only says what was picked; the
// composer replaces the chip in place as one undoable change and gives the editor its caret back.
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { assert } from '../../../../shared/core/assert';
import { useTranslate } from '../../../lib/i18n/useTranslate';
import { EmptyState } from '../../../ui/EmptyState';
import { CheckIcon, SearchIcon } from '../../../ui/Icons';
import Popup from '../../../ui/Popup';
import { placeMenu } from '../../../ui/menuModel';
import { CHIP_STYLE_ICONS } from './mentionChips';
import type { RelatedItem } from './projectMentions';
import './mentions.css';

/** More items than this and the list opens with a search field. */
export const RELATED_SEARCH_MIN = 8;
const WIDTH_PX = 280;
const ROW_PX = 30;
const HEIGHT_MAX_PX = 300;

export interface RelatedCssPopoverProps {
  readonly items: readonly RelatedItem[];
  /** The chip's box in viewport coordinates: the list opens below it, or above when there is no room. */
  readonly anchorBox: { readonly left: number; readonly top: number; readonly width: number; readonly height: number };
  /** What the list is stacked above: the composer. A press inside it (not on the list) closes the list and still acts. */
  readonly anchor: HTMLElement | undefined;
  readonly onPick: (item: RelatedItem) => void;
  /** Escape or a press elsewhere in the app. */
  readonly onClose: () => void;
  /** A press in the composer outside the list: it closes, and the press goes on to place the caret as usual. */
  readonly onPressComposer: () => void;
}

export function RelatedCssPopover(props: RelatedCssPopoverProps) {
  const translate = useTranslate();
  const [query, setQuery] = useState('');
  const needle = query.trim().toLocaleLowerCase();
  const shown = props.items.filter((item) => needle === '' || item.label.toLocaleLowerCase().includes(needle));
  const [highlight, setHighlight] = useState(() =>
    Math.max(
      0,
      props.items.findIndex((item) => item.current),
    ),
  );
  const active = shown.length === 0 ? 0 : Math.min(highlight, shown.length - 1);
  const surface = useRef<HTMLDivElement | undefined>(undefined);
  const searchable = props.items.length > RELATED_SEARCH_MIN;
  const height = Math.min(HEIGHT_MAX_PX, (searchable ? 36 : 0) + Math.max(1, props.items.length) * ROW_PX + 12);
  const place = placeMenu(props.anchorBox, { width: WIDTH_PX, height }, { width: window.innerWidth, height: window.innerHeight }, 'below-start');
  // The search field takes the caret as the list opens (the list itself when there is no field), and again a
  // frame later, after the popup has settled its own focus.
  useEffect(() => {
    const focusStart = (): void => surface.current?.querySelector<HTMLElement>(searchable ? 'input' : '[role="listbox"]')?.focus();
    focusStart();
    const frame = requestAnimationFrame(focusStart);
    return () => cancelAnimationFrame(frame);
    // Once, as it opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see above
  }, []);
  // A press in the composer outside the list closes it without taking the press: it still places the caret.
  const { anchor, onPressComposer } = props;
  useEffect(() => {
    if (anchor === undefined) {
      return undefined;
    }
    const down = (event: PointerEvent | MouseEvent): void => {
      const target = event.target;
      if (target instanceof Node && !(surface.current?.contains(target) ?? false)) {
        onPressComposer();
      }
    };
    anchor.addEventListener('pointerdown', down, true);
    anchor.addEventListener('mousedown', down, true);
    return () => {
      anchor.removeEventListener('pointerdown', down, true);
      anchor.removeEventListener('mousedown', down, true);
    };
  }, [anchor, onPressComposer]);
  useEffect(() => {
    const row = surface.current?.querySelector<HTMLElement>(`[data-related-index="${active}"]`);
    if (row !== undefined && row !== null && typeof row.scrollIntoView === 'function') {
      row.scrollIntoView({ block: 'nearest' });
    }
  }, [active]);
  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (shown.length > 0) {
        const step = event.key === 'ArrowDown' ? 1 : shown.length - 1;
        setHighlight((active + step) % shown.length);
      }
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const item = shown[active];
      if (item !== undefined) {
        props.onPick(item);
      }
    }
  };
  return (
    <Popup
      mode="popover"
      open
      onClose={props.onClose}
      anchor={props.anchor}
      keepOnScroll
      role="dialog"
      label={translate('ai.mention.related.label')}
      className="related-css"
      style={{ position: 'fixed', left: place.left, top: place.top, width: WIDTH_PX, maxHeight: height }}
      ref={(element) => {
        surface.current = element ?? undefined;
      }}
    >
      {searchable && (
        <input
          type="search"
          className="related-css-search"
          aria-label={translate('ai.mention.related.search')}
          placeholder={translate('ai.mention.related.search')}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setHighlight(0);
          }}
          onKeyDown={onKeyDown}
        />
      )}
      <div className="related-css-list" role="listbox" tabIndex={-1} aria-label={translate('ai.mention.related.label')} onKeyDown={onKeyDown}>
        {shown.length === 0 ? (
          <EmptyState icon={<SearchIcon size={16} />} title={translate('ai.mention.related.none')} align="center" />
        ) : (
          shown.map((item, index) => {
            const Icon = CHIP_STYLE_ICONS[item.chip.target];
            assert(Icon !== undefined, 'RelatedCssPopover: a CSS chip has an icon');
            return (
              <div
                key={`${item.chip.name}\u0000${item.chip.path ?? ''}`}
                role="option"
                aria-selected={index === active}
                data-related-index={index}
                className={`related-css-row${index === active ? ' is-active' : ''}`}
                onMouseEnter={() => setHighlight(index)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => props.onPick(item)}
              >
                {item.color === undefined ? <Icon size={14} /> : <span className="mention-row-swatch" style={{ background: item.color }} aria-hidden="true" />}
                <span className="related-css-label">{item.label}</span>
                {item.description !== undefined && <span className="related-css-description">{item.description}</span>}
                <span className="related-css-check">{item.current && <CheckIcon size={12} />}</span>
              </div>
            );
          })
        )}
      </div>
    </Popup>
  );
}
