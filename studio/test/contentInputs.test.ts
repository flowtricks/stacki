// Goal: HTML detection and date edits preserve data rather than guessing at formats.
// Method: exercise the shared models with leap days, UTC/offset timestamps, malformed
// dates, markup/plain text, unsafe links, and boundary limits. Browser tests cover the DOM.
import test from 'node:test';
import assert from 'node:assert/strict';
import { calendarValue, replaceCalendarDay } from '../vendor/stacki/src/ui/dateFieldModel';
import { containsHTML, safeHTMLLink } from '../vendor/stacki/src/ui/htmlFieldModel';
import { BOUNDARY_LIMITS } from '../vendor/stacki/shared/core/boundary';

test('calendar editing keeps the written day, time, precision and timezone', () => {
  for (const suffix of ['', 'T00:00:00.000Z', 'T23:12:34.123456+05:30', ' 08:15:00-06:00']) {
    assert.deepEqual(calendarValue('2026-10-25' + suffix), { day: '2026-10-25', suffix });
    assert.equal(replaceCalendarDay('2026-10-25' + suffix, '2028-02-29'), '2028-02-29' + suffix);
  }
  assert.equal(replaceCalendarDay('', '2026-11-01'), '2026-11-01');
});

test('invalid dates remain outside the calendar model', () => {
  for (const value of [
    '',
    'tomorrow',
    '2026-02-29',
    '2026-13-01',
    '2026-10-25T28:00:00Z',
    '2026-10-25T24:00:00Z',
    '2026-10-25<script>',
    '2026-10-25T00:00:00+99:00',
    'x'.repeat(41),
  ]) {
    assert.equal(calendarValue(value), undefined, value);
  }
  assert.throws(() => replaceCalendarDay('invalid', '2026-10-25'), /timestamp must be understood/);
  assert.throws(() => replaceCalendarDay('2026-10-25', '2026-02-29'), /valid calendar day/);
});

test('HTML fields recognize markup without mistaking plain comparisons for tags', () => {
  for (const value of [
    '<p>One</p><p>Two</p>',
    '<strong>Bold</strong>',
    'Text <br/> more',
    '<h2 class="heading">Title</h2>',
  ]) {
    assert.equal(containsHTML(value), true);
  }
  for (const value of ['Plain text', 'a < b and c > d', '5 > 4', '&lt;p&gt;', '']) {
    assert.equal(containsHTML(value), false);
  }
  assert.throws(() => containsHTML('x'.repeat(BOUNDARY_LIMITS.textLengthMax + 1)), /text limit/);
});

test('rich text links accept navigation URLs and reject executable protocols', () => {
  for (const value of ['https://example.com', 'mailto:hello@example.com', '/about', '#contact']) {
    assert.equal(safeHTMLLink(value), true);
  }
  for (const value of ['javascript:alert(1)', 'java\nscript:alert(1)', 'data:text/html,test', '']) {
    assert.equal(safeHTMLLink(value), false);
  }
});
