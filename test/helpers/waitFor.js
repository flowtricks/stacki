// Bounded waits on observable state, for tests that drive a real or simulated UI.
//
// Why: a fixed sleep after an action guesses how long a slow, hidden-window CI
// runner takes to paint, tokenize, animate or deliver input, and every guess is
// wrong on some runner. These helpers poll the state the test is about instead,
// at a fixed interval and for a stated number of polls, so a fast machine moves
// on at once, a slow one gets the time it needs, and a real failure still ends
// with a message naming what was awaited and the last state observed.
//
// `read` may be synchronous (a jsdom query) or asynchronous (an Electron
// `executeJavaScript` round trip); `until` decides whether the observed value is
// the awaited state. Neither runs more than `pollCountMax` times.

const WAIT_LIMITS = Object.freeze({
  // 50 ms keeps the wait responsive without spinning a contended CPU.
  pollIntervalMs: 50,
  // 200 polls of 50 ms is ten seconds: an order of magnitude past the slowest
  // runner seen for any single UI transition, well inside every test's timeout.
  pollCountMax: 200,
  // Six equal polls (~300 ms) of nothing changing: longer than any one follow-up task the
  // panels queue after a commit, shorter than the fixed 900 ms pauses this replaces.
  steadyPollCount: 6,
});

// A page expression for Electron probes (`executeJavaScript(MOTION_SETTLED_EXPRESSION)`): true
// once no popup is in its opening phase and no finite CSS animation or transition is still
// running. Popups scale open (popup.css), so a size read mid-motion is a few percent short on
// a slow runner. Infinite animations (spinners, skeletons) are ignored, or it would never hold.
const MOTION_SETTLED_EXPRESSION = `(document.querySelector('[data-popup-phase="opening"]') === null &&
  document.getAnimations().every((animation) => animation.playState !== 'running' || animation.effect === null || animation.effect.getTiming().iterations === Infinity))`;

const pause = (durationMs) => new Promise((resolve) => setTimeout(resolve, durationMs));

const describeObserved = (value) => {
  try {
    const text = JSON.stringify(value);
    return text === undefined ? String(value) : text.slice(0, 2000);
  } catch (error) {
    return `<unserializable: ${String(error)}>`;
  }
};

const assertWaitOptions = (options) => {
  if (typeof options !== 'object' || options === null) {
    throw new Error('Assertion failed: waitFor takes an options object');
  }
  if (typeof options.what !== 'string' || options.what.length === 0) {
    throw new Error('Assertion failed: waitFor needs `what`, the state it waits for, for its failure message');
  }
  if (typeof options.read !== 'function') {
    throw new Error(`Assertion failed: waitFor(${options.what}) needs a \`read\` function`);
  }
  if (typeof options.until !== 'function') {
    throw new Error(`Assertion failed: waitFor(${options.what}) needs an \`until\` predicate`);
  }
  const pollCountMax = options.pollCountMax ?? WAIT_LIMITS.pollCountMax;
  if (!Number.isSafeInteger(pollCountMax) || pollCountMax < 1) {
    throw new Error(`Assertion failed: waitFor(${options.what}) pollCountMax must be a positive integer`);
  }
  const pollIntervalMs = options.pollIntervalMs ?? WAIT_LIMITS.pollIntervalMs;
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1) {
    throw new Error(`Assertion failed: waitFor(${options.what}) pollIntervalMs must be a positive integer`);
  }
  return { pollCountMax, pollIntervalMs };
};

/**
 * Polls `read` until `until(value)` holds, at most `pollCountMax` times.
 * Returns `{ kind: 'reached', value, pollCount }` or `{ kind: 'timedOut', value, pollCount }`,
 * the value being the last one observed either way, so a caller that collects
 * failures can report it instead of stopping at the first.
 */
async function pollUntil(options) {
  const { pollCountMax, pollIntervalMs } = assertWaitOptions(options);
  let value = await options.read();
  let pollCount = 1;
  while (pollCount < pollCountMax) {
    if (options.until(value)) {
      return { kind: 'reached', value, pollCount };
    }
    await pause(pollIntervalMs);
    value = await options.read();
    pollCount += 1;
  }
  if (options.until(value)) {
    return { kind: 'reached', value, pollCount };
  }
  return { kind: 'timedOut', value, pollCount };
}

/**
 * Polls like `pollUntil` and returns the value once `until` holds; otherwise
 * throws, naming `what` was awaited, the bound, and the last observed value.
 */
async function waitFor(options) {
  const outcome = await pollUntil(options);
  switch (outcome.kind) {
    case 'reached':
      return outcome.value;
    case 'timedOut': {
      const { pollIntervalMs } = assertWaitOptions(options);
      const waitedMs = outcome.pollCount * pollIntervalMs;
      throw new Error(
        `waitFor: ${options.what} did not hold after ${outcome.pollCount} polls (~${waitedMs} ms); last observed: ${describeObserved(outcome.value)}`,
      );
    }
    default:
      throw new Error(`Assertion failed: unknown poll outcome ${describeObserved(outcome)}`);
  }
}

/**
 * Waits for a state to hold AND stay put: polls `read` until `until(value)` holds on
 * `steadyPollCount` consecutive polls with the same serialized value, then returns that value.
 * For "the panel went quiet" after an action whose follow-up writes arrive in later tasks (a
 * queued save, a rescan): a fixed pause guesses how long they take; this waits until they have
 * stopped changing anything the test can see, and throws at the bound, naming `what`, if they
 * never do. A late change resets the count, so a value that lands and is then overwritten is
 * never mistaken for the final one.
 */
async function waitForSteady(options) {
  const steadyPollCount = options.steadyPollCount ?? WAIT_LIMITS.steadyPollCount;
  if (!Number.isSafeInteger(steadyPollCount) || steadyPollCount < 2) {
    throw new Error(`Assertion failed: waitForSteady(${options.what}) steadyPollCount must be an integer of at least 2`);
  }
  let previous;
  let steady = 0;
  const outcome = await pollUntil({
    ...options,
    until: (value) => {
      const text = describeObserved(value);
      if (options.until(value) && text === previous) {
        steady += 1;
      } else {
        steady = options.until(value) ? 1 : 0;
      }
      previous = text;
      return steady >= steadyPollCount;
    },
  });
  if (outcome.kind === 'reached') {
    return outcome.value;
  }
  const { pollIntervalMs } = assertWaitOptions(options);
  throw new Error(
    `waitForSteady: ${options.what} did not hold steady for ${steadyPollCount} polls within ${outcome.pollCount} polls (~${outcome.pollCount * pollIntervalMs} ms); last observed: ${describeObserved(outcome.value)}`,
  );
}

module.exports = { MOTION_SETTLED_EXPRESSION, WAIT_LIMITS, describeObserved, pollUntil, waitFor, waitForSteady };
