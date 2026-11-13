import DateTimePicker from './DateTimePicker';
import { calendarLocalValue, calendarValue, replaceCalendarDay, replaceCalendarLocal } from './dateFieldModel';
import './contentInputs.css';
import { useTranslate } from '../lib/i18n/useTranslate';

interface Props {
  readonly value: string;
  readonly label?: string | undefined;
  readonly onChange: (value: string) => void;
}

export default function DateField({ value, label, onChange }: Props) {
  const translate = useTranslate();
  const fieldLabel = label ?? translate('ui.dateField.label');
  const parsed = calendarValue(value);
  // Invalid existing values remain repairable, never silently replaced by today.
  if (value && !parsed) {
    return <input aria-label={fieldLabel} value={value} onChange={(event) => onChange(event.target.value)} />;
  }
  // A timestamp is edited with its time; the zone it was written in is kept.
  if (parsed?.suffix) {
    return (
      <div className="date-field">
        <DateTimePicker
          mode="datetime"
          label={fieldLabel}
          value={calendarLocalValue(parsed)}
          onChange={(local) => onChange(local ? replaceCalendarLocal(value, local) : '')}
        />
      </div>
    );
  }
  return (
    <div className="date-field">
      <DateTimePicker mode="date" label={fieldLabel} value={parsed?.day ?? ''} onChange={(day) => onChange(day ? replaceCalendarDay(value, day) : '')} />
    </div>
  );
}
