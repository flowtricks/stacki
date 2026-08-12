import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { HelpCircleIcon } from './Icons.jsx';

const DELAY = 120;
const MARGIN = 8; // keep the bubble this far from the window's edges

// The "?" beside a prop's name, showing that prop's own documentation — the
// comment written above it in the component's `interface Props`. The bubble is
// position:fixed so it escapes the panel's scroll box, and flips below the icon
// when there isn't room above.
export default function PropTip({ text }) {
  const [pos, setPos] = useState(null); // {left, top, below, arrow}
  const iconRef = useRef(null);
  const tipRef = useRef(null);
  const timerRef = useRef(null);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  const show = () => {
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      const el = iconRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const below = r.top < 120; // not enough room for the bubble above
      setPos({
        left: Math.round(r.left + r.width / 2),
        top: below ? Math.round(r.bottom + 8) : Math.round(r.top - 8),
        below,
      });
    }, DELAY);
  };

  const hide = () => {
    clearTimeout(timerRef.current);
    setPos(null);
  };

  // Centering on the icon puts the bubble off-screen when the prop sits near
  // an edge — which in a 322px panel is most of them. Measured after it
  // renders (its width depends on the text), then pulled back inside, with the
  // pointer sliding the other way so it still marks the icon.
  useLayoutEffect(() => {
    const tip = tipRef.current;
    const icon = iconRef.current;
    if (!tip || !icon || !pos || pos.clamped) return;
    const half = tip.getBoundingClientRect().width / 2;
    const center = pos.left;
    const left = Math.min(Math.max(center, MARGIN + half), window.innerWidth - MARGIN - half);
    if (left === center) {
      setPos({ ...pos, clamped: true });
      return;
    }
    // Keep the arrow over the icon, but not past the bubble's own corners.
    const arrow = Math.max(Math.min(center - left, half - 12), -(half - 12));
    setPos({ ...pos, left, arrow, clamped: true });
  }, [pos]);

  if (!text) return null;

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
      {pos && (
        <div
          ref={tipRef}
          className={`prop-tip ${pos.below ? 'below' : ''}`}
          style={{ left: pos.left, top: pos.top, '--tip-arrow': `${pos.arrow || 0}px` }}
        >
          {text}
        </div>
      )}
    </>
  );
}
