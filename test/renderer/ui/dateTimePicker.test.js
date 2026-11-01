// Stacki's own date and time picker: its model, then the picker itself.
//
// The model is checked directly: a month's grid always holds six weeks that
// start on a Sunday and line up with the real calendar; 12-hour and 24-hour
// clocks convert both ways; typed text becomes a stored value only when it
// names a real day and time, and anything else (31 February, 13 PM, an
// over-long string) is refused rather than guessed at. Its assertions are
// checked by message. A date field holding a timestamp is edited with its time
// as written: the zone and separator survive, and seconds survive a day change.
//
// The picker is then mounted in JSDOM and driven as a person would: open the
// calendar, step to the next month, pick a day, move on to the time tab and
// pick an hour, a minute and PM; and type a value over the text.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const { ROOT, repoPath } = require('../../helpers/sources.js');

const output = repoPath('node_modules/.stacki-test/date-time-picker.cjs');
fs.mkdirSync(path.dirname(output), { recursive: true });
buildSync({
  stdin: {
    contents: `export {default as DateTimePicker} from './src/ui/DateTimePicker';
      export * from './src/ui/dateTimePickerModel';
      export * from './src/ui/dateFieldModel';`,
    resolveDir: ROOT,
    loader: 'ts',
  },
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  jsx: 'automatic',
  loader: { '.css': 'empty' },
  external: ['react', 'react-dom', 'react/jsx-runtime'],
  logLevel: 'silent',
});
const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
global.window = dom.window;
for (const name of ['document', 'navigator', 'HTMLElement', 'Element', 'Node']) {
  global[name] = dom.window[name];
}
global.IS_REACT_ACT_ENVIRONMENT = true;
const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const picker = require(output);

test('a month shows six weeks from a Sunday, its neighbours dimmed', () => {
  const august = picker.monthGrid({ year: 2026, month: 8 });
  assert.equal(august.length, 42);
  assert.deepEqual(august[0], { day: '2026-07-26', date: 26, outside: true });
  assert.deepEqual(august[6], { day: '2026-08-01', date: 1, outside: false });
  assert.equal(august.filter((cell) => !cell.outside).length, 31);
  assert.equal(new Date(august[0].day + 'T00:00:00Z').getUTCDay(), 0);
  const leap = picker.monthGrid({ year: 2028, month: 2 });
  assert.equal(leap.filter((cell) => !cell.outside).length, 29);
  // Years under 100 stay themselves rather than becoming 19xx.
  assert.equal(
    picker.monthGrid({ year: 5, month: 1 }).some((cell) => cell.day === '0005-01-01'),
    true,
  );
});

test('stepping months crosses years and stops at the years a field can hold', () => {
  assert.deepEqual(picker.shiftMonth({ year: 2026, month: 12 }, 1), { year: 2027, month: 1 });
  assert.deepEqual(picker.shiftMonth({ year: 2026, month: 1 }, -1), { year: 2025, month: 12 });
  assert.deepEqual(picker.shiftMonth({ year: 9999, month: 12 }, 1), { year: 9999, month: 12 });
  assert.deepEqual(picker.shiftMonth({ year: 1, month: 1 }, -1), { year: 1, month: 1 });
  assert.throws(() => picker.shiftMonth({ year: 2026, month: 13 }, 1), /A month is at most 12/);
  assert.throws(() => picker.shiftMonth({ year: 2026, month: 1 }, 0.5), /A month step is whole/);
});

test('the clock converts between 12 and 24 hours both ways', () => {
  assert.deepEqual(picker.clockHour(0), { hour: 12, meridiem: 'AM' });
  assert.deepEqual(picker.clockHour(12), { hour: 12, meridiem: 'PM' });
  assert.deepEqual(picker.clockHour(19), { hour: 7, meridiem: 'PM' });
  for (let hour = 0; hour < 24; hour++) {
    const clock = picker.clockHour(hour);
    assert.equal(picker.dayHour(clock.hour, clock.meridiem), hour);
  }
  assert.throws(() => picker.clockHour(24), /An hour is at most 23/);
  assert.throws(() => picker.dayHour(0, 'AM'), /A clock hour is at least 1/);
  assert.throws(() => picker.dayHour(13, 'PM'), /A clock hour is at most 12/);
});

test('values show as the picker writes them, and unknown text shows as it is', () => {
  assert.equal(picker.formatPicked('date', '2026-08-16'), '08/16/2026');
  assert.equal(picker.formatPicked('datetime', '2026-08-16T08:30'), '08/16/2026 08:30 AM');
  assert.equal(picker.formatPicked('datetime', '2026-08-15T19:00'), '08/15/2026 07:00 PM');
  assert.equal(picker.formatPicked('datetime', 'soon'), 'soon');
  assert.throws(() => picker.localValue({ day: '2026-02-30', hour: 1, minute: 0 }), /A date-time has a real day/);
  assert.throws(() => picker.localValue({ day: '2026-02-01', hour: 1, minute: 60 }), /A minute is at most 59/);
});

test('a chosen day is named in words, and only a real day is', () => {
  assert.equal(picker.longDay('2026-08-14'), 'Friday, August 14, 2026');
  assert.equal(picker.longDay('2028-02-29'), 'Tuesday, February 29, 2028');
  assert.throws(() => picker.longDay('2026-02-30'), /Only a real day is named/);
});

