// The pieces an app's details popup (AppDetails.tsx) is laid out with. The popup
// is meant to be scanned, not read, so the explanations live in hints (a small
// ? beside a label, its sentence in a tooltip) and the content is short rows:
//
// - `AppDetailsSection`: a small uppercase heading, an optional hint beside it,
//   then its rows. A section may go without a heading (About has none), but then
//   names itself for assistive technology through `label`.
// - `AppDetailsList` and `AppDetailsItem`: a dense list on one filled block, a
//   label on the left and a value or a content-width control on the right, one
//   line per row. Facts, commands, updates and services are drawn with these.
// - `AppDetailsRow`: the taller Settings-style row (label, description, control
//   in a column of its own), for forms whose fields need their descriptions:
//   App settings and Connections.
// - `AppDetailsHint`: the ? that holds a long explanation.
//
// They are their own module, not Settings' components, because the Apps panel is
// shared with Studio and a feature does not reach into the Desktop app shell.
// Every section of the details, the ones other features add included, is built
// from these, which is what keeps the popup one calm column.
import { useId, useState, type FocusEvent, type MouseEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { assert } from '../../../shared/core/assert';
import { tooltipPointBelow, useDelayedTooltip, type TooltipPoint } from '../../ui/delayedTooltip';
import { HelpCircleIcon } from '../../ui/Icons';
import './appDetails.css';

/** A section's heading: shown text with an optional hint, or only a name for assistive technology. */
type SectionHeading = { readonly title: string; readonly hint?: string } | { readonly label: string };

export function AppDetailsSection(props: SectionHeading & { readonly children: ReactNode }) {
  const id = useId();
  if ('title' in props) {
    assert(props.title.length > 0, 'A details section has a title');
    return (
      <section className="apps-details-section" aria-labelledby={id}>
        <header className="apps-details-section-header">
          <h4 id={id}>{props.title}</h4>
          {props.hint !== undefined && <AppDetailsHint label={props.title} text={props.hint} />}
        </header>
        {props.children}
      </section>
    );
  }
  assert(props.label.length > 0, 'A details section without a heading still has a name');
  return (
    <section className="apps-details-section" aria-label={props.label}>
      {props.children}
    </section>
  );
}

/** One filled block of single-line rows. */
export function AppDetailsList(props: { readonly label?: string; readonly children: ReactNode }) {
  return (
    <ul className="apps-details-list" aria-label={props.label}>
      {props.children}
    </ul>
  );
}

/** A row of an AppDetailsList: its label (one line, cut short with the whole text on hover) and its value or control on the right. */
export function AppDetailsItem(props: {
  readonly label: ReactNode;
  /** The label's whole text, for the tooltip when it is cut short; a plain string label gives it itself. */
  readonly title?: string;
  /** A sentence that explains the row, behind a ? beside the label. */
  readonly hint?: string;
  /** A small amber dot before the label: the row asks for attention (a key in use, a service reached). */
  readonly tone?: 'warning';
  readonly children?: ReactNode;
}) {
  const title = props.title ?? (typeof props.label === 'string' ? props.label : undefined);
  return (
    <li className="apps-details-item" data-tone={props.tone}>
      <span className="apps-details-item-label">
        {props.tone === 'warning' && <span className="apps-details-dot" aria-hidden="true" />}
        <span className="apps-details-item-text" title={title}>
          {props.label}
        </span>
        {props.hint !== undefined && <AppDetailsHint label={title ?? 'this row'} text={props.hint} />}
      </span>
      {props.children !== undefined && <span className="apps-details-item-value">{props.children}</span>}
    </li>
  );
}

/** A label, its description beneath it in a muted colour, and its control (if any) in the right-hand column. */
export function AppDetailsRow(props: {
  readonly label: ReactNode;
  readonly description?: ReactNode;
  /** The id a control's aria-describedby points at. */
  readonly descriptionId?: string;
  readonly children?: ReactNode;
}) {
  return (
    <div className="apps-details-row">
      <div className="apps-details-row-text">
        <span className="apps-details-row-label">{props.label}</span>
        {props.description !== undefined && (
          <p className="apps-details-row-description" id={props.descriptionId}>
            {props.description}
          </p>
        )}
      </div>
      {props.children !== undefined && <div className="apps-details-row-control">{props.children}</div>}
    </div>
  );
}

/**
 * A ? that explains what is beside it. The sentence shows in the app's dark tip
 * on hover (after the usual rest) or at once on keyboard focus, and is always in
 * the document as the button's description, so a screen reader hears it without
 * hovering. The tip goes to the body: the popup's body scrolls and would clip it.
 */
export function AppDetailsHint({ label, text }: { readonly label: string; readonly text: string }) {
  assert(label.length > 0, 'A hint names what it explains');
  assert(text.length > 0, 'A hint has something to say');
  const id = useId();
  const tooltip = useDelayedTooltip();
  const [focused, setFocused] = useState<TooltipPoint | undefined>(undefined);
  const shown = focused ?? tooltip.value;
  return (
    <>
      <button
        type="button"
        className="apps-details-hint"
        aria-label={`About ${label}`}
        aria-describedby={id}
        onMouseEnter={(event: MouseEvent<HTMLElement>) => tooltip.show(event)}
        onMouseLeave={tooltip.hide}
        onFocus={(event: FocusEvent<HTMLElement>) => setFocused(tooltipPointBelow(event.currentTarget.getBoundingClientRect()))}
        onBlur={() => setFocused(undefined)}
      >
        <HelpCircleIcon size={12} />
      </button>
      <span id={id} className="apps-details-hint-text">
        {text}
      </span>
      {shown !== undefined &&
        createPortal(
          <div className="rail-tooltip below apps-details-tip" role="tooltip" style={shown}>
            {text}
          </div>,
          document.body,
        )}
    </>
  );
}
