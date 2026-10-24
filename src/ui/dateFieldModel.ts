import { assert } from '../../shared/core/assert';

const DAY_PATTERN = '\\d{4}-\\d{2}-\\d{2}';
const TIME_PATTERN = '[T ](?:[01]\\d|2[0-3]):[0-5]\\d';
const SECONDS_PATTERN = '(?::[0-5]\\d(?:\\.\\d{1,9})?)?';
const ZONE_PATTERN = '(?:Z|[+-](?:[01]\\d|2[0-3]):[0-5]\\d)?';
const CALENDAR_PATTERN = new RegExp(
  `^(${DAY_PATTERN})(${TIME_PATTERN}${SECONDS_PATTERN}${ZONE_PATTERN})?$`,
);

export interface CalendarValue {
  readonly day: string;
  readonly suffix: string;
}

// Keep the written calendar day and timestamp suffix. Converting through local
// Date getters shifts midnight UTC to yesterday in many editors' timezones.
export function calendarValue(value: string): CalendarValue | undefined {
  if (value.length > 40) {
    return undefined;
  }
  const match = CALENDAR_PATTERN.exec(value);
  const day = match?.[1];
  if (!day || !validCalendarDay(day)) {
    return undefined;
  }
  const suffix = match?.[2] ?? '';
  if (suffix && !Number.isFinite(Date.parse(day + suffix.replace(' ', 'T')))) {
    return undefined;
  }
  return { day, suffix };
}

export function validCalendarDay(day: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    return false;
  }
  const date = new Date(day + 'T00:00:00.000Z');
  return Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === day;
}

export function replaceCalendarDay(value: string, day: string): string {
  assert(validCalendarDay(day), 'Date field: a valid calendar day is required');
  const parsed = value === '' ? { day, suffix: '' } : calendarValue(value);
  assert(parsed !== undefined, 'Date field: existing timestamp must be understood');
  return day + parsed.suffix;
}
