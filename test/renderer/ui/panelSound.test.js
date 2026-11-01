// Which panels answer with a sound.
//
//   node test/renderer/ui/panelSound.test.js
//
// The style panel taps when a button is pressed and sounds a menu's highlight
// as it moves (test/renderer/ui/sound.test.js covers the notes themselves). The settings panel
// does the same now — the same two sounds, from the same functions.
//
// What it is NOT is every dropdown in the app. The title bar's route picker,
// the pages list and the terminal's shell menu are how the app is driven, not
// how a design is shaped, and a note there would be the app talking about
// itself. So the panels say where sound belongs and the controls read it: a
// React context, because a menu portals to <body> and the DOM then puts it
// nowhere near the panel it was opened from.

const fs = require('fs');
const path = require('path');
const { repoPath, sourceSpecifier } = require('../../helpers/sources.js');
const { readAppSource } = require('../../helpers/sourceText.js');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) {
    failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  }
};

// Counts what actually started, the way test/renderer/ui/sound.test.js does: a node built and
// never played is not a sound.
function fakeAudio() {
  const played = [];
  const param = () => ({
    value: 0,
    setValueAtTime(value) {
      this.value = value;
    },
    linearRampToValueAtTime(value) {
      this.value = value;
    },
    exponentialRampToValueAtTime(value) {
      this.value = value;
    },
  });
  const node = () => ({
    connect() {},
    disconnect() {},
    frequency: param(),
    gain: param(),
    Q: param(),
    type: '',
  });
  class FakeAudioContext {
    constructor() {
      this.currentTime = 0;
      this.destination = {};
      this.state = 'running';
    }
    createOscillator() {
      const osc = node();
      osc.stop = () => {};
      // Recorded when the note actually starts: a node built and never played
      // is not a sound.
      osc.start = () => played.push(osc.frequency.value);
      return osc;
    }
    createGain() {
      return node();
    }
    createBiquadFilter() {
      return node();
    }
    resume() {}
  }
  return { AudioContext: FakeAudioContext, played };
}

