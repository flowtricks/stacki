// Goal: with change tracking off, the transcript degrades honestly. Where a Changes card would have
// been there is one quiet, translated line, "Snapshots are off", with a "Turn on" button that
// turns the setting on at once and applies to the next turn; a turn whose snapshot failed says so
// without offering a switch; a turn with no file edits shows nothing; nothing throws.
// Method: reduce real chat events into the real view, mount the real note in jsdom against a fake
// preload that records every setPreference call, click as a person would.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadTranscript } = require('../../helpers/aiTranscriptDom.js');

const {
  modules: view,
  React,
  act,
  createRoot,
} = loadTranscript('aiUntrackedChanges', [
  "export { UntrackedChangesNote } from './src/features/ai/transcript/UntrackedChangesNote';",
  "export { applyEvent, EMPTY_CHAT } from './src/features/ai/chatReducer';",
]);

const TURN = `t${'1'.repeat(16)}`;

function fakePreferences(reply) {
  const calls = [];
  window.avb = {
    setPreference: async (payload) => {
      calls.push(payload);
      return reply(payload);
    },
  };
  return calls;
}

async function mount(reason) {
  const container = document.body.appendChild(document.createElement('div'));
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(view.UntrackedChangesNote, { reason }));
  });
  return { container, root };
}

const saved = (enabled) => ({ sound: false, usageCountsEnabled: true, appsPersonHidden: false, aiAskBeforeTrust: false, aiTrackChanges: enabled, saved: true });

test('off: one quiet line, and Turn on flips the setting at once', async (context) => {
  const calls = fakePreferences(() => saved(true));
  const { container, root } = await mount('off');
  context.after(() => act(() => root.unmount()));
  assert.match(container.textContent, /Snapshots are off/);
  const turnOn = [...container.querySelectorAll('button')].find((button) => button.textContent.trim() === 'Turn on');
  assert.ok(turnOn, 'a Turn on button');
  await act(async () => {
    turnOn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  });
  assert.deepEqual(calls, [{ setting: 'aiTrackChanges', enabled: true }]);
  assert.match(container.textContent, /on for new turns/);
  assert.equal([...container.querySelectorAll('button')].length, 0, 'the switch is gone once flipped');
});

test('a failed save says so and keeps the button', async (context) => {
  fakePreferences(() => ({ ...saved(false), saved: false }));
  const { container, root } = await mount('off');
  context.after(() => act(() => root.unmount()));
  const turnOn = container.querySelector('button');
  await act(async () => {
    turnOn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.match(container.textContent, /Could not save the setting/);
  assert.ok(container.querySelector('button'), 'the person can try again');
});

test('a bridge that throws does not crash the note', async (context) => {
  window.avb = {
    setPreference: async () => {
      throw new Error('gone');
    },
  };
  const { container, root } = await mount('off');
  context.after(() => act(() => root.unmount()));
  await act(async () => {
    container.querySelector('button').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.match(container.textContent, /Could not save the setting/);
});

test('unavailable: the line names the failure and offers no switch', async (context) => {
  fakePreferences(() => saved(true));
  const { container, root } = await mount('unavailable');
  context.after(() => act(() => root.unmount()));
  assert.match(container.textContent, /could not be captured/);
  assert.equal(container.querySelectorAll('button').length, 0);
});

test('the reducer turns the event into one transcript item, and a turn without it has none', () => {
  let state = view.EMPTY_CHAT;
  state = view.applyEvent(state, { kind: 'changes-untracked', turn: TURN, reason: 'off' });
  const items = state.items.filter((item) => item.kind === 'changes-untracked');
  assert.equal(items.length, 1);
  assert.equal(items[0].reason, 'off');
  assert.equal(view.EMPTY_CHAT.items.length, 0);
});
