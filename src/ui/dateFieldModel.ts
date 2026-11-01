import { assert } from '../../shared/core/assert';

const DAY_PATTERN = '\\d{4}-\\d{2}-\\d{2}';
const TIME_PATTERN = '[T ](?:[01]\\d|2[0-3]):[0-5]\\d';
const SECONDS_PATTERN = '(?::[0-5]\\d(?:\\.\\d{1,9})?)?';
const ZONE_PATTERN = '(?:Z|[+-](?:[01]\\d|2[0-3]):[0-5]\\d)?';
const CALENDAR_PATTERN = new RegExp(`^(${DAY_PATTERN})(${TIME_PATTERN}${SECONDS_PATTERN}${ZONE_PATTERN})?$`);

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

/**
 * A timestamp's day and wall-clock time as the date-and-time picker edits them
 * (`2026-09-09T18:41`), read as written: a UTC value shows its UTC time, so a
 * day never shifts with the editor's timezone, and the zone is kept on write.
 */
export function calendarLocalValue(value: CalendarValue): string {
  assert(value.suffix !== '', 'Date field: only a timestamp has a time');
  const time = value.suffix.slice(1, 6);
  assert(/^\d{2}:\d{2}$/.test(time), 'Date field: a timestamp starts with its hours and minutes');
  return `${value.day}T${time}`;
}

/**
 * The timestamp with the picker's day and time, keeping the original separator
 * and zone; its seconds are kept only while the minute is unchanged.
 */
export function replaceCalendarLocal(value: string, local: string): string {
  const parsed = calendarValue(value);
  assert(parsed !== undefined, 'Date field: existing timestamp must be understood');
  assert(parsed.suffix !== '', 'Date field: only a timestamp has a time');
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/.exec(local);
  const day = match?.[1];
  const time = match?.[2];
  assert(day !== undefined, 'Date field: the picker gives a day');
  assert(validCalendarDay(day), 'Date field: the picker gives a real day');
  assert(time !== undefined, 'Date field: the picker gives a time');
  const separator = parsed.suffix.slice(0, 1);
  const rest = parsed.suffix.slice(6);
  const zone = /(?:Z|[+-]\d{2}:\d{2})$/.exec(rest)?.[0] ?? '';
  const sameMinute = time === parsed.suffix.slice(1, 6);
  const seconds = sameMinute ? rest.slice(0, rest.length - zone.length) : '';
  const next = `${day}${separator}${time}${seconds}${zone}`;
  assert(calendarValue(next) !== undefined, 'Date field: the new timestamp is readable');
  return next;
}
