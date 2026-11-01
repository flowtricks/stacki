import DateTimePicker from './DateTimePicker';
import {
  calendarLocalValue,
  calendarValue,
  replaceCalendarDay,
  replaceCalendarLocal,
} from './dateFieldModel';
import './contentInputs.css';

interface Props {
  readonly value: string;
  readonly label?: string | undefined;
  readonly onChange: (value: string) => void;
}

export default function DateField({ value, label = 'Date', onChange }: Props) {
  const parsed = calendarValue(value);
  // Invalid existing values remain repairable, never silently replaced by today.
  if (value && !parsed) {
    return (
      <input aria-label={label} value={value} onChange={(event) => onChange(event.target.value)} />
    );
  }
  // A timestamp is edited with its time; the zone it was written in is kept.
  if (parsed?.suffix) {
    return (
      <div className="date-field">
        <DateTimePicker
          mode="datetime"
          label={label}
          value={calendarLocalValue(parsed)}
          onChange={(local) => onChange(local ? replaceCalendarLocal(value, local) : '')}
        />
      </div>
    );
  }
  return (
    <div className="date-field">
      <DateTimePicker
        mode="date"
        label={label}
        value={parsed?.day ?? ''}
        onChange={(day) => onChange(day ? replaceCalendarDay(value, day) : '')}
      />
    </div>
  );
}
