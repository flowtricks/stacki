// Goal: voice input in a comment pin's box works as the chat's does. The same recording line shows while it listens,
// spoken words land at the caret (not at the end of the comment), and closing the box ends the microphone, also while
// the session is still starting (the system has not answered yet), which used to open a recognizer nothing would close.
// Both ways of hearing are driven: the platform's recognizer, and Stacki's Whisper engine as Desktop uses it.
// Method: the real PinOverlay, popover and stores in jsdom. Every source of sound is a fake: a recognizer the test
// speaks into, or the real Whisper session over a fake engine host and a fake microphone fed a tone. No microphone is
// opened, no model is loaded, nothing leaves the process.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources.js');
const { waitFor } = require('../../helpers/waitFor.js');

const output = repoPath('node_modules/.stacki-test/pinVoice.cjs');
fs.mkdirSync(path.dirname(output), { recursive: true });
esbuild.buildSync({
  stdin: {
    contents: [
      "export { PinOverlay } from './src/features/ai/pins/PinOverlay';",
      "export * as pins from './src/features/ai/pins/pinStore';",
      "export { resetAiStore } from './src/features/ai/aiStore';",
      "export { VoiceEnvironmentContext } from './src/features/ai/voice/voiceEnvironment';",
      "export { createDictationStore } from './src/features/ai/voice/dictationStore';",
      "export { createWhisperRecognition } from './src/features/ai/voice/whisperEngine';",
      "export { EditorView } from '@codemirror/view';",
    ].join('\n'),
    resolveDir: repoPath('.'),
    loader: 'tsx',
  },
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  jsx: 'automatic',
  loader: { '.css': 'empty', '.svg': 'empty' },
  external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
  logLevel: 'silent',
});

const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
require('../../helpers/popupDom').installPopupDOM(dom.window);
global.window = dom.window;
for (const name of [
  'document',
  'navigator',
  'HTMLElement',
  'HTMLIFrameElement',
  'Element',
  'Node',
  'Event',
  'KeyboardEvent',
  'MouseEvent',
  'getComputedStyle',
  'localStorage',
  'MutationObserver',
  'getSelection',
  'Range',
  'Selection',
  'DOMRect',
  'Window',
]) {
  Object.defineProperty(global, name, { value: dom.window[name], configurable: true, writable: true });
}
global.IS_REACT_ACT_ENVIRONMENT = true;
dom.window.requestAnimationFrame = (callback) => setTimeout(() => callback(Date.now()), 0);
global.requestAnimationFrame = dom.window.requestAnimationFrame;
global.cancelAnimationFrame = (handle) => clearTimeout(handle);
global.ResizeObserver = class {
  observe() {}
  disconnect() {}
};
dom.window.focus = () => undefined;
dom.window.Element.prototype.scrollIntoView = () => undefined;
dom.window.Range.prototype.getClientRects = () => [];
dom.window.Range.prototype.getBoundingClientRect = () => ({ left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 });

const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const ui = require(output);

const GRANTED = { status: 'granted', appName: 'Stacki', settingsAvailable: true };
let microphoneAnswer = async () => GRANTED;
dom.window.avb = {
  platform: 'darwin',
  aiPinsRead: async () => ({ ok: true, value: { board: { version: 1, pins: [] }, images: [] } }),
  aiPinsWrite: async () => ({ ok: true, value: { saved: true } }),
  aiAgents: async () => ({ trusted: true, agents: [], options: [] }),
  aiMentions: async () => ({ ok: true, value: { candidates: [] } }),
  microphoneRequest: () => microphoneAnswer(),
  microphoneStatus: async () => GRANTED,
};

const settle = async () => {
  for (let round = 0; round < 6; round += 1) {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  }
};
const until = async (what, read) => {
  await waitFor({
    what,
    read: async () => {
      await act(async () => undefined);
      return read();
    },
    until: Boolean,
  });
  await settle();
};

