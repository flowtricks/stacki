// The card a chip opens to show its value, for chips in the composer, in sent messages and in the queue: one at a
// time, opened by a resting pointer or at once by keyboard focus. The pointer may move into the card (to scroll
// long code or select it), so leaving the chip only starts a short wait that entering the card calls off.
//
// A card never outlives its chip: the shared tooltip timer watches the chip leave the document (a message
// redrawn, a chip deleted under the pointer: neither sends a `mouseleave`), and Escape, a press elsewhere, a
// scroll behind it and the window losing focus close it too.
//
// From the chip, ArrowDown moves the keyboard into the card (its code scrolls with the arrows) and Escape closes.
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { assert } from '../../../../shared/core/assert';
import FittedTooltip from '../../../ui/FittedTooltip';
import { tooltipAnchor, tooltipHost, useTipTimer, type TooltipAnchor } from '../../../ui/delayedTooltip';
import { ChipValue, type ChipSubject } from './ChipValue';
import './mentions.css';

/** How long the pointer may be on neither the chip nor its card before the card closes: the time to cross the gap. */
export const CHIP_CARD_LEAVE_MS = 200;

interface Open {
  readonly subject: ChipSubject;
  readonly control: HTMLElement;
  readonly anchor: TooltipAnchor;
  readonly host: HTMLElement;
}

export interface ChipCard {
  /** The pointer came to rest on `control`: the card opens after the tooltip wait. */
  readonly rest: (control: HTMLElement, subject: ChipSubject) => void;
  /** Keyboard focus reached `control`: the card opens at once. */
  readonly focus: (control: HTMLElement, subject: ChipSubject) => void;
  /** The pointer or the focus left the chip or the card. */
  readonly leave: () => void;
  readonly close: () => void;
  /** A key pressed on the chip; true when the card used it. */
  readonly key: (key: string) => boolean;
  /** The card, to be rendered beside the chips. */
  readonly card: ReactNode;
}

// One card on screen at a time, whoever opened it.
let closeOther: (() => void) | undefined;

export function useChipCard(): ChipCard {
  const [open, setOpen] = useState<Open | undefined>(undefined);
  const id = useId();
  const { wait, now, cancel } = useTipTimer();
  const leaving = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const surface = useRef<HTMLDivElement>(null);
  const openNow = useRef<Open | undefined>(undefined);
  openNow.current = open;
  const stay = useCallback((): void => clearTimeout(leaving.current), []);
  const close = useCallback((): void => {
    clearTimeout(leaving.current);
    cancel();
    openNow.current = undefined;
    setOpen(undefined);
  }, [cancel]);
  useEffect(() => () => clearTimeout(leaving.current), []);
  const show = useCallback(
    (control: HTMLElement, subject: ChipSubject, delay: 'rest' | 'now'): void => {
      stay();
      if (openNow.current?.control === control) {
        return;
      }
      const due = (): void => {
        if (closeOther !== close) {
          closeOther?.();
          closeOther = close;
        }
        setOpen({ subject, control, anchor: tooltipAnchor(control.getBoundingClientRect()), host: tooltipHost(control) });
      };
      (delay === 'rest' ? wait : now)(control, due, close);
    },
    [stay, close, wait, now],
  );
  const rest = useCallback((control: HTMLElement, subject: ChipSubject) => show(control, subject, 'rest'), [show]);
  const focus = useCallback((control: HTMLElement, subject: ChipSubject) => show(control, subject, 'now'), [show]);
  const leave = useCallback((): void => {
    // A card not yet open is simply never opened.
    if (openNow.current === undefined) {
      cancel();
      return;
    }
    clearTimeout(leaving.current);
    leaving.current = setTimeout(() => {
      // Focus inside the card (a keyboard scrolling its code) holds it open whatever the pointer does.
      if (surface.current?.contains(document.activeElement) !== true) {
        close();
      }
    }, CHIP_CARD_LEAVE_MS);
  }, [cancel, close]);
  const key = useCallback(
    (pressed: string): boolean => {
      if (openNow.current === undefined) {
        return false;
      }
      if (pressed === 'Escape') {
        close();
        return true;
      }
      if (pressed === 'ArrowDown') {
        const target = surface.current?.querySelector<HTMLElement>('[tabindex]') ?? undefined;
        target?.focus();
        return target !== undefined;
      }
      return false;
    },
    [close],
  );
  useCardDismissal(open, surface, close);
  const card =
    open === undefined
      ? undefined
      : createPortal(
          <FittedTooltip anchor={open.anchor} preferred="above" className="ai-chip-card" role="tooltip" id={id}>
            <div
              ref={surface}
              className="ai-chip-card-body"
              onMouseEnter={stay}
              onMouseLeave={leave}
              onFocus={stay}
              onBlur={(event) => {
                if (!(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))) {
                  leave();
                }
              }}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault();
                  event.stopPropagation();
                  const control = open.control;
                  // Back to the chip first: its focus would open the card again, so the card closes after.
                  control.focus();
                  close();
                }
              }}
              // The portal is not the chip's child in the page, but React still bubbles to it: a press in the card is not a press on the chip.
              onClick={(event) => event.stopPropagation()}
            >
              <ChipValue subject={open.subject} />
            </div>
          </FittedTooltip>,
          open.host,
        );
  return { rest, focus, leave, close, key, card };
}

function useCardDismissal(open: Open | undefined, surface: React.RefObject<HTMLDivElement>, close: () => void): void {
  useEffect(() => {
    if (open === undefined) {
      return undefined;
    }
    const outside = (target: unknown): boolean => !(target instanceof Node && (surface.current?.contains(target) === true || open.control.contains(target)));
    const onPress = (event: Event): void => {
      if (outside(event.target)) {
        close();
      }
    };
    // A scroll of anything but the card moves the chip out from under it.
    const onScroll = (event: Event): void => {
      if (!(event.target instanceof Node && surface.current?.contains(event.target) === true)) {
        close();
      }
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && outside(event.target)) {
        close();
      }
    };
    document.addEventListener('pointerdown', onPress, true);
    document.addEventListener('scroll', onScroll, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', close);
    assert(surface.current !== null, 'useCardDismissal: the open card is mounted');
    return () => {
      document.removeEventListener('pointerdown', onPress, true);
      document.removeEventListener('scroll', onScroll, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', close);
    };
  }, [open, surface, close]);
}
