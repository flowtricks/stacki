// The card that adds a breakpoint, in the same grid as the others: the icon the new breakpoint WILL get at the left (it follows the
// direction and the value as they are typed), then a column with its name (an input that reads as text until hovered or focused), the
// direction as a segmented control and a muted line saying the query and canvas it will have, plus how many places already match when
// the value does; the value field in the same column and width as every card's; the problem, if any, under both; and the actions at the
// bottom right, Cancel then Add. Enter adds and Escape cancels; Tab goes name, direction, value, Cancel, Add. The value is focused and
// selected when the card opens.
import { useEffect, useRef, useState } from 'react';
import { foundTotals } from '../../../shared/properties/breakpointSyncSelection';
import { BREAKPOINT_LIMITS, type Breakpoint, type BreakpointDirection } from '../../../shared/properties/projectBreakpoints';
import { useTranslate } from '../../lib/i18n/useTranslate';
import { breakpointUsageAvailable, scanBreakpointUsageRequest } from '../../ipc/breakpointSyncBridge';
import { deviceIconComponent } from '../../features/preview/deviceIcons';
import type { DeviceIconKind } from '../../features/preview/breakpointDevices';

/** How long a value rests before the project is searched for it. */
const USAGE_DEBOUNCE_MS = 300;
const ICON_SIZE_PX = 16;

export interface AddDraft {
  readonly name: string;
  readonly value: string;
}

interface Props {
  readonly projectPath: string;
  readonly draft: AddDraft;
  readonly onChange: (draft: AddDraft) => void;
  readonly icon: DeviceIconKind;
  /** The query the card will match, e.g. `width >= 120rem`, and the canvas width it resolves to. */
  readonly condition: string;
  /** The side of Desktop the value lands on, derived from the number. */
  readonly side: BreakpointDirection;
  readonly canvasPx: number;
  readonly placeholderValue: string;
  readonly suggestedName: string;
  /** The breakpoint this would be, once the value parses; undefined before. */
  readonly candidate: Breakpoint | undefined;
  readonly problem: string | undefined;
  readonly canAdd: boolean;
  readonly onAdd: () => void;
  readonly onCancel: () => void;
}

export function BreakpointAddCard(props: Props) {
  const translate = useTranslate();
  const Icon = deviceIconComponent(props.icon);
  const valueInput = useRef<HTMLInputElement>(null);
  const usage = useCandidateUsage(props.projectPath, props.candidate);
  // Focused and selected as it opens, so a value can be typed straight away or replaced.
  useEffect(() => {
    valueInput.current?.focus();
    valueInput.current?.select();
  }, []);
  const name = props.draft.name === '' ? props.suggestedName : props.draft.name;
  return (
    <div className="breakpoints-card breakpoints-add-card" data-breakpoint="new" data-invalid={props.problem === undefined ? undefined : ''}>
      <span className="breakpoints-tile" aria-hidden="true">
        <Icon size={ICON_SIZE_PX} />
      </span>
      <div className="breakpoints-text">
        <input
          className="breakpoints-name-input"
          type="text"
          value={props.draft.name}
          placeholder={props.suggestedName}
          maxLength={BREAKPOINT_LIMITS.nameCharsMax}
          spellCheck={false}
          aria-label={translate('settings.breakpoints.nameLabel', { device: name })}
          onChange={(event) => props.onChange({ ...props.draft, name: event.currentTarget.value })}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              props.onAdd();
            } else if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              props.onCancel();
            }
          }}
        />
        <span className="breakpoints-query" data-pending={props.candidate === undefined ? '' : undefined}>
          {`${translate('settings.breakpoints.query', { condition: props.condition })} · ${translate(props.side === 'up' ? 'settings.breakpoints.side.up' : 'settings.breakpoints.side.down')}`}
        </span>
        {usage !== undefined && <span className="breakpoints-usage-line">{usage}</span>}
      </div>
      <div className="breakpoints-field">
        <input
          ref={valueInput}
          className="breakpoints-input"
          type="text"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          value={props.draft.value}
          placeholder={props.placeholderValue}
          maxLength={BREAKPOINT_LIMITS.entryCharsMax}
          aria-label={translate('settings.breakpoints.widthLabel', { device: name })}
          aria-invalid={props.problem === undefined ? undefined : true}
          onChange={(event) => props.onChange({ ...props.draft, value: event.currentTarget.value })}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              props.onAdd();
            } else if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              props.onCancel();
            }
          }}
        />
        <span className="breakpoints-canvas">{translate('settings.breakpoints.canvas', { width: props.canvasPx })}</span>
      </div>
      {/* Where the other cards have their remove button, so the value lines up with theirs. */}
      <span className="breakpoints-spacer" aria-hidden="true" />
      {props.problem !== undefined && (
        <p className="breakpoints-problem" role="alert">
          {props.problem}
        </p>
      )}
      <div className="breakpoints-add-actions">
        <button type="button" className="breakpoints-add-cancel" onClick={props.onCancel}>
          {translate('ui.cancel')}
        </button>
        <button type="button" className="primary breakpoints-add-confirm" disabled={!props.canAdd} onClick={props.onAdd}>
          {translate('settings.breakpoints.addConfirm')}
        </button>
      </div>
    </div>
  );
}

// How many places of the project already match the value being typed: looked for once it rests and parses, never while it is typed.
function useCandidateUsage(projectPath: string, candidate: Breakpoint | undefined): string | undefined {
  const translate = useTranslate();
  const [found, setFound] = useState<{ readonly places: number; readonly files: number }>();
  // The effect reads the latest candidate through a ref: only its value, not the object, decides when to search.
  const latest = useRef(candidate);
  latest.current = candidate;
  const key = candidate === undefined ? '' : `${candidate.direction}:${candidate.setting.value}${candidate.setting.unit}`;
  useEffect(() => {
    setFound(undefined);
    const searched = latest.current;
    if (searched === undefined || !breakpointUsageAvailable()) {
      return undefined;
    }
    let live = true;
    const timer = window.setTimeout(() => {
      void scanBreakpointUsageRequest(projectPath, [searched]).then((answer) => {
        const files = answer.ok ? (answer.usage.entries[0]?.files ?? []) : [];
        const totals = foundTotals(files);
        if (live && totals.places > 0) {
          setFound({ places: totals.places, files: totals.files });
        }
      });
    }, USAGE_DEBOUNCE_MS);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [projectPath, key]);
  if (found === undefined) {
    return undefined;
  }
  return `${translate('settings.breakpoints.usage.places', { count: found.places })} · ${translate('settings.breakpoints.usage.files', { count: found.files })}`;
}