function fakeRecognizers() {
  const made = [];
  const meters = [];
  const environment = {
    isSupported: () => true,
    detectEngine: async () => ({ kind: 'online' }),
    nowMs: () => 1000,
    audioLevels: {
      start: async () => {
        const meter = { stopped: false };
        meters.push(meter);
        return { ok: true, value: () => (meter.stopped = true) };
      },
    },
    createRecognition: () => {
      const recognizer = {
        started: 0,
        aborted: 0,
        onresult: () => undefined,
        onerror: () => undefined,
        onend: () => undefined,
        start() {
          this.started += 1;
        },
        stop() {},
        abort() {
          this.aborted += 1;
        },
      };
      made.push(recognizer);
      return recognizer;
    },
  };
  return { environment, made, meters };
}

async function mount(context, environment) {
  microphoneAnswer = async () => GRANTED;
  ui.pins.resetPinStore();
  ui.resetAiStore();
  await ui.pins.loadPins('/site');
  ui.pins.setCommentMode('on');
  const id = ui.pins.dropPin(
    {
      anchor: { path: '0.1', occurrence: 0, at: { x: 0.5, y: 0.5 }, tag: 'h1', text: 'Welcome' },
      place: {
        page: 'src/pages/index.astro',
        pageLabel: 'Home',
        scope: undefined,
        file: 'src/pages/index.astro',
        locator: '0.1',
        elementLabel: 'Heading',
        componentFile: undefined,
        breakpointPx: 768,
      },
    },
    (key) => key,
  );
  const pin = ui.pins.pinState().board.pins[0];
  const root = createRoot(document.getElementById('root'));
  await act(async () =>
    root.render(
      React.createElement(
        ui.VoiceEnvironmentContext.Provider,
        { value: environment },
        React.createElement(ui.PinOverlay, {
          rects: { 0.1: [{ x: 10, y: 10, w: 100, h: 20 }] },
          scale: 1,
          placed: [{ pin, path: '0.1' }],
          detached: new Set(),
          progressOf: () => ({ kind: 'draft' }),
          recapture: () => undefined,
        }),
      ),
    ),
  );
  await settle();
  context.after(async () => {
    await act(async () => root.unmount());
  });
  return id;
}

const microphone = () => document.querySelector('.ai-pin-popover .ai-tool-button[aria-pressed]');
const pointer = async (type) => {
  await act(async () => void microphone().dispatchEvent(new window.MouseEvent(type, { bubbles: true, cancelable: true })));
  await settle();
};
const tap = async () => {
  await pointer('pointerdown');
  await pointer('pointerup');
};
const editor = () => ui.EditorView.findFromDOM(document.querySelector('.ai-pin-popover .cm-editor'));
const words = () => ui.pins.pinState().board.pins[0]?.edit?.comment;
const recordingLine = () => document.querySelector('.ai-pin-popover .ai-voice-line') !== null;
const type = async (text) => {
  await act(async () => editor().dispatch({ changes: { from: 0, to: editor().state.doc.length, insert: text }, selection: { anchor: text.length } }));
  await settle();
};
const caretAt = async (offset) => {
  await act(async () => editor().dispatch({ selection: { anchor: offset } }));
};

test('dictation shows the recording line and lands at the caret; closing the box ends the session', async (context) => {
  const voice = fakeRecognizers();
  await mount(context, voice.environment);
  await type('Make bigger');
  await caretAt('Make'.length);
  assert.equal(recordingLine(), false);
  await tap();
  assert.equal(recordingLine(), true, 'the recording line, as in the chat');
  const recognizer = voice.made.at(-1);
  const say = async (transcript, isFinal) => {
    await act(async () => recognizer.onresult({ resultIndex: 0, results: [{ isFinal, 0: { transcript } }] }));
    await settle();
  };
  await say('the heading', false);
  const draft = document.querySelector('.ai-pin-popover .ai-dictation-draft');
  assert.equal(draft?.textContent.trim(), 'the heading', 'the phrase being spoken shows');
  assert.equal(editor().state.doc.toString(), 'Make bigger', 'and is not text yet');
  await say('the heading', true);
  assert.equal(words(), 'Make the heading bigger');
  await say('much', true);
  assert.equal(words(), 'Make the heading much bigger', 'the caret follows what was said');
  await say('scratch that', true);
  assert.equal(words(), 'Make the heading bigger', 'taking back takes the last piece at the caret');
  await act(async () => ui.pins.closePinBox('keep'));
  await until('the box left', () => microphone() === null);
  assert.equal(recognizer.aborted, 1, 'the recognizer is closed with the box');
  assert.ok(
    voice.meters.every((meter) => meter.stopped),
    'and so is the meter',
  );
});

