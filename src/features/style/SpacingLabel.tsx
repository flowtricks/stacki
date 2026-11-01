// A side's label in the spacing box: its value or variable, the tooltip that
// names the property, and the gesture that opens the editor or picks the
// selector (SpacingBox.tsx).

import { useEffect, useRef, useState } from 'react';
import { HoverTooltip } from './components/SegmentedControl';
import type { ProjectVariable } from './model/webflow';
import { type ResolvedProp } from './model/resolved';
import { type SetProp, type ClearProp, type LiveSetProp, type Read, type Side, displayOf, isWrappedValue } from './spacingTypes';
import { siblingProps, useSideDrag, useSideHover } from './SpacingFill';
import { withImportant } from './spacingValue';
import { useStyleHint } from './model/computedStyle';

/** Label text: the value with its unit (the empty placeholder when unset), sans
 *  !important. The CSS truncates it to the band, so the unit shows when there's room. */
export function labelFor(value: string, empty: string): string {
  const text = value.trim().replace(/\s*!important$/i, '');
  return text || empty;
}

export function variableFor(value: string, variables: ProjectVariable[]): ProjectVariable | undefined {
  const raw = value.trim().replace(/\s*!important$/i, '');
  const binding = raw.match(/var\(\s*--[A-Za-z0-9_-]+[^)]*\)/i)?.[0];
  // Purple is reserved for a direct variable value. Expressions that merely contain
  // a variable, such as `calc(var(--space) * 2)`, remain normal blue property values.
  if (binding) {
    return binding === raw ? variables.find((variable) => variable.binding === binding) : undefined;
  }
  return variables.find((variable) => {
    const fullName = variable.group ? `${variable.group}/${variable.name}` : variable.name;
    return raw === fullName || raw === variable.name;
  });
}

