// A date, or a date and time, picked from Stacki's own calendar rather than the
// browser's: the native picker is drawn by the operating system, in its own
// colours and layout, and cannot be styled to sit with the rest of the editor.
//
// The field shows the value as text (08/16/2026 08:30 AM), which can be typed
// over; the button opens a calendar under it. For a date-time, a Date and a
// Time tab share the popover, as Sanity Studio's picker does: picking a day
// moves on to the time, picked from an hour grid, a five-minute grid and AM/PM.
// The model (dateTimePickerModel.ts) holds every rule; this file draws it.
import { useRef, useState } from 'react';
import { CalendarIcon, ChevronLeftIcon, ChevronRightIcon, ClockIcon } from './Icons';
import useDismiss from './useDismiss';
import {
  CLOCK_HOURS,
  CLOCK_MINUTES,
  WEEKDAYS,
  clockHour,
  dayHour,
  formatPicked,
  longDay,
  localValue,
  monthGrid,
  monthName,
  monthOf,
  parseLocalValue,
  parseTyped,
  shiftMonth,
  today,
  type CalendarMonth,
  type LocalDateTime,
  type Meridiem,
  type PickerMode,
} from './dateTimePickerModel';
import './dateTimePicker.css';

interface Props {
  readonly mode: PickerMode;
  /** 'YYYY-MM-DD' for a date, local 'YYYY-MM-DDTHH:mm' for a date-time, '' for none. */
  readonly value: string;
  readonly label: string;
  readonly onChange: (value: string) => void;
}

type Tab = 'date' | 'time';

// A date-time picked with no time yet starts at noon, which no timezone moves to another day.
const NOON = 12;

export default function DateTimePicker(props: Props) {
  const { mode, value } = props;
  const root = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>('date');
  const [draft, setDraft] = useState<string | undefined>(undefined);
  const picked = pickedOf(mode, value);
  const [shown, setShown] = useState<CalendarMonth>(() => monthOf(picked?.day ?? today()));
  useDismiss(root, { active: open }, () => setOpen(false));
  const commit = (next: string) => {
    setDraft(undefined);
    if (next !== value) {
      props.onChange(next);
    }
  };
  const pickDay = (day: string) => {
    if (mode === 'date') {
      commit(day);
      setOpen(false);
      return;
    }
    commit(localValue({ day, hour: picked?.hour ?? NOON, minute: picked?.minute ?? 0 }));
    setTab('time');
  };
  const pickTime = (hour: number, minute: number) =>
    commit(localValue({ day: picked?.day ?? today(), hour, minute }));
  const toggle = () => {
    setShown(monthOf(picked?.day ?? today()));
    setTab('date');
    setOpen(!open);
  };
  return (
    <div
      ref={root}
      className="date-time-picker"
      onKeyDown={(event) => event.key === 'Escape' && open && setOpen(false)}
    >
      <PickerControl
        {...props}
        draft={draft}
        open={open}
        onDraft={setDraft}
        onCommit={commit}
        onToggle={toggle}
      />
      {open && (
        <div className="date-time-popover" role="dialog" aria-label={props.label}>
          {tab === 'date' ? (
            <CalendarPane shown={shown} selected={picked?.day} onShow={setShown} onPick={pickDay} />
          ) : (
            <TimePane picked={picked} onPick={pickTime} />
          )}
          {mode === 'datetime' && <PickerTabs tab={tab} onTab={setTab} />}
        </div>
      )}
    </div>
  );
}

// The text and the button that opens the calendar. Typed text is kept as typed
// until it is committed (Enter or leaving the field); text that names no day
// is put back to the value it replaced.
function PickerControl(
  props: Props & {
    readonly draft: string | undefined;
    readonly open: boolean;
    readonly onDraft: (draft: string | undefined) => void;
    readonly onCommit: (value: string) => void;
    readonly onToggle: () => void;
  },
) {
  const commitDraft = () => {
    if (props.draft === undefined) {
      return;
    }
    const parsed = parseTyped(props.mode, props.draft);
    if (parsed === undefined) {
      props.onDraft(undefined);
    } else {
      props.onCommit(parsed);
    }
  };
  return (
    <div className={`date-time-control ${props.open ? 'open' : ''}`}>
      <button
        type="button"
        className="date-time-open"
        aria-label={`Choose ${props.label.toLowerCase()}`}
        aria-expanded={props.open}
        title={props.mode === 'date' ? 'Open calendar' : 'Open calendar and clock'}
        onClick={props.onToggle}
      >
        <CalendarIcon size={13} />
      </button>
      <input
        aria-label={props.label}
        value={props.draft ?? formatPicked(props.mode, props.value)}
        placeholder={props.mode === 'date' ? 'MM/DD/YYYY' : 'MM/DD/YYYY hh:mm AM'}
        spellCheck={false}
        onChange={(event) => props.onDraft(event.target.value)}
        onBlur={commitDraft}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            commitDraft();
          }
        }}
      />
    </div>
  );
}