for (const [name, typed] of [
  ['an empty box, which leaves with an exit motion', ''],
  ['a box with words, which goes at once', 'Bigger'],
]) {
  test(`closed while the system is still answering for the microphone, nothing opens: ${name}`, async (context) => {
    const voice = fakeRecognizers();
    await mount(context, voice.environment);
    if (typed !== '') {
      await type(typed);
    }
    let answer;
    microphoneAnswer = () => new Promise((resolve) => (answer = resolve));
    await tap();
    await until('the system was asked', () => answer !== undefined);
    await act(async () => ui.pins.closePinBox('keep'));
    await until('the box left', () => microphone() === null);
    await act(async () => answer(GRANTED));
    await settle();
    assert.equal(voice.made.filter((recognizer) => recognizer.started > 0).length, 0, 'no recognizer starts for a box that is gone');
    assert.ok(voice.meters.every((meter) => meter.stopped));
  });
}

// Stacki's Whisper engine as Desktop runs it, over a fake model host and a fake microphone.
function fakeWhisper() {
  const base = fakeRecognizers();
  const open = new Set();
  const store = ui.createDictationStore({
    status: async () => ({ directory: '/models', models: ['turbo', 'small', 'base'].map((id) => ({ id, install: { kind: 'installed', sizeBytes: 10 } })) }),
    download: async () => ({ kind: 'installed', sizeBytes: 10 }),
    cancel: async () => undefined,
    remove: async () => undefined,
    onProgress: () => () => undefined,
  });
  const listen = async (listener) => {
    open.add(listener);
    return { ok: true, value: () => open.delete(listener) };
  };
  const host = {
    isWarm: () => true,
    load: async () => ({ ok: true, value: undefined }),
    transcribe: async () => ({ ok: true, value: { text: 'make it blue', language: 'en', decodeMs: 50 } }),
    release: () => undefined,
  };
  const whisper = {
    store,
    createRecognition: () => ui.createWhisperRecognition({ host, store, listen, nowMs: () => Date.now() }),
    audioLevels: { start: async () => ({ ok: true, value: () => undefined }) },
  };
  return {
    environment: { ...base.environment, detectEngine: async () => ({ kind: 'whisper' }), whisper },
    open,
    store,
    // A second of a 220 Hz tone, then silence, in the capture worklet's 100 ms chunks.
    speak: async () => {
      for (let at = 0; at < 32_000; at += 1_600) {
        const chunk = Float32Array.from({ length: 1_600 }, (_, index) =>
          at + index < 16_000 ? 0.2 * Math.sin((2 * Math.PI * 220 * (at + index)) / 16_000) : 0,
        );
        for (const listener of open) {
          listener(chunk, 0.1);
        }
      }
    },
  };
}

test('on-device dictation: the words reach the pin at the caret, and closing the box closes the microphone', async (context) => {
  const whisper = fakeWhisper();
  await mount(context, whisper.environment);
  await type('Please now');
  await caretAt('Please'.length);
  await until('the model is known to be installed', () => whisper.store.snapshot().engine.kind === 'ready');
  await tap();
  await until('the fake microphone is open', () => whisper.open.size > 0);
  assert.equal(recordingLine(), true);
  await act(() => whisper.speak());
  await until('the phrase landed at the caret', () => words()?.toLowerCase().startsWith('please make it blue'));
  assert.match(words(), /now$/);
  await act(async () => ui.pins.closePinBox('keep'));
  await until('the box left', () => microphone() === null);
  assert.equal(whisper.open.size, 0, 'the microphone is closed');
  assert.equal(whisper.store.snapshot().engine.kind, 'ready', 'the engine is free for the next box');
});
