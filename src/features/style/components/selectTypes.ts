// The shapes a Select is built from: an option, the component's props, and
// the key input its handlers read (Select.tsx).

import type { ReactNode } from 'react';

export type SelectOption<T extends string> = {
  value: T;
  /** Plain-text label — also used for type-ahead matching. */
  label: string;
  /** A smaller, muted first line above the label, in the list and the closed
   *  trigger alike (e.g. the selector a nested query is written inside). Absent
   *  means the option is one line. Not used for type-ahead: the label names it. */
  overline?: string;
  /** Optional leading icon (e.g. a preset glyph). */
  icon?: ReactNode;
  /** Show a trailing status dot (white on the selected row, accent otherwise). */
  marked?: boolean;
  /** Render as a non-selectable group subheader — skipped by keyboard nav,
   *  type-ahead, and selection. Its `value` just needs to be unique. */
  heading?: boolean;
  /** Indent the option to show it nests under the preceding heading. */
  indent?: boolean;
  /** Text for the closed trigger when this option is selected — use when the
   *  list label is context-scoped (e.g. "Embed #1" under a group) but the trigger
   *  needs the full name ("Global Styles #1"). Falls back to `label`. */
  triggerLabel?: string;
  /** Icon for the closed trigger when this option is selected. Falls back to
   *  `icon` — use when the trigger icon differs from the list-row icon. */
  triggerIcon?: ReactNode;
  /** Opaque tone token exposed on the trigger as `data-tone` when this option is
   *  selected, so the consumer can color the trigger per option (via its CSS). */
  tone?: string;
  /** A control on the row itself — an edit pencil, say. Pressing it closes the
   *  menu and runs `onSelect` WITHOUT choosing the option: it acts on the option
   *  rather than picking it. Shown on the hovered/active row only. */
  action?: { icon: ReactNode; label: string; onSelect: () => void };
};

export type Props<T extends string> = {
  value: T;
  onChange: (value: T) => void;
  options: SelectOption<T>[];
  ariaLabel?: string;
  /** id of an external element that labels this control (aria-labelledby). */
  labelId?: string;
  className?: string;
  disabled?: boolean;
  id?: string;
  /** When provided, the trigger renders this editable field in place of the
   *  value label; the chevron still opens the option list. Turns the closed
   *  control into an input+arrow chip (mirroring the Display control's custom
   *  mode). The field owns its own value/commit logic. */
  customInput?: ReactNode;
  /** 'default' renders the pill trigger; 'link' renders a compact text-link
   *  trigger (label + small chevron, no fill) that still opens the same list. */
  variant?: 'default' | 'link';
  /** Show a filter input pinned to the top of the open list — matches option
   *  labels (substring, case-insensitive) and keeps a group heading only when one
   *  of its options matches. Arrow/Enter/Escape still drive the list while typing. */
  searchable?: boolean;
  /** Placeholder for the search input (searchable only). */
  searchPlaceholder?: string;
  /** Render the closed trigger with its label only, even when the selected option
   *  has an icon (the icons still show in the open list). */
  hideTriggerIcon?: boolean;
  /** Live-preview the highlighted option while the list is open (Webflow's hover
   *  scrub): called with a value as the pointer / arrow keys land on it, and with
   *  `undefined` when the list closes WITHOUT a pick — meaning put the original back.
   *  Highlighting the already-selected row re-emits its value, so scrubbing back
   *  over it restores what was there. A pick fires `onChange` instead, and never a
   *  trailing `undefined`: the commit is the value. */
  onPreview?: (value: T | undefined) => void;
};
