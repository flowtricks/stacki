// Verify preference replies before the desktop settings popup consumes them.
// Valid values round-trip; missing and malformed boolean fields are rejected.
import assert from 'node:assert/strict';
import test from 'node:test';
import { parsePreferenceName, parsePreferences, parsePreferenceResult } from '#dist/shared/ipc/preferences.js';

test('desktop preference replies require boolean values and save status', () => {
  // Main always sends every preference, appsPersonHidden included (electron/main.ts), so none is optional here.
  const preferences = { sound: true, usageCountsEnabled: false, appsPersonHidden: true, aiAskBeforeTrust: false, aiTrackChanges: true };
  assert.deepEqual(parsePreferences(preferences), preferences);
  assert.deepEqual(parsePreferenceResult({ ...preferences, saved: true }), {
    ...preferences,
    saved: true,
  });
  for (const value of [
    undefined,
    {},
    { sound: 'yes', usageCountsEnabled: true, appsPersonHidden: false },
    { sound: true, usageCountsEnabled: true },
    { sound: true, usageCountsEnabled: true, appsPersonHidden: 'no' },
    { sound: true, usageCountsEnabled: true, appsPersonHidden: false, aiAskBeforeTrust: 'no' },
    { sound: true, usageCountsEnabled: true, appsPersonHidden: false, aiAskBeforeTrust: false },
    { sound: true, usageCountsEnabled: true, appsPersonHidden: false, aiAskBeforeTrust: false, aiTrackChanges: 'off' },
  ]) {
    assert.throws(() => parsePreferences(value));
  }
  for (const saved of [undefined, 'yes', 1]) {
    assert.throws(() => parsePreferenceResult({ ...preferences, saved }));
  }
});

test('a preference change names a known preference', () => {
  for (const name of ['sound', 'usageCountsEnabled', 'appsPersonHidden', 'aiAskBeforeTrust', 'aiTrackChanges']) {
    assert.equal(parsePreferenceName(name), name);
  }
  for (const name of [undefined, '', 'Sound', 'appsPerson', 17]) {
    assert.throws(() => parsePreferenceName(name), /Unknown preference/);
  }
});
