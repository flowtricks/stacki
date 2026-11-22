// Goal: the "Ask me to keep AI changes" preference behaves as one value for the whole panel. It defaults to auto (edits
// apply at once), loads the saved choice, applies a flip at once, saves it through the preferences channel, puts the
// screen back when saving fails, and ignores a malformed reply at the boundary.
// Method: bundle the real store with esbuild, give it a fake preload (window.avb) that records every save, and read
// the mode back after each call.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadTranscript } = require('../../helpers/aiTranscriptDom.js');

const { modules: view } = loadTranscript('aiReviewChanges', [
  "export { currentReviewMode, loadReviewMode, publishReviewMode, saveReviewMode } from './src/features/ai/reviewChanges';",
]);

function fakePreferences({ stored, failSet = false }) {
  const calls = [];
  const everything = (aiReviewChanges) => ({
    sound: false,
    usageCountsEnabled: true,
    appsPersonHidden: false,
    aiAskBeforeTrust: false,
    aiTrackChanges: true,
    aiReviewChanges,
    codeChips: true,
  });
  window.avb = {
    settings: async () => everything(stored),
    setPreference: async (payload) => {
      calls.push(payload);
      if (failSet) {
        throw new Error('disk full');
      }
      return { ...everything(payload.enabled), saved: true };
    },
  };
  return calls;
}

test('the review preference defaults to auto, loads the saved choice, and saves a flip at once', async () => {
  view.publishReviewMode('auto');
  assert.equal(view.currentReviewMode(), 'auto');
  fakePreferences({ stored: true });
  await view.loadReviewMode();
  assert.equal(view.currentReviewMode(), 'review', 'an existing stored choice is kept');
  const calls = fakePreferences({ stored: true });
  const saved = await view.saveReviewMode('auto');
  assert.equal(saved, true);
  assert.deepEqual(calls, [{ setting: 'aiReviewChanges', enabled: false }]);
  assert.equal(view.currentReviewMode(), 'auto');
});

test('a failed save puts the screen back to what was saved, and a failed read keeps the default', async (context) => {
  const originalError = console.error;
  console.error = () => undefined;
  context.after(() => {
    console.error = originalError;
  });
  view.publishReviewMode('auto');
  fakePreferences({ stored: false, failSet: true });
  assert.equal(await view.saveReviewMode('review'), false);
  assert.equal(view.currentReviewMode(), 'auto');
  window.avb = {
    settings: async () => ({ nonsense: true }),
    setPreference: async () => undefined,
  };
  await view.loadReviewMode();
  assert.equal(view.currentReviewMode(), 'auto', 'a malformed reply is refused at the boundary');
});