test('typed text becomes a value only when it names a real day and time', () => {
  assert.equal(picker.parseTyped('date', '8/16/2026'), '2026-08-16');
  assert.equal(picker.parseTyped('date', '2026-08-16'), '2026-08-16');
  assert.equal(picker.parseTyped('date', '  '), '');
  assert.equal(picker.parseTyped('datetime', '08/16/2026 08:30 PM'), '2026-08-16T20:30');
  assert.equal(picker.parseTyped('datetime', '08/16/2026 12:05 am'), '2026-08-16T00:05');
  assert.equal(picker.parseTyped('datetime', '08/16/2026 17:45'), '2026-08-16T17:45');
  assert.equal(picker.parseTyped('datetime', '08/16/2026'), '2026-08-16T00:00');
  assert.equal(picker.parseTyped('datetime', '2026-08-16T08:30'), '2026-08-16T08:30');
  for (const bad of ['02/30/2026', '13/01/2026', 'tomorrow', '2026-8-16']) {
    assert.equal(picker.parseTyped('date', bad), undefined, bad);
  }
  for (const bad of ['08/16/2026 13:00 PM', '08/16/2026 00:10 AM', '08/16/2026 24:00']) {
    assert.equal(picker.parseTyped('datetime', bad), undefined, bad);
  }
  assert.equal(picker.parseTyped('datetime', '08/16/2026 08:61'), undefined);
  assert.equal(picker.parseTyped('date', '1'.repeat(41)), undefined);
});

async function mount(props) {
  const root = createRoot(document.getElementById('root'));
  let value = props.value;
  const changes = [];
  // eslint-disable-next-line stacki/bounded-recursion -- Event re-entry: onChange re-renders.
  const render = () =>
    root.render(
      React.createElement(picker.DateTimePicker, {
        ...props,
        value,
        onChange(next) {
          changes.push(next);
          value = next;
          render();
        },
      }),
    );
  await act(async () => render());
  return { root, changes };
}

const button = (text) => [...document.querySelectorAll('.date-time-popover button')].find((element) => element.textContent.trim() === text);
const click = (element) => act(async () => element.click());

test('a date-time is picked day first, then hour, minute and half of the day', async () => {
  const { root, changes } = await mount({
    mode: 'datetime',
    label: 'Sermon date',
    value: '2026-08-15T19:00',
  });
  try {
    await click(document.querySelector('.date-time-open'));
    assert.match(document.querySelector('.date-time-month').textContent, /August\s+2026/);
    assert.equal(document.querySelector('.date-time-day.on').textContent, '15');
    assert.equal(document.querySelector('.date-time-chosen').textContent, 'Saturday, August 15, 2026', 'the footer names the chosen day, not today');
    await click(document.querySelector('[aria-label="Next month"]'));
    assert.match(document.querySelector('.date-time-month').textContent, /September\s+2026/);
    const sixth = [...document.querySelectorAll('.date-time-day:not(.outside)')].find((element) => element.textContent === '6');
    await click(sixth);
    assert.equal(changes.at(-1), '2026-09-06T19:00', 'the day changes, the time stays');
    assert.ok(document.querySelector('.date-time-clock'), 'a picked day moves on to the time');
    await click(button('8'));
    await click(button(':30'));
    await click(button('AM'));
    assert.equal(changes.at(-1), '2026-09-06T08:30');
    assert.equal(document.querySelector('.date-time-control input').value, '09/06/2026 08:30 AM');
    await act(async () => document.querySelector('.date-time-picker').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    assert.ok(document.querySelector('.date-time-popover') === null, 'Escape closes it');
  } finally {
    await act(async () => root.unmount());
  }
});

test('a date closes on its day, and typed text that names none is put back', async () => {
  const { root, changes } = await mount({ mode: 'date', label: 'Published', value: '' });
  try {
    await click(document.querySelector('.date-time-open'));
    assert.ok(document.querySelector('.date-time-tabs') === null, 'a date has no time tab');
    assert.equal(document.querySelector('.date-time-chosen').textContent, 'No date chosen');
    await click(button('Today'));
    assert.equal(changes.length, 1);
    assert.match(changes[0], /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(document.querySelector('.date-time-popover') === null);
    const input = document.querySelector('.date-time-control input');
    const type = (text) =>
      act(async () => {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
        setter.set.call(input, text);
        input.dispatchEvent(new window.Event('input', { bubbles: true }));
      });
    await type('02/30/2026');
    await act(async () => input.dispatchEvent(new window.FocusEvent('focusout', { bubbles: true })));
    assert.equal(changes.length, 1, 'no such day is written');
    assert.equal(input.value, picker.formatPicked('date', changes[0]));
    await type('12/25/2026');
    await act(async () => input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    assert.equal(changes.at(-1), '2026-12-25');
  } finally {
    await act(async () => root.unmount());
  }
});

test('a timestamp is edited as written, keeping its zone and separator', () => {
  const stamp = picker.calendarValue('2026-09-09T18:41:47.843Z');
  assert.equal(picker.calendarLocalValue(stamp), '2026-09-09T18:41');
  const value = '2026-09-09T18:41:47.843Z';
  assert.equal(picker.replaceCalendarLocal(value, '2026-09-12T18:41'), '2026-09-12T18:41:47.843Z');
  assert.equal(picker.replaceCalendarLocal(value, '2026-09-09T07:05'), '2026-09-09T07:05Z');
  assert.equal(picker.replaceCalendarLocal('2026-01-02 10:00+02:00', '2026-01-03T11:30'), '2026-01-03 11:30+02:00');
  assert.equal(picker.replaceCalendarLocal('2026-01-02T10:00', '2026-01-02T23:59'), '2026-01-02T23:59');
  assert.throws(() => picker.calendarLocalValue({ day: '2026-01-02', suffix: '' }), /only a timestamp has a time/);
  assert.throws(() => picker.replaceCalendarLocal('2026-01-02', '2026-01-02T10:00'), /only a timestamp/);
  assert.throws(() => picker.replaceCalendarLocal(value, '2026-02-31T10:00'), /a real day/);
});
