// The loading placeholder: quiet filled shapes in the layout of what is about to appear, never a word
// and never a spinner. The rule (docs/ui-loading.md) is that a screen paints its real content at once,
// from a cache when it has one, and falls back to these shapes only when nothing can be shown yet.
//
// `Skeleton` is one shape. `SkeletonRows` is a bounded run of rows whose widths come from a fixed list,
// so the layout never changes between renders or between sessions. Both are hidden from assistive
// technology; the group that holds them says once, in the person's language, that it is busy.
import type { CSSProperties, ReactNode } from 'react';
import { assert } from '../../shared/core/assert';
import { useTranslate } from '../lib/i18n/useTranslate';
import './skeleton.css';

/** The most rows one group draws: a placeholder never needs to fill more than a screen. */
export const SKELETON_ROWS_MAX = 12;

/** Widths, in percent of the row, cycled through by `SkeletonRows`: varied enough to look like text, fixed so nothing shifts. */
export const SKELETON_WIDTHS_PERCENT = [62, 48, 74, 55, 68, 44] as const;

export interface SkeletonOptions {
  /** Any CSS length; a percentage fills that share of the container. Defaults to the full width. */
  readonly width?: string;
  /** Any CSS length. Defaults to one line of text. */
  readonly height?: string;
  /** Any CSS length. Defaults to the app's small radius. */
  readonly radius?: string;
}

/** One placeholder shape. Fill only, no border. */
export function Skeleton({ width, height, radius }: SkeletonOptions) {
  const style: CSSProperties = {};
  if (width !== undefined) {
    style.width = width;
  }
  if (height !== undefined) {
    style.height = height;
  }
  if (radius !== undefined) {
    style.borderRadius = radius;
  }
  return <span className="ui-skeleton" aria-hidden="true" style={style} />;
}

export interface SkeletonRowsOptions {
  /** How many rows, from 1 to `SKELETON_ROWS_MAX`. */
  readonly count: number;
  /** Draws one row given the width (in percent) this row's main shape should take. Defaults to a single bar. */
  readonly row?: (widthPercent: number, index: number) => ReactNode;
}

/**
 * A group of placeholder rows. The group is `aria-busy` and carries a visually hidden status, so a screen
 * reader hears "Loading" once instead of a run of empty shapes.
 */
export function SkeletonRows({ count, row }: SkeletonRowsOptions) {
  const translate = useTranslate();
  assert(Number.isSafeInteger(count), 'SkeletonRows: the count is a whole number');
  assert(count >= 1, 'SkeletonRows: draws at least one row');
  assert(count <= SKELETON_ROWS_MAX, 'SkeletonRows: the count stays within the bound');
  const rows: ReactNode[] = [];
  for (let index = 0; index < count; index += 1) {
    const widthPercent = SKELETON_WIDTHS_PERCENT[index % SKELETON_WIDTHS_PERCENT.length] ?? SKELETON_WIDTHS_PERCENT[0];
    rows.push(<div key={index}>{row === undefined ? <Skeleton width={`${widthPercent}%`} /> : row(widthPercent, index)}</div>);
  }
  assert(rows.length === count, 'SkeletonRows: drew the rows it was asked for');
  return (
    <div className="ui-skeleton-rows" role="status" aria-busy="true">
      <span className="ui-skeleton-status">{translate('ui.loading')}</span>
      {rows}
    </div>
  );
}
