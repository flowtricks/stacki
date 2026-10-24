import { useRef } from 'react';
import { CalendarIcon } from './Icons';
import { calendarValue, replaceCalendarDay } from './dateFieldModel';
import './contentInputs.css';

interface Props {
  readonly value: string;
  readonly label?: string | undefined;
  readonly onChange: (value: string) => void;
}

export default function DateField({ value, label = 'Date', onChange }: Props) {
  const input = useRef<HTMLInputElement>();
  const parsed = calendarValue(value);
  // Invalid existing values remain repairable, never silently replaced by today.
  if (value && !parsed) {
    return (
      <input aria-label={label} value={value} onChange={(event) => onChange(event.target.value)} />
    );
  }
  return (
    <div className="date-field">
      <div className="date-field-control">
        <input
          ref={(element) => {
            input.current = element ?? undefined;
          }}
          aria-label={label}
          type="date"
          min="0001-01-01"
          max="9999-12-31"
          value={parsed?.day ?? ''}
          onChange={(event) => {
            const day = event.target.value;
            onChange(day ? replaceCalendarDay(value, day) : '');
          }}
        />
        <button
          type="button"
          className="date-field-open"
          aria-label={`Choose ${label.toLowerCase()}`}
          title="Open calendar"
          onClick={() => {
            input.current?.focus();
            input.current?.showPicker?.();
          }}
        >
          <CalendarIcon size={16} />
        </button>
      </div>
      {parsed?.suffix && (
        <span className="date-field-time" title="Changing the day preserves this time and timezone">
          Time {parsed.suffix.slice(1).replace(/Z$/, ' UTC')}
        </span>
      )}
    </div>
  );
}
