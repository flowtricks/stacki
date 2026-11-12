// The four-dot "working" indicator: dots that swell in turn. It is CSS only, so it costs no
// script while it runs, and under prefers-reduced-motion it stops and shows four still dots
// of rising weight, which still reads as "in progress" without moving.
//
// `label` names it for assistive technology ("Running"); leave it out where a visible label
// beside it already says so, and the dots are hidden from them.
import type { CSSProperties } from 'react';
import './loaderDots.css';

export interface LoaderDotsProps {
  readonly label?: string;
  /** The diameter of one dot. */
  readonly dotPx?: number;
}

export function LoaderDots(props: LoaderDotsProps) {
  const dotPx = props.dotPx ?? 4;
  const style: CSSProperties & { readonly '--loader-dot': string } = { '--loader-dot': `${dotPx}px` };
  return (
    <span
      className="loader-dots"
      role={props.label === undefined ? undefined : 'img'}
      aria-label={props.label}
      aria-hidden={props.label === undefined ? true : undefined}
      style={style}
    >
      <span className="loader-dot" />
      <span className="loader-dot" />
      <span className="loader-dot" />
      <span className="loader-dot" />
    </span>
  );
}
