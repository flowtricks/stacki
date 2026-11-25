// The purple chip for a value that comes from data: the same `.expr-chip` the Content field and the prop fields draw,
// so "this is data" reads the same everywhere. It names its path for assistive tech ("Data binding a.b"). With
// `onPick` it is a button that opens the data picker; without, it is a plain mark (a Navigator row, whose click
// belongs to selection). A long path is cut at its START, so the end, the part that tells bindings apart, stays visible.

import React from 'react';
import { assert } from '../../shared/core/assert';
import { useTranslate } from '../lib/i18n/useTranslate';
import { useDelayedTooltip, tooltipHost } from './delayedTooltip';
import FittedTooltip from './FittedTooltip';
import { createPortal } from 'react-dom';

/** Characters of a path a chip shows before the start is cut. */
export const DATA_CHIP_CHARS_MAX = 30;

/** `path` itself when it fits, else an ellipsis and its last characters, `max` in all. */
export function pathEnd(path: string, max: number): string {
  assert(Number.isSafeInteger(max), 'pathEnd: max is a safe integer');
  assert(max >= 2, 'pathEnd: room for an ellipsis and a character');
  return path.length <= max ? path : `…${path.slice(path.length - (max - 1))}`;
}

export interface DataChipProps {
  readonly path: string;
  /** Opens the data picker; the chip is then a button. */
  readonly onPick?: ((chip: HTMLElement) => void) | undefined;
  /** What the path holds now, for the tooltip, when it is known. */
  readonly valuePreview?: string | undefined;
}

export default function DataChip({ path, onPick, valuePreview }: DataChipProps) {
  const translate = useTranslate();
  const tooltip = useDelayedTooltip();
  assert(path.length > 0, 'DataChip: a chip names a path');
  const label = translate('structure.binding.label', { path });
  const tip = valuePreview === undefined ? path : `${path} = ${valuePreview}`;
  const pick = (element: HTMLElement): void => onPick?.(element);
  return (
    <>
      <span
        className="expr-chip data-chip"
        data-expr={path}
        aria-label={label}
        {...(onPick === undefined
          ? { role: 'img' }
          : {
              role: 'button',
              tabIndex: 0,
              onClick: (event: React.MouseEvent<HTMLElement>) => {
                event.stopPropagation();
                pick(event.currentTarget);
              },
              onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  pick(event.currentTarget);
                }
              },
            })}
        onMouseEnter={tooltip.show}
        onMouseLeave={tooltip.hide}
      >
        {pathEnd(path, DATA_CHIP_CHARS_MAX)}
      </span>
      {tooltip.value !== undefined &&
        createPortal(
          <FittedTooltip role="tooltip" anchor={tooltip.value}>
            {tip}
          </FittedTooltip>,
          tooltipHost(undefined),
        )}
    </>
  );
}