function CalendarPane(props: {
  readonly shown: CalendarMonth;
  readonly selected: string | undefined;
  readonly onShow: (month: CalendarMonth) => void;
  readonly onPick: (day: string) => void;
}) {
  const now = today();
  return (
    <div className="date-time-calendar">
      <div className="date-time-month">
        <button
          type="button"
          aria-label="Previous month"
          onClick={() => props.onShow(shiftMonth(props.shown, -1))}
        >
          <ChevronLeftIcon size={14} />
        </button>
        <span aria-live="polite">
          <strong>{monthName(props.shown.month)}</strong> {props.shown.year}
        </span>
        <button
          type="button"
          aria-label="Next month"
          onClick={() => props.onShow(shiftMonth(props.shown, 1))}
        >
          <ChevronRightIcon size={14} />
        </button>
      </div>
      <div className="date-time-days" role="grid">
        {WEEKDAYS.map((weekday) => (
          <span key={weekday} className="date-time-weekday" role="columnheader">
            {weekday}
          </span>
        ))}
        {monthGrid(props.shown).map((cell) => (
          <button
            key={cell.day}
            type="button"
            role="gridcell"
            aria-selected={cell.day === props.selected}
            className={dayClass({
              outside: cell.outside,
              selected: cell.day === props.selected,
              current: cell.day === now,
            })}
            onClick={() => props.onPick(cell.day)}
          >
            {cell.date}
          </button>
        ))}
      </div>
      {/* The chosen day in words, so the jump to today never reads as the value. */}
      <div className="date-time-footer">
        <span className="date-time-chosen">
          {props.selected === undefined ? 'No date chosen' : longDay(props.selected)}
        </span>
        <button
          type="button"
          className="date-time-today"
          title="Go to today"
          onClick={() => props.onPick(now)}
        >
          Today
        </button>
      </div>
    </div>
  );
}

function TimePane(props: {
  readonly picked: LocalDateTime | undefined;
  readonly onPick: (hour: number, minute: number) => void;
}) {
  const hour = props.picked?.hour ?? NOON;
  const minute = props.picked?.minute ?? 0;
  const clock = clockHour(hour);
  // A time is picked only once it has been chosen: an empty field lights nothing.
  const set = props.picked !== undefined;
  return (
    <div className="date-time-clock">
      <span className="date-time-heading">Hour</span>
      <div className="date-time-grid">
        {CLOCK_HOURS.map((option) => (
          <button
            key={option}
            type="button"
            className={set && option === clock.hour ? 'on' : ''}
            onClick={() => props.onPick(dayHour(option, clock.meridiem), minute)}
          >
            {option}
          </button>
        ))}
      </div>
      <span className="date-time-heading">Minute</span>
      <div className="date-time-grid">
        {CLOCK_MINUTES.map((option) => (
          <button
            key={option}
            type="button"
            className={set && option === minute ? 'on' : ''}
            onClick={() => props.onPick(hour, option)}
          >
            :{String(option).padStart(2, '0')}
          </button>
        ))}
      </div>
      <div className="date-time-meridiem">
        {(['AM', 'PM'] as const satisfies readonly Meridiem[]).map((option) => (
          <button
            key={option}
            type="button"
            className={set && option === clock.meridiem ? 'on' : ''}
            onClick={() => props.onPick(dayHour(clock.hour, option), minute)}
          >
            {option}
          </button>
        ))}
      </div>
    </div>
  );
}

function PickerTabs(props: { readonly tab: Tab; readonly onTab: (tab: Tab) => void }) {
  return (
    <div className="date-time-tabs" role="tablist">
      <button
        type="button"
        role="tab"
        aria-selected={props.tab === 'date'}
        onClick={() => props.onTab('date')}
      >
        <CalendarIcon size={14} /> Date
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={props.tab === 'time'}
        onClick={() => props.onTab('time')}
      >
        <ClockIcon size={14} /> Time
      </button>
    </div>
  );
}

// The value as a day and time; a date alone reads as that day at no particular time.
function pickedOf(mode: PickerMode, value: string): LocalDateTime | undefined {
  if (mode === 'datetime') {
    return parseLocalValue(value);
  }
  const typed = parseTyped('date', value);
  return typed ? { day: typed, hour: NOON, minute: 0 } : undefined;
}

function dayClass(state: {
  readonly outside: boolean;
  readonly selected: boolean;
  readonly current: boolean;
}): string {
  return [
    'date-time-day',
    state.outside ? 'outside' : '',
    state.selected ? 'on' : '',
    state.current ? 'today' : '',
  ].join(' ');
}