/** `margin-top` -> `Margin top`, `top` -> `Top` for the click editor label. */
export function humanLabel(prop: string): string {
  const spaced = prop.replace('-', ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

// The always-visible value: a label you can click or drag. Click opens the
// editor popover; Alt/Option-click clears the side; dragging it adjusts the
// value, the same gesture as dragging the band behind it — which is where most
// presses land, since the number sits on top of the band.
export function SpacingLabel(props: SpacingLabelProps) {
  const { prop, side, read, busy, clearProp, onEdit } = props;
  const computed = useStyleHint(read(prop) === undefined ? prop : '');
  const look = labelLook({
    resolved: read(prop),
    override: props.override,
    emptyLabel: computed || props.emptyLabel,
    variableLabels: props.variableLabels ?? false,
    variables: props.variables,
  });
  const buttonRef = useRef<HTMLButtonElement>(null);
  const tooltip = useLabelTooltip({ hasValue: look.hasValue });
  const gesture = useLabelGesture(props);
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={`embed-editor_spacing-label embed-editor_spacing-${side} ${look.state}`}
        data-prop={prop}
        disabled={busy}
        onMouseEnter={tooltip.open}
        onMouseLeave={tooltip.close}
        onPointerEnter={gesture.hover.onEnter(side)}
        onPointerLeave={gesture.hover.onLeave}
        onFocus={tooltip.show}
        onBlur={tooltip.close}
        onPointerDown={(event) => {
          tooltip.close();
          gesture.onPointerDown(side)(event);
        }}
        onPointerMove={(event) => {
          gesture.hover.onOver(event);
          gesture.onPointerMove(event);
        }}
        onPointerUp={gesture.onPointerUp}
        onPointerCancel={gesture.onPointerUp}
        onClick={(event) => {
          tooltip.close();
          if (gesture.wasDrag()) {
            // That press was a drag; it has already been applied.
            return;
          }
          if (event.altKey) {
            // Alt/Option-click removes the value.
            clearProp(prop);
            return;
          }
          onEdit(prop, side);
        }}
      >
        {look.text}
      </button>
      {tooltip.shown && look.hasValue && buttonRef.current ? <SpacingLabelTooltip anchor={buttonRef.current} look={look} /> : undefined}
    </>
  );
}

// The label's tooltip: a variable's full name, an override's winner, or the
// value spelled out.
export function SpacingLabelTooltip({ anchor, look }: { anchor: HTMLElement; look: { variableFullName: string; tooltipContent: string } }) {
  return (
    <HoverTooltip anchor={anchor}>
      <span className="embed-editor_spacing-tooltip">
        <span className={look.variableFullName ? 'embed-editor_spacing-tooltip-meta' : 'embed-editor_spacing-tooltip-value'}>{look.tooltipContent}</span>
      </span>
    </HoverTooltip>
  );
}

// The number drags like the band it sits on: `padding-top` → `padding-left`
// and friends, so Shift and Alt reach the other sides from here too. A few
// pixels of travel separate a drag from the click that opens the editor.
export function useLabelGesture({
  prop,
  side,
  read,
  busy,
  setProp,
  liveSetProp,
  onLive,
  onLiveEnd,
}: Pick<SpacingLabelProps, 'prop' | 'side' | 'read' | 'busy' | 'setProp' | 'liveSetProp' | 'onLive' | 'onLiveEnd'>) {
  const propForSide = (other: Side) => siblingProps(prop, side, [other])[0] ?? prop;
  // `padding-top` → padding, `margin-top` → margin, a bare inset (`top`) → the
  // box it is drawn in, which is the margin frame.
  const kind = prop.startsWith('padding') ? 'padding' : 'margin';
  const drag = useSideDrag({
    propFor: propForSide,
    inward: prop.startsWith('padding'),
    kind,
    read,
    busy,
    setProp,
    liveSetProp,
    onLive,
    onLiveEnd,
    threshold: 3,
  });
  const hover = useSideHover({ propFor: propForSide, kind, read });
  return { ...drag, hover };
}

export type SpacingLabelProps = {
  prop: string;
  side: Side;
  override?: string | undefined;
  emptyLabel: string;
  read: Read;
  busy: boolean;
  clearProp: ClearProp;
  onEdit: (prop: string, side: Side) => void;
  variables: ProjectVariable[];
  variableLabels?: boolean;
  setProp: SetProp;
  liveSetProp: LiveSetProp;
  onLive: (props: string[], display: string) => void;
  onLiveEnd: () => void;
};

// What a side's label shows and how it is coloured, from the resolved model and
// any live drag value (`override`).
export function labelLook({
  resolved,
  override,
  emptyLabel,
  variableLabels,
  variables,
}: {
  resolved: ResolvedProp | undefined;
  override: string | undefined;
  emptyLabel: string;
  variableLabels: boolean;
  variables: ProjectVariable[];
}) {
  const display = displayOf(resolved);
  const value = override ?? (display.present ? withImportant(display) : '');
  // Native getProperties can collapse a calc(var(...)) selected value to a Variable
  // object even when the winning/embed fallback keeps the authored expression. Either
  // expression signal means this is a blue property value, not a direct purple variable.
  const hasWrappedValue = isWrappedValue(value) || isWrappedValue(resolved?.winner.value);
  // A live drag (override) always shows its own value plainly; otherwise reflect
  // the cascade — struck-through when a more specific selector overrides this side.
  // The native-variable/expression pair is one authored value represented through two
  // bridge layers, not a meaningful visual override, so keep its property label blue.
  const overridden = override === undefined && display.overridden && !hasWrappedValue;
  const selected = override !== undefined || (display.present && display.isSelected);
  const color = selected ? 'is-selected' : display.present ? 'is-other' : '';
  const variable = override === undefined && variableLabels && !hasWrappedValue ? variableFor(value, variables) : undefined;
  const state = `${color}${variable ? ' is-variable' : ''}${overridden ? ' is-overridden' : ''}`;
  const variableFullName = variable ? (variable.group ? `${variable.group}/${variable.name}` : variable.name) : '';
  const tooltipValue = variable ? variable.name : labelFor(value, emptyLabel);
  const tooltipContent = variableFullName || (overridden ? `Overridden by ${display.winnerSelector}` : tooltipValue);
  // A side with nothing set already reads "Auto" / "0" on its face; a tooltip saying
  // the same thing is noise over every empty side of the box. Only a value worth
  // spelling out — one that's authored, a variable's full name, an override — gets one.
  const hasValue = override !== undefined || display.present;
  const text = variable?.name ?? labelFor(value, emptyLabel);
  return { state, variableFullName, tooltipContent, hasValue, text };
}

// The label's tooltip: after a short hover, or at once on keyboard focus, and
// only for a side that has a value worth spelling out.
export function useLabelTooltip({ hasValue }: { hasValue: boolean }) {
  const [shown, setShown] = useState(false);
  const tooltipTimer = useRef<number | undefined>(undefined);
  const clearTooltipTimer = () => {
    if (tooltipTimer.current !== undefined) {
      window.clearTimeout(tooltipTimer.current);
      tooltipTimer.current = undefined;
    }
  };
  useEffect(() => clearTooltipTimer, []);
  return {
    shown,
    open: () => {
      clearTooltipTimer();
      if (!hasValue) {
        return;
      }
      tooltipTimer.current = window.setTimeout(() => {
        tooltipTimer.current = undefined;
        setShown(true);
      }, 350);
    },
    show: () => {
      if (hasValue) {
        setShown(true);
      }
    },
    close: () => {
      clearTooltipTimer();
      setShown(false);
    },
  };
}
