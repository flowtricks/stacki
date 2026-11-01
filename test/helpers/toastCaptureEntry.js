// Goal: feature tests observe the same error handoff consumed by the application toast owner.
// Method: inject this subscriber into each component bundle; the real stack has separate DOM tests.
const { subscribeErrorToasts } = require('../../src/ui/errorNotices');
globalThis.stackiCapturedToasts = [];
subscribeErrorToasts(
  (notice) => {
    globalThis.stackiCapturedToasts = [notice, ...globalThis.stackiCapturedToasts].slice(0, 5);
  },
  (id) => {
    globalThis.stackiCapturedToasts = globalThis.stackiCapturedToasts.filter((item) => item.id !== id);
  },
);
