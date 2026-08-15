import React, { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

// What a fluid clamp() costs a reader who zooms.
//
// The maths is in electron/cssVars.js; this is what it looks like. Two states,
// never both — a value that fails the ratio test shows only that, because
// fixing it is the same edit either way.
//
//   error    the value never reaches twice its size at 500% zoom (WCAG 1.4.4)
//   warning  the value ignores the reader's font size, or shrinks as it grows
//
// The error links to the article the rule comes from, so the badge is also the
// explanation. Both are reachable from the keyboard and say what they are to a
// screen reader — the message shows on focus as well as hover, since a
// hover-only warning is one more thing a keyboard reader cannot read.
//
// The message is drawn in a portal, not inside the badge. The badge sits in a
// scrolling column of values, and anything drawn inside that column is cropped
// by it — which is exactly what a message wider than the column would be.

const COPY = {
  error: 'Does not reach 2x of its original size at a 500% zoom. Reduce difference between max and min variable size.',
  warning: 'Shrinks when increasing zoom. Increase difference between max and min viewport size.',
};

const TIP_WIDTH = 260;
const TIP_MARGIN = 10;

const ErrorIcon = () => (
  <svg viewBox="0 0 15 15" fill="none" aria-hidden="true">
    <path
      d="M7.5 0C3.36469 0 0 3.36469 0 7.5C0 11.6353 3.36469 15 7.5 15C11.6353 15 15 11.6353 15 7.5C15 3.36469 11.6353 0 7.5 0ZM6.80063 3.04688C6.80063 2.9175 6.90563 2.8125 7.035 2.8125H7.965C8.09438 2.8125 8.19938 2.9175 8.19938 3.04688V8.67188C8.19938 8.80125 8.09438 8.90625 7.965 8.90625H7.035C6.90563 8.90625 6.80063 8.80125 6.80063 8.67188V3.04688ZM7.5 12.1875C6.98203 12.1875 6.5625 11.768 6.5625 11.25C6.5625 10.732 6.98203 10.3125 7.5 10.3125C8.01797 10.3125 8.4375 10.732 8.4375 11.25C8.4375 11.768 8.01797 12.1875 7.5 12.1875Z"
      fill="currentColor"
    />
  </svg>
);

const WarningIcon = () => (
  <svg viewBox="0 0 16 15" fill="none" aria-hidden="true">
    <path
      d="M15.8143 12.7909L9.27191 0.764655C8.8929 0.0571658 8.01627 -0.206719 7.31398 0.174664C7.06572 0.309384 6.86215 0.514659 6.72809 0.764655L0.18568 12.7909C-0.0705767 13.2559 -0.0609222 13.8231 0.210506 14.2792C0.468694 14.7264 0.943969 15.0011 1.45759 15H14.5424C15.056 15.0011 15.5313 14.7264 15.7895 14.2792C16.0609 13.8231 16.0706 13.2559 15.8143 12.7909ZM8.77649 5.01154L8.56272 10.2892C8.55665 10.4381 8.435 10.5556 8.28715 10.5556H7.7134C7.56555 10.5556 7.4439 10.4381 7.43783 10.2892L7.22406 5.01154C7.21771 4.85376 7.34295 4.72237 7.49962 4.72237H8.5012C8.65788 4.72237 8.78312 4.85376 8.77677 5.01154H8.77649ZM8 13.3334C7.54293 13.3334 7.17247 12.9603 7.17247 12.5C7.17247 12.0398 7.54293 11.6667 8 11.6667C8.45707 11.6667 8.82753 12.0398 8.82753 12.5C8.82753 12.9603 8.45707 13.3334 8 13.3334Z"
      fill="currentColor"
    />
  </svg>
);

// Beside the badge, on whichever side has room, and never off the top or
// bottom of the window.
function Tip({ anchor, error, message, link }) {
  const ref = useRef(null);
  const [pos, setPos] = useState(null);

  useLayoutEffect(() => {
    const height = ref.current?.offsetHeight || 90;
    const left =
      anchor.left - TIP_WIDTH - TIP_MARGIN >= TIP_MARGIN
        ? anchor.left - TIP_WIDTH - TIP_MARGIN
        : Math.min(anchor.right + TIP_MARGIN, window.innerWidth - TIP_WIDTH - TIP_MARGIN);
    const top = Math.min(
      Math.max(TIP_MARGIN, anchor.top + anchor.height / 2 - height / 2),
      window.innerHeight - height - TIP_MARGIN
    );
    setPos({ left, top });
  }, [anchor]);

  return createPortal(
    <div
      ref={ref}
      className={`fluid-tip ${error ? 'is-error' : 'is-warning'}`}
      role="tooltip"
      style={{ left: pos?.left ?? -9999, top: pos?.top ?? 0, width: TIP_WIDTH }}
    >
      {message}
      {error && link && <span className="fluid-tip-more">Read why</span>}
    </div>,
    document.body
  );
}

export default function FluidBadge({ fluid }) {
  const ref = useRef(null);
  const [anchor, setAnchor] = useState(null);

  if (!fluid || fluid.status === 'ok') return null;
  const error = fluid.status === 'error';
  const message = COPY[fluid.status];
  const label = `${error ? 'Accessibility error' : 'Accessibility warning'}: ${message}`;

  // No `title`: the browser's own tooltip would say the same thing again, a
  // second later, somewhere else.
  const props = {
    ref,
    className: `fluid-badge ${error ? 'is-error' : 'is-warning'}`,
    'aria-label': label,
    onMouseEnter: () => setAnchor(ref.current?.getBoundingClientRect() || null),
    onMouseLeave: () => setAnchor(null),
    onFocus: () => setAnchor(ref.current?.getBoundingClientRect() || null),
    onBlur: () => setAnchor(null),
  };

  const icon = <span className="fluid-badge-icon">{error ? <ErrorIcon /> : <WarningIcon />}</span>;

  return (
    <>
      {error ? (
        <a {...props} href={fluid.link} target="_blank" rel="noreferrer">
          {icon}
        </a>
      ) : (
        <span {...props} tabIndex={0} role="img">
          {icon}
        </span>
      )}
      {anchor && <Tip anchor={anchor} error={error} message={message} link={fluid.link} />}
    </>
  );
}