(async () => {
  const esbuild = require('esbuild');
  const buildDirectory = repoPath('node_modules/.stacki-test');
  fs.mkdirSync(buildDirectory, { recursive: true });
  const entry = path.join(buildDirectory, 'panel-sound.entry.jsx');
  // One bundle, so the dropdown and the switch that turns sound on are looking
  // at the same module.
  fs.writeFileSync(
    entry,
    `export { default as Dropdown } from ${sourceSpecifier('src/ui/Dropdown.tsx')};\n` +
      `export { SoundHere } from ${sourceSpecifier('src/ui/soundScope.tsx')};\n` +
      `export { setSoundEnabled } from ${sourceSpecifier('src/ui/sound.ts')};\n`,
  );
  const bundle = path.join(buildDirectory, 'panel-sound.bundle.js');
  await esbuild.build({
    entryPoints: [entry],
    outfile: bundle,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client'],
    loader: { '.css': 'empty' },
    logLevel: 'silent',
  });

  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
  const audio = fakeAudio();
  global.window = dom.window;
  dom.window.AudioContext = audio.AudioContext;
  global.document = dom.window.document;
  global.navigator = dom.window.navigator;
  global.MutationObserver = dom.window.MutationObserver;
  global.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  global.Element = dom.window.Element;
  global.HTMLElement = dom.window.HTMLElement;
  global.Node = dom.window.Node;
  global.KeyboardEvent = dom.window.KeyboardEvent;
  global.MouseEvent = dom.window.MouseEvent;
  global.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
  global.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
  global.IS_REACT_ACT_ENVIRONMENT = true;
  dom.window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  global.ResizeObserver = dom.window.ResizeObserver;
  // `jsdom` has no scrolling, and the menu keeps its highlight in view.
  dom.window.Element.prototype.scrollIntoView = function () {};

  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { act } = React;
  const { Dropdown, SoundHere, setSoundEnabled } = require(bundle);

  const OPTIONS = [
    { value: 'a', label: 'One' },
    { value: 'b', label: 'Two' },
    { value: 'c', label: 'Three' },
  ];

  const mount = async (inScope) => {
    const host = document.createElement('div');
    document.getElementById('root').appendChild(host);
    const root = createRoot(host);
    const field = React.createElement(Dropdown, {
      value: 'a',
      options: OPTIONS,
      onChange: () => {},
    });
    await act(async () => {
      root.render(inScope ? React.createElement(SoundHere, undefined, field) : field);
    });
    const trigger = () => host.querySelector('.dd-trigger');
    const rows = () => [...document.querySelectorAll('.dd-option')];
    return {
      host,
      rows,
      open: async () => {
        await act(async () => {
          trigger().dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true }));
          trigger().dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
        });
      },
      // The highlight moves the same way for the keyboard and the pointer, so
      // either drives this. The wait is the notes' own floor (sound.js): a
      // slide down a menu is one gesture, not thirty notes, so two moves in the
      // same instant are one sound — which is right, and would make a count
      // here mean nothing.
      down: async () => {
        await new Promise((resolve) => setTimeout(resolve, 40));
        await act(async () => {
          trigger().dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
        });
      },
      hover: async (i) => {
        await act(async () => {
          rows()[i]?.dispatchEvent(new dom.window.MouseEvent('mousemove', { bubbles: true }));
          rows()[i]?.dispatchEvent(new dom.window.MouseEvent('mouseenter', { bubbles: true }));
        });
      },
      done: async () => {
        await act(async () => root.unmount());
      },
    };
  };

  // --- off until it is asked for -------------------------------------------------
  {
    setSoundEnabled(false);
    audio.played.length = 0;
    const mounted = await mount(true);
    await mounted.open();
    await mounted.down();
    check('a menu in a panel is silent while the setting is off', audio.played.length === 0, String(audio.played.length));
    await mounted.done();
  }

  setSoundEnabled(true);

  // --- inside a panel --------------------------------------------------------------
  {
    audio.played.length = 0;
    const mounted = await mount(true);
    await mounted.open();
    check('the menu opened', mounted.rows().length === 3, String(mounted.rows().length));
    check('opening it says nothing', audio.played.length === 0, JSON.stringify(audio.played));
    await mounted.down();
    check('moving the highlight sounds a note', audio.played.length === 1, JSON.stringify(audio.played));
    await mounted.down();
    check('and the next row another', audio.played.length === 2, JSON.stringify(audio.played));
    check('deeper down the list, deeper the note', audio.played[1] < audio.played[0], JSON.stringify(audio.played));
    await mounted.done();
  }

  // --- and outside one ---------------------------------------------------------------
  {
    audio.played.length = 0;
    const mounted = await mount(false);
    await mounted.open();
    await mounted.down();
    await mounted.down();
    check('a dropdown outside the panels stays quiet', audio.played.length === 0, JSON.stringify(audio.played));
    await mounted.done();
  }

  // --- the two panels, and only those -------------------------------------------------
  const read = (file) => fs.readFileSync(repoPath(file), 'utf8');
  const props = read('src/features/props/PropsPanel.tsx');
  const style = read('src/features/style/StylePanel.tsx');
  check('the settings panel taps on a button press', /closest\('button'\)/.test(props) && /clickNote\(\)/.test(props));
  check('but not on a disabled one', /!button\.disabled/.test(props));
  check('and it is a sound scope', /<SoundHere>/.test(props), 'its dropdowns would be silent');
  check('so is the style panel', /<SoundHere>/.test(style));
  const others = {
    // The app shell and every module it was split into, read as one.
    'src/app': readAppSource(),
    ...Object.fromEntries(
      ['src/features/pages/PagesPanel.tsx', 'src/features/terminal/TerminalDock.tsx', 'src/features/welcome/WelcomeScreen.tsx'].map((file) => [
        file,
        read(file),
      ]),
    ),
  };
  const scopes = Object.keys(others).filter((file) => /<SoundHere>/.test(others[file]));
  check('and nothing else is', scopes.length === 0, scopes.join(', '));

  if (failures.length) {
    console.error(`\npanel-sound: ${failures.length} failed, ${checked - failures.length} passed\n`);
    console.error(failures.join('\n') + '\n');
    process.exit(1);
  }
  console.log(`panel-sound: ${checked} passed  [which panels answer with a sound]`);
  process.exit(0);
})();
