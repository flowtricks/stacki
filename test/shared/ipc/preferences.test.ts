// Verify preference replies before the desktop settings popup consumes them, and the changes it sends.
// Valid values round-trip; missing and malformed fields are rejected; the canvas scrollbar's breakpoint id is read
// into its typed form, and a change's parsed output parses again unchanged (the renderer sends what it parsed).
import assert from 'node:assert/strict';
import test from 'node:test';
import { parsePreferenceChange, parsePreferenceName, parsePreferences, parsePreferenceResult } from '#dist/shared/ipc/preferences.js';

test('desktop preference replies require boolean values and save status', () => {
  // Main always sends every preference, appsPersonHidden included (electron/main.ts), so none is optional here.
  const switches = {
    sound: true,
    usageCountsEnabled: false,
    appsPersonHidden: true,
    aiAskBeforeTrust: false,
    aiTrackChanges: true,
    aiReviewChanges: false,
    codeChips: true,
  };
  const preferences = { ...switches, canvasScrollbar: 'laptop' };
  const parsed = { ...switches, canvasScrollbar: { kind: 'from', breakpointId: 'laptop' } };
  assert.deepEqual(parsePreferences(preferences), parsed);
  assert.deepEqual(parsePreferences({ ...preferences, canvasScrollbar: 'off' }).canvasScrollbar, { kind: 'off' });
  assert.deepEqual(parsePreferenceResult({ ...preferences, saved: true }), {
    ...parsed,
    saved: true,
  });
  for (const canvasScrollbar of [undefined, '', 'Laptop', true, 3]) {
    assert.throws(() => parsePreferences({ ...preferences, canvasScrollbar }));
  }
  for (const value of [
    undefined,
    {},
    { sound: 'yes', usageCountsEnabled: true, appsPersonHidden: false },
    { sound: true, usageCountsEnabled: true },
    { sound: true, usageCountsEnabled: true, appsPersonHidden: 'no' },
    { sound: true, usageCountsEnabled: true, appsPersonHidden: false, aiAskBeforeTrust: 'no' },
    { sound: true, usageCountsEnabled: true, appsPersonHidden: false, aiAskBeforeTrust: false },
    { sound: true, usageCountsEnabled: true, appsPersonHidden: false, aiAskBeforeTrust: false, aiTrackChanges: 'off' },
    { sound: true, usageCountsEnabled: true, appsPersonHidden: false, aiAskBeforeTrust: false, aiTrackChanges: true },
    { sound: true, usageCountsEnabled: true, appsPersonHidden: false, aiAskBeforeTrust: false, aiTrackChanges: true, aiReviewChanges: 'on' },
    { sound: true, usageCountsEnabled: true, appsPersonHidden: false, aiAskBeforeTrust: false, aiTrackChanges: true, aiReviewChanges: false },
    { ...preferences, codeChips: 'on' },
    { ...preferences, codeChips: 1 },
  ]) {
    assert.throws(() => parsePreferences(value));
  }
  for (const saved of [undefined, 'yes', 1]) {
    assert.throws(() => parsePreferenceResult({ ...preferences, saved }));
  }
});

test('a preference change names a known preference', () => {
  for (const name of ['sound', 'usageCountsEnabled', 'appsPersonHidden', 'aiAskBeforeTrust', 'aiTrackChanges', 'aiReviewChanges', 'codeChips']) {
    assert.equal(parsePreferenceName(name), name);
  }
  for (const name of [undefined, '', 'Sound', 'appsPerson', 17]) {
    assert.throws(() => parsePreferenceName(name), /Unknown preference/);
  }
});

test('a preference change is a switch flipped or the canvas scrollbar breakpoint, and parses again unchanged', () => {
  const flip = parsePreferenceChange({ setting: 'codeChips', enabled: false });
  assert.deepEqual(flip, { setting: 'codeChips', enabled: false });
  assert.deepEqual(parsePreferenceChange(flip), flip);
  for (const value of ['off', 'laptop', 'bp-12']) {
    const pick = parsePreferenceChange({ setting: 'canvasScrollbar', value });
    assert.deepEqual(pick, { setting: 'canvasScrollbar', value });
    assert.deepEqual(parsePreferenceChange(pick), pick);
  }
  for (const input of [
    undefined,
    'canvasScrollbar',
    { setting: 'canvasScrollbar' },
    { setting: 'canvasScrollbar', value: '' },
    { setting: 'canvasScrollbar', value: 'Laptop' },
    { setting: 'canvasScrollbar', value: 'x'.repeat(25) },
    { setting: 'canvasScrollbar', enabled: true },
    { setting: 'codeChips', value: 'laptop' },
    { setting: 'codeChips', enabled: 'no' },
    { setting: 'unknown', enabled: true },
  ]) {
    assert.throws(() => parsePreferenceChange(input), Error, JSON.stringify(input));
  }
});
