import { useTranslate } from '../../../lib/i18n/useTranslate';
import LiveInput from './LiveInput';

// Two controls that turn up wherever a point on a box is being set: the gradient
// centre, a transform origin, a perspective origin. Shared so those stay the same
// control rather than three that drifted apart.

// 3×3 position picker: pick a corner/edge/center; the active cell is filled.
export function PositionGrid({
  x,
  y,
  busy,
  ariaLabel,
  onPick,
}: {
  x: string;
  y: string;
  busy: boolean;
  ariaLabel?: string;
  onPick: (px: string, py: string) => void;
}) {
  const translate = useTranslate();
  const cells = ['0%', '50%', '100%'];
  const activeX = cells.indexOf(x);
  const activeY = cells.indexOf(y);
  return (
    <div className="embed-editor_grad-grid" role="group" aria-label={ariaLabel ?? translate('styleModel.components.position.group')}>
      {cells.map((py, yi) =>
        cells.map((px, xi) => {
          const active = xi === activeX && yi === activeY;
          return (
            <button
              key={`${xi}-${yi}`}
              type="button"
              className={`embed-editor_grad-grid-cell ${active ? 'is-active' : ''}`}
              disabled={busy}
              aria-label={translate('styleModel.components.position.cell', { x: px, y: py })}
              aria-pressed={active}
              onClick={() => onPick(px, py)}
            >
              <span className="embed-editor_grad-grid-dot" />
            </button>
          );
        }),
      )}
    </div>
  );
}

// A number field with a unit suffix (used for Left/Top and a stop's position).
// The value carries its unit in the CSS but not in the field — you type `50`,
// not `50%` — so the unit is put back on the way out.
export function NumberField({
  value,
  unit,
  label,
  busy,
  prop = 'left',
  onLive,
  onCommit,
}: {
  value: string;
  unit: string;
  label: string;
  busy: boolean;
  /** Which property the variable picker offers bindings for. */
  prop?: string;
  onLive: (v: string) => void;
  onCommit: (v: string) => void;
}) {
  const number = value.replace(/[a-z%]+$/i, '').trim();
  const withUnit = (text: string) => {
    const trimmed = text.trim();
    return trimmed === '' ? '' : /[a-z%]$/i.test(trimmed) ? trimmed : `${trimmed}${unit}`;
  };
  return (
    <LiveInput
      value={number}
      busy={busy}
      ariaLabel={label}
      prop={prop}
      suffix={unit}
      wrapClassName="embed-editor_field embed-editor_grad-num"
      onLive={(value) => onLive(withUnit(value))}
      onCommit={(value) => onCommit(withUnit(value))}
      onVariablePick={(binding) => onCommit(binding)}
    />
  );
}
