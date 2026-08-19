// Interface sound: the note a colour drag plays.
//
//   node test/sound.js
//
// Two things matter more than the tone. First, silence by default — an editor
// that makes a noise the first time somebody touches it is an editor they turn
// off, so nothing sounds, and no AudioContext is even built, until the setting
// says otherwise. Second, that a note is one STEP of the scale rather than one
// pointer move: a move fires far faster than a note is worth playing, and a
// note per move is a machine gun.
//
// The audio graph is checked against a stand-in for Web Audio, which records
// what was built and connected — jsdom has no AudioContext, and neither does a
// CI box with no sound card.

const fs = require('fs');
const path = require('path');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
};

// Enough of Web Audio to build one note and see where it went.
function fakeAudio() {
  const played = [];
  const tones = [];
  let lastFilter = null;
  let lastGain = null;
  const nodes = { oscillators: 0, gains: 0, filters: 0 };
  const node = (kind) => ({
    kind,
    connect() {},
    disconnect() {},
    frequency: { value: 0, setValueAtTime(v) { this.value = v } },
    Q: { value: 0, setValueAtTime(v) { this.value = v } },
    gain: {
      value: 0,
      // The peak of the envelope is the note's loudness — the ramp it is
      // ramped to, not the value it starts at.
      setValueAtTime() {},
      linearRampToValueAtTime(v) { this.value = v },
      exponentialRampToValueAtTime() {},
    },
    type: '',
    start() {},
    stop() {},
  });
  class Ctx {
    constructor() {
      this.state = 'running';
      this.currentTime = 0;
      this.destination = node('destination');
    }
    createOscillator() {
      nodes.oscillators += 1;
      const osc = node('oscillator');
      // Recorded when the note is actually started, so a node that is built and
      // never played doesn't count as a sound. The filter and envelope built
      // just before it are this note's, so the whole sound is captured.
      osc.start = () => {
        played.push(osc.frequency.value);
        tones.push({ cutoff: lastFilter?.frequency.value, gain: lastGain?.gain.value, wave: osc.type });
      };
      return osc;
    }
    createGain() {
      nodes.gains += 1;
      lastGain = node('gain');
      return lastGain;
    }
    createBiquadFilter() {
      nodes.filters += 1;
      lastFilter = node('filter');
      return lastFilter;
    }
    resume() {}
  }
  return { Ctx, played, tones, nodes };
}

