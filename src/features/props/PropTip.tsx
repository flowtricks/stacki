import type { CSSProperties, RefObject } from 'react';
interface TipPosition {
  readonly left: number;
  readonly top: number;
  readonly below: boolean;
  readonly arrow?: number;
  readonly clamped?: boolean;
}
interface TipSurfaceProps {
  readonly text: string;
  readonly pos: TipPosition | undefined;
  readonly iconRef: RefObject<HTMLSpanElement>;
  readonly tipRef: RefObject<HTMLDivElement>;
  readonly show: () => void;
  readonly hide: () => void;
}
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { HelpCircleIcon } from '../../ui/Icons';

const DELAY = 120;
const MARGIN = 8; // keep the bubble this far from the window's edges

// The "?" beside a prop's name, showing that prop's own documentation — the
// comment written above it in the component's `interface Props`. The bubble is
// position:fixed so it escapes the panel's scroll box, and flips below the icon
// when there isn't room above.
export default function PropTip({ text }: { readonly text?: string | undefined }) {
  // Where the tip sits: {left, top, below, arrow}.
  const [position, setPosition] = useState<TipPosition | undefined>(undefined);
  const iconRef = useRef<HTMLSpanElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => () => clearTimeout(timerRef.current), []);

  const show = () => {
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      const element = iconRef.current;
      if (!element) {
        return;
      }
      const rect = element.getBoundingClientRect();
      const below = rect.top < 120; // not enough room for the bubble above
      setPosition({
        left: Math.round(rect.left + rect.width / 2),
        top: below ? Math.round(rect.bottom + 8) : Math.round(rect.top - 8),
        below,
      });
    }, DELAY);
  };

  const hide = () => {
    clearTimeout(timerRef.current);
    setPosition(undefined);
  };

  // Centering on the icon puts the bubble off-screen when the prop sits near
  // an edge — which in a 322px panel is most of them. Measured after it
  // renders (its width depends on the text), then pulled back inside, with the
  // pointer sliding the other way so it still marks the icon.
  useLayoutEffect(() => {
    const tip = tipRef.current;
    const icon = iconRef.current;
    if (!tip || !icon || !position || position.clamped) {
      return;
    }
    const half = tip.getBoundingClientRect().width / 2;
    const center = position.left;
    const left = Math.min(Math.max(center, MARGIN + half), window.innerWidth - MARGIN - half);
    if (left === center) {
      setPosition({ ...position, clamped: true });
      return;
    }
    // Keep the arrow over the icon, but not past the bubble's own corners.
    const arrow = Math.max(Math.min(center - left, half - 12), -(half - 12));
    setPosition({ ...position, left, arrow, clamped: true });
  }, [position]);

  if (!text) {
    return undefined;
  }

  return <TipSurface text={text} pos={position} iconRef={iconRef} tipRef={tipRef} show={show} hide={hide} />;
}
function TipSurface({ text, pos: position, iconRef, tipRef, show, hide }: TipSurfaceProps) {
  const style: CSSProperties & { readonly '--tip-arrow': string } = {
    left: position?.left,
    top: position?.top,
    '--tip-arrow': `${position?.arrow || 0}px`,
  };
  return (
    <>
      <span
        ref={iconRef}
        className="prop-tip-icon"
        onMouseEnter={show}
        onMouseLeave={hide}
        // Reachable without a mouse: the icon takes focus and the same
        // description shows.
        tabIndex={0}
        onFocus={show}
        onBlur={hide}
        role="note"
        aria-label={text}
      >
        <HelpCircleIcon size={13} />
      </span>
      {position && (
        <div ref={tipRef} className={`prop-tip ${position.below ? 'below' : ''}`} style={style}>
          {text}
        </div>
      )}
    </>
  );
}