(async () => {
  const esbuild = require('esbuild');
  const buildDir = path.join(__dirname, '..', 'node_modules', '.stacki-test');
  fs.mkdirSync(buildDir, { recursive: true });
  const out = path.join(buildDir, 'sound.bundle.mjs');
  await esbuild.build({
    entryPoints: [path.join(__dirname, '..', 'src', 'ui', 'sound.js')],
    outfile: out,
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent',
  });

  const audio = fakeAudio();
  global.window = { AudioContext: audio.Ctx };
  const { clickNote, dragNote, endDragNotes, hoverNote, noteHzFor, noteToneFor, rowHzFor, setSoundEnabled, soundEnabled } =
    await import(
    `file://${out}?v=${Date.now()}`
  );

  // --- off until asked for ----------------------------------------------------
  check('silent by default', soundEnabled() === false);
  for (const f of [0, 0.2, 0.4, 0.6, 0.8, 1]) dragNote(f);
  check('a drag makes no sound while it is off', audio.played.length === 0, String(audio.played.length));
  check(
    'and builds no audio at all — no context, no nodes',
    audio.nodes.oscillators === 0 && audio.nodes.filters === 0,
    JSON.stringify(audio.nodes)
  );

  // --- the pitch ---------------------------------------------------------------
  const across = [0, 0.25, 0.5, 0.75, 1].map(noteHzFor);
  check(
    'dragging right raises the pitch',
    across.every((hz, i) => i === 0 || hz > across[i - 1]),
    JSON.stringify(across)
  );
  check('and dragging left lowers it', noteHzFor(0.2) < noteHzFor(0.8));
  check('the left end is the root', Math.round(noteHzFor(0)) === 196, String(noteHzFor(0)));
  check('the right end is two octaves up', Math.round(noteHzFor(1)) === 784, String(noteHzFor(1)));
  check('outside the track is clamped, not extrapolated', noteHzFor(-3) === noteHzFor(0) && noteHzFor(9) === noteHzFor(1));
  // Every note in a minor pentatonic, so a fast drag reads as a run rather than
  // a siren: no two adjacent steps are a semitone apart.
  const steps = Array.from({ length: 11 }, (_, i) => noteHzFor(i / 10));
  const ratios = steps.slice(1).map((hz, i) => hz / steps[i]);
  check(
    'no two steps are a semitone apart',
    ratios.every((r) => r > 1.09),
    JSON.stringify(ratios.map((r) => r.toFixed(3)))
  );

  // --- on ----------------------------------------------------------------------
  setSoundEnabled(true);
  check('the setting turns it on', soundEnabled() === true);

  dragNote(0);
  check('the first move sounds', audio.played.length === 1, JSON.stringify(audio.played));
  check('at the pitch for where it is', audio.played[0] === noteHzFor(0), JSON.stringify(audio.played));

  // A pointer emits many moves within one step of the scale; they are one note.
  // Spaced past the floor on purpose: if the moves came faster than FLOOR_MS
  // the floor alone would silence them, and this would pass whether or not the
  // step is what decides.
  const before = audio.played.length;
  for (let i = 0; i < 5; i += 1) {
    await new Promise((r) => setTimeout(r, 40));
    dragNote(0.01 * i);
  }
  check(
    'moving within a step does not sound again',
    audio.played.length === before,
    `${audio.played.length - before} extra notes`
  );

  // Crossing steps sounds each one, and coming back down sounds lower.
  await new Promise((r) => setTimeout(r, 40));
  dragNote(1);
  await new Promise((r) => setTimeout(r, 40));
  dragNote(0.5);
  check('crossing a step sounds it', audio.played.length === before + 2, JSON.stringify(audio.played));
  check(
    'and coming back down is lower than what it left',
    audio.played[audio.played.length - 1] < audio.played[audio.played.length - 2],
    JSON.stringify(audio.played.slice(-2))
  );

  // --- up and down --------------------------------------------------------------
  //
  // Down is muted: the filter nearly shut, a slower attack, a quieter note. Up
  // is struck: open, fast, loud. What is heard is the filter, so that is what is
  // asserted — one waveform throughout, since a sawtooth can be either and the
  // filter decides how much of it comes through.
  const low = noteToneFor(1);
  const high = noteToneFor(0);
  check('the bottom is muted and the top is not', low.cutoff < high.cutoff, `${low.cutoff} vs ${high.cutoff}`);
  check('and quieter with it', low.gain < high.gain, `${low.gain} vs ${high.gain}`);
  check('with a softer attack', low.attack > high.attack, `${low.attack} vs ${high.attack}`);
  check('and a longer, rounder tail', low.decay > high.decay, `${low.decay} vs ${high.decay}`);
  check(
    'the middle is between the two',
    noteToneFor(0.5).cutoff > low.cutoff && noteToneFor(0.5).cutoff < high.cutoff
  );
  check(
    'a control with no meaningful height sounds like the middle',
    noteToneFor(undefined).cutoff === noteToneFor(0.5).cutoff
  );

  // Moving straight up, across no steps at all, is still a change worth hearing.
  endDragNotes();
  await new Promise((r) => setTimeout(r, 40));
  dragNote(0.5, 1);
  await new Promise((r) => setTimeout(r, 40));
  dragNote(0.5, 0);
  const [muted, struck] = audio.tones.slice(-2);
  check('moving up without moving across still sounds', audio.played.slice(-2)[0] === audio.played.slice(-1)[0], JSON.stringify(audio.played.slice(-2)));
  check('and opens the filter as it goes', muted.cutoff < struck.cutoff, `${muted.cutoff} vs ${struck.cutoff}`);
  check('and hits harder', muted.gain < struck.gain, `${muted.gain} vs ${struck.gain}`);
  check('on the one waveform', muted.wave === 'sawtooth' && struck.wave === 'sawtooth', `${muted.wave} / ${struck.wave}`);
  // The top of the scale at the bottom of the square: the muted cutoff sits well
  // below that note's own frequency, so this is the one combination where the
  // floor has to do something. Played on purpose, since a test that never
  // reaches it cannot tell whether the floor is there.
  endDragNotes();
  await new Promise((r) => setTimeout(r, 40));
  dragNote(1, 1);
  const topMuted = audio.tones[audio.tones.length - 1];
  check(
    'the highest note still speaks at the most muted end',
    topMuted.cutoff > noteHzFor(1),
    `${topMuted.cutoff} for a ${noteHzFor(1)}Hz note`
  );

  // A cutoff under the note itself doesn't mute it, it removes it. The size of
  // the margin above it is a tuning choice; that there IS one is not.
  check(
    'the mute never shuts below the note',
    audio.tones.every((t, i) => t.cutoff > audio.played[i]),
    JSON.stringify(audio.tones.map((t, i) => [audio.played[i], t.cutoff]))
  );

  // --- the graph ---------------------------------------------------------------
  check('a filter per note — it is what the vertical moves', audio.nodes.filters === audio.played.length, `${audio.nodes.filters} for ${audio.played.length}`);
  check('a note per oscillator', audio.nodes.oscillators === audio.played.length, `${audio.nodes.oscillators} for ${audio.played.length}`);

  // --- off again ---------------------------------------------------------------
  setSoundEnabled(false);
  const quiet = audio.played.length;
  await new Promise((r) => setTimeout(r, 40));
  dragNote(0.9);
  check('switching it off stops it', audio.played.length === quiet, JSON.stringify(audio.played.slice(quiet)));

  // A drag that ends resets, so the next one sounds wherever it begins — even
  // if that is the step the last one finished on.
  setSoundEnabled(true);
  await new Promise((r) => setTimeout(r, 40));
  dragNote(0.5);
  const atRest = audio.played.length;
  endDragNotes();
  await new Promise((r) => setTimeout(r, 40));
  dragNote(0.5);
  check('a new drag sounds its first step', audio.played.length === atRest + 1);

  // --- a button in the panel ---------------------------------------------------
  //
  // Not a value, so no pitch from anywhere: one short dark tap, the same every
  // time. The whole panel is covered by one handler on its host, which works
  // only because React sends a portal's events up the tree that RENDERED it
  // rather than the one it landed in — the colour picker and the modals live
  // on <body>. That is the load-bearing claim, so it is checked rather than
  // assumed.
  endDragNotes();
  const beforeTap = audio.played.length;
  clickNote();
  check('a button press sounds', audio.played.length === beforeTap + 1);
  const tap = audio.tones[audio.tones.length - 1];
  check('darkly', tap.cutoff < noteToneFor(0.5).cutoff, `${tap.cutoff} vs ${noteToneFor(0.5).cutoff}`);
  check('and at the same pitch every time', audio.played[audio.played.length - 1] < noteHzFor(0), String(audio.played[audio.played.length - 1]));
  clickNote();
  clickNote();
  check(
    'every press, with no step to cross first',
    audio.played.length === beforeTap + 3,
    String(audio.played.length - beforeTap)
  );

  setSoundEnabled(false);
  const quietTaps = audio.played.length;
  clickNote();
  check('and silent when the setting is off', audio.played.length === quietTaps);
  setSoundEnabled(true);

  // React's portal event bubbling, which the one handler depends on.
  {
    const { JSDOM } = require('jsdom');
    const view = new JSDOM('<!doctype html><div id="root"></div><div id="elsewhere"></div>', {
      pretendToBeVisual: true,
    });
    const prior = { window: global.window, document: global.document };
    global.window = view.window;
    global.document = view.window.document;
    global.IS_REACT_ACT_ENVIRONMENT = true;
    const React = require('react');
    const { createRoot } = require('react-dom/client');
    const ReactDOM = require('react-dom');
    const { act } = React;

    let heard = 0;
    const Popover = () =>
      ReactDOM.createPortal(
        React.createElement('button', { id: 'in-portal' }, 'pick'),
        view.window.document.getElementById('elsewhere')
      );
    const Panel = () =>
      React.createElement(
        'div',
        {
          onClick: (e) => {
            if (e.target.closest('button')) heard += 1;
          },
        },
        React.createElement('button', { id: 'in-panel' }, 'grid'),
        React.createElement(Popover)
      );
    const root = createRoot(view.window.document.getElementById('root'));
    await act(async () => {
      root.render(React.createElement(Panel));
    });
    const press = (id) =>
      act(async () => {
        view.window.document
          .getElementById(id)
          .dispatchEvent(new view.window.MouseEvent('click', { bubbles: true }));
      });
    await press('in-panel');
    check('a button in the panel reaches the handler', heard === 1, String(heard));
    await press('in-portal');
    check(
      'and so does one in a popover portaled out of it',
      heard === 2,
      `${heard} — React would have to bubble the portal to its own tree`
    );
    await act(async () => {
      root.unmount();
    });
    global.window = prior.window;
    global.document = prior.document;
  }

  // --- down a list ---------------------------------------------------------------
  //
  // The other way round to a drag: a track runs across, so right is higher; a
  // list runs down, so down is lower. One note per row, since a pointer crosses
  // a row in many moves.
  const menu = 9;
  const down = Array.from({ length: menu }, (_, i) => rowHzFor(i, menu));
  check(
    'each row down the list is deeper than the one above',
    down.every((hz, i) => i === 0 || hz < down[i - 1]),
    JSON.stringify(down.map(Math.round))
  );
  check('the first row is the top of the scale', Math.round(down[0]) === Math.round(noteHzFor(1)), String(down[0]));
  check('and the last is the bottom of it', Math.round(down[menu - 1]) === Math.round(noteHzFor(0)), String(down[menu - 1]));
  check('a list of one sounds its top note', Math.round(rowHzFor(0, 1)) === Math.round(noteHzFor(1)), String(rowHzFor(0, 1)));
  check(
    'a row past the end is the last row, not something off the scale',
    rowHzFor(99, menu) === down[menu - 1] && rowHzFor(-4, menu) === down[0]
  );

  endDragNotes();
  await new Promise((r) => setTimeout(r, 40));
  const beforeRows = audio.played.length;
  hoverNote(2, menu);
  check('moving onto a row sounds it', audio.played.length === beforeRows + 1);
  check('at that row\'s pitch', audio.played[audio.played.length - 1] === rowHzFor(2, menu));
  await new Promise((r) => setTimeout(r, 40));
  hoverNote(2, menu);
  check(
    'and staying on it says nothing more',
    audio.played.length === beforeRows + 1,
    `${audio.played.length - beforeRows} notes for one row`
  );
  await new Promise((r) => setTimeout(r, 40));
  hoverNote(5, menu);
  check(
    'moving further down goes deeper',
    audio.played[audio.played.length - 1] < audio.played[audio.played.length - 2],
    JSON.stringify(audio.played.slice(-2))
  );
  // Lighter than a drag: a sweep down a long menu is a lot of notes.
  const rowTone = audio.tones[audio.tones.length - 1];
  check('a row is played lighter than a drag', rowTone.gain < noteToneFor(0).gain, `${rowTone.gain}`);

  setSoundEnabled(false);
  const quietRows = audio.played.length;
  await new Promise((r) => setTimeout(r, 40));
  hoverNote(0, menu);
  check('and rows are silent when the setting is off', audio.played.length === quietRows);
  setSoundEnabled(true);

  // --- one note per row, in a panel full of dropdowns ---------------------------
  //
  // The bug this is here for: every row sounded TWICE. `endDragNotes` clears the
  // memory of what was last played, and the menus were calling it from an effect
  // that runs whenever a Select renders — including the dozen CLOSED ones in the
  // panel. Hovering a row plays its note and previews the value; the write lands
  // a moment later and re-renders the panel; the closed dropdowns wipe the
  // memory on their way through; and the open one, still on the same row, plays
  // it again. Two notes from a control nobody was touching.
  //
  // It only shows up with all three: a sibling BEFORE the open menu (effects run
  // in tree order), a re-render that arrives after the note floor, and options
  // rebuilt on each render — which is how the panel builds them. So all three
  // are here.
  {
    const entry = path.join(buildDir, 'rows.entry.jsx');
    fs.writeFileSync(
      entry,
      `export { default as Select } from ${JSON.stringify(
        path.join(__dirname, '..', 'src', 'style-panel', 'components', 'Select.tsx')
      )};\n` +
        `export { setSoundEnabled } from ${JSON.stringify(
          path.join(__dirname, '..', 'src', 'ui', 'sound.js')
        )};\n`
    );
    const bundle = path.join(buildDir, 'rows.bundle.js');
    await esbuild.build({
      entryPoints: [entry],
      outfile: bundle,
      bundle: true,
      format: 'cjs',
      platform: 'node',
      jsx: 'automatic',
      external: ['react', 'react-dom', 'react/jsx-runtime'],
      loader: { '.tsx': 'tsx', '.ts': 'ts', '.jsx': 'jsx', '.css': 'empty' },
      logLevel: 'silent',
    });

    const { JSDOM } = require('jsdom');
    const view = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
    const prior = { window: global.window, document: global.document };
    global.window = view.window;
    global.document = view.window.document;
    global.IS_REACT_ACT_ENVIRONMENT = true;
    global.MutationObserver = view.window.MutationObserver;
    global.ResizeObserver = class { observe() {} disconnect() {} };
    global.requestAnimationFrame = view.window.requestAnimationFrame.bind(view.window);
    global.cancelAnimationFrame = view.window.cancelAnimationFrame.bind(view.window);
    // This bundle carries its own copy of the sound module, so it needs its own
    // stand-in to count through.
    const heard = [];
    const stub = () => ({
      connect() {}, disconnect() {},
      frequency: { value: 0, setValueAtTime(v) { this.value = v } },
      Q: { setValueAtTime() {} },
      gain: { setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} },
      type: '', start() {}, stop() {},
    });
    view.window.AudioContext = class {
      constructor() { this.state = 'running'; this.currentTime = 0; this.destination = stub() }
      createOscillator() { const o = stub(); o.start = () => heard.push(Math.round(o.frequency.value)); return o }
      createGain() { return stub() }
      createBiquadFilter() { return stub() }
      resume() {}
    };

    const React = require('react');
    const { createRoot } = require('react-dom/client');
    const { act } = React;
    const rows = require(bundle);
    rows.setSoundEnabled(true);

    const options = ['Auto', 'Anamorphic', 'Univisium', 'Widescreen', 'Landscape', 'Portrait', 'Square', 'Custom', 'Other']
      .map((label, i) => ({ value: String(i), label }));
    const fresh = () => options.map((o) => ({ ...o }));
    const Panel = () => {
      const [tick, setTick] = React.useState(0);
      return React.createElement(
        React.Fragment,
        null,
        // Closed, and rendered first — their effects run before the open one's.
        React.createElement(rows.Select, { value: '0', options: fresh(), onChange() {}, ariaLabel: 'Position' }),
        React.createElement(rows.Select, { value: '0', options: fresh(), onChange() {}, ariaLabel: 'Overflow' }),
        React.createElement(rows.Select, {
          value: '0',
          options: fresh(),
          onChange() {},
          // The live write lands after the note floor and re-renders the panel.
          onPreview() { setTimeout(() => setTick((t) => t + 1), 45) },
          ariaLabel: 'Ratio',
        }),
        React.createElement('span', null, tick)
      );
    };

    const root = createRoot(view.window.document.getElementById('root'));
    await act(async () => { root.render(React.createElement(Panel)) });
    const triggers = view.window.document.querySelectorAll('button, [role="combobox"]');
    await act(async () => {
      triggers[2].dispatchEvent(new view.window.MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {});
    const rowEls = [...view.window.document.querySelectorAll('[role="option"]')];
    check('the menu opens with its rows', rowEls.length === options.length, String(rowEls.length));

    heard.length = 0;
    await act(async () => {
      rowEls[3].dispatchEvent(new view.window.MouseEvent('mouseover', { bubbles: true }));
    });
    await act(async () => { await new Promise((r) => setTimeout(r, 90)) });
    check('a row hovered once sounds once', heard.length === 1, JSON.stringify(heard));
    check('and not again when the panel re-renders under it', !(heard[1] === heard[0]), JSON.stringify(heard));

    await act(async () => { root.unmount() });
    global.window = prior.window;
    global.document = prior.document;
  }

  // --- the wiring --------------------------------------------------------------
  const picker = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'style-panel', 'components', 'ColorPicker.tsx'),
    'utf8'
  );
  check('the colour drag plays the note', /if \(live\) dragNote\(fx, tall \? fy : undefined\)/.test(picker));
  check('and releasing ends the run', /endDragNotes\(\)/.test(picker));
  // The square is a surface to drag around in; the bars are a few pixels high,
  // where a fraction of the height is noise rather than intent.
  check(
    'the square is the one that hears its vertical',
    /const dragSB = useDrag\(.*, true\)/.test(picker) &&
      !/const dragHue = useDrag\(.*, true\)/.test(picker) &&
      !/const dragAlpha = useDrag\(.*, true\)/.test(picker)
  );

  const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');
  check('the setting is a menu item', /label: 'Interface Sounds'/.test(main));
  check('a checkbox, so it reads as a toggle', /type: 'checkbox'/.test(main));
  check('off unless it has been turned on', /SETTINGS_DEFAULTS = \{ sound: false \}/.test(main));
  check('and remembered across launches', /writeSettings\(\)/.test(main) && /settings:get/.test(main));

  const select = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'style-panel', 'components', 'Select.tsx'),
    'utf8'
  );
  check('the menu sounds its highlight', /hoverNote\(activeIndex, displayed\.length\)/.test(select));
  check(
    'from the highlight itself, so arrowing sounds like hovering',
    /\[open, activeIndex, displayed\]/.test(select)
  );
  // A source check, and a shape-of-the-code one at that — the guard is three
  // lines inside an effect in a 560-line component, and rendering the whole
  // menu to prove it would test the harness more than the rule. Matched exactly
  // so that deleting the early return fails here.
  check(
    'but not for the row it opens on',
    /if \(!placedRef\.current\) \{\s*placedRef\.current = true\s*return\s*\}/.test(select),
    'the highlight the menu opens with should not sound'
  );

  const panel = fs.readFileSync(path.join(__dirname, '..', 'src', 'panels', 'StylePanel.jsx'), 'utf8');
  check('the style panel taps on a button press', /closest\('button'\)/.test(panel) && /clickNote\(\)/.test(panel));
  check('but not on a disabled one', /!button\.disabled/.test(panel));

  const app = fs.readFileSync(path.join(__dirname, '..', 'src', 'App.jsx'), 'utf8');
  check('the app reads it on load', /window\.avb\.settings\?\.\(\)/.test(app));
  check('and follows the menu after that', /onMenu\('sound'/.test(app));

  if (failures.length) {
    console.error(`\nsound: ${failures.length} failed, ${checked - failures.length} passed\n`);
    console.error(failures.join('\n') + '\n');
    process.exit(1);
  }
  console.log(`sound: ${checked} passed  [muted synth, silent by default]`);
})();
