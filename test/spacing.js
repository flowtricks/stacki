// Dragging a side of the spacing box.
//
//   node test/spacing.js
//
// Press a side and drag: that side's value follows the pointer. Hold Shift and
// all four go with it; hold Alt/Option and the opposite side comes along. That
// was true of the shaded bands — and the number for each side is drawn on top of
// its band, so a press meant for the band usually landed on the number instead,
// which was a button and did nothing but open the editor. Now the number drags
// too, and a press that never moves is still the click that opens the editor.
//
// Padding grows inward, margins and insets outward, so the same drag means
// opposite things in the two boxes — checked here rather than assumed.

const fs = require('fs');
const path = require('path');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
};
const settle = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  const esbuild = require('esbuild');
  const buildDir = path.join(__dirname, '..', 'node_modules', '.stacki-test');
  fs.mkdirSync(buildDir, { recursive: true });
  const entry = path.join(buildDir, 'spacing.entry.jsx');
  fs.writeFileSync(
    entry,
    `export { SpacingFill, SpacingLabel } from ${JSON.stringify(
      path.join(__dirname, '..', 'src', 'style-panel', 'SpacingBox.tsx')
    )};\n` +
      `export { clampNonNegative, isNonNegative } from ${JSON.stringify(
        path.join(__dirname, '..', 'src', 'style-panel', 'lib', 'css-properties.ts')
      )};\n` +
      `export { stepNumberAtCaret } from ${JSON.stringify(
        path.join(__dirname, '..', 'src', 'style-panel', 'lib', 'number-step.ts')
      )};\n` +
      `export { spacingBands } from ${JSON.stringify(
        path.join(__dirname, '..', 'src', 'spacingBands.js')
      )};\n` +
      `export { getHost, setHost, setModifiers } from ${JSON.stringify(
        path.join(__dirname, '..', 'src', 'style-panel', 'lib', 'host.ts')
      )};\n`
  );
  const bundlePath = path.join(buildDir, 'spacing.bundle.js');
  await esbuild.build({
    entryPoints: [entry],
    outfile: bundlePath,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react/jsx-runtime'],
    loader: { '.tsx': 'tsx', '.ts': 'ts' },
    logLevel: 'silent',
  });

  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
  global.window = dom.window;
  global.document = dom.window.document;
  global.navigator = dom.window.navigator;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  // The drag throttles its writes to the frame; jsdom only has this on window.
  global.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
  global.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
  // Pointer capture is how a drag keeps receiving moves once the pointer leaves
  // the handle; jsdom has no pointer events at all, so the events are dispatched
  // straight at the handle and capture is a no-op.
  dom.window.Element.prototype.setPointerCapture = function setPointerCapture() {};
  dom.window.Element.prototype.releasePointerCapture = function releasePointerCapture() {};

  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { act } = require('react');
  const {
    SpacingFill,
    SpacingLabel,
    clampNonNegative,
    isNonNegative,
    stepNumberAtCaret,
    spacingBands,
    setHost,
    setModifiers,
  } = require(bundlePath);

  const container = dom.window.document.getElementById('root');
  const reactRoot = createRoot(container);

  // What the panel is looking at: four sides with values, read the way the
  // style panel reads them.
  let values = {};
  const read = (prop) => ({
    source: 'selected',
    selectedValue: { value: values[prop] ?? '', important: false },
    winner: { value: values[prop] ?? '', important: false },
    contributors: [],
  });

  let committed = [];
  let liveWrites = [];
  const setProp = (prop, value) => committed.push([prop, value]);
  const liveSetProp = (prop, value) => liveWrites.push([prop, value]);

  // What the canvas is told to light up.
  const hovers = [];
  setHost({ onSpacingHover: (hover) => hovers.push(hover) });

  const showBox = async (kind) => {
    const prefix = kind === 'padding' ? 'padding-' : 'margin-';
    values = {
      [`${prefix}top`]: '3rem',
      [`${prefix}right`]: '2rem',
      [`${prefix}bottom`]: '2rem',
      [`${prefix}left`]: '2rem',
    };
    await act(async () => {
      reactRoot.render(
        React.createElement(
          'div',
          null,
          React.createElement(SpacingFill, {
            frame: kind,
            inward: kind === 'padding',
            propFor: (side) => `${prefix}${side}`,
            read,
            busy: false,
            setProp,
            liveSetProp,
            onLive: () => {},
            onLiveEnd: () => {},
          }),
          ...['top', 'right', 'bottom', 'left'].map((side) =>
            React.createElement(SpacingLabel, {
              key: side,
              prop: `${prefix}${side}`,
              side,
              emptyLabel: '0',
              read,
              busy: false,
              clearProp: (prop) => committed.push([prop, null]),
              onEdit: (prop) => committed.push(['edit', prop]),
              variables: [],
              setProp,
              liveSetProp,
              onLive: () => {},
              onLiveEnd: () => {},
            })
          )
        )
      );
      await settle(10);
    });
  };

  // One gesture: press, move, release — with whatever modifiers are held.
  const dragOn = async (el, { dx = 0, dy = 0, ...mods }) => {
    committed = [];
    liveWrites = [];
    const send = (type, x, y) =>
      act(async () => {
        el.dispatchEvent(
          new dom.window.MouseEvent(type, { bubbles: true, clientX: x, clientY: y, ...mods })
        );
        await settle(0);
      });
    await send('pointerdown', 100, 100);
    await send('pointermove', 100 + dx, 100 + dy);
    // A frame, so the throttled write to the canvas actually happens — releasing
    // in the same tick would cancel it, which no real drag does.
    await act(async () => { await settle(20); });
    await send('pointerup', 100 + dx, 100 + dy);
    return committed;
  };
  const band = (side) => container.querySelector(`.embed-editor_spacing-tri.is-${side}`);
  const number = (side) => container.querySelector(`.embed-editor_spacing-${side}`);
  const props = (list) => list.map(([prop]) => prop).sort().join(' ');
  const value = (list) => list[0]?.[1];

  // --- the bands --------------------------------------------------------------
  await showBox('padding');
  check('the box has a band per side', [...container.querySelectorAll('.embed-editor_spacing-tri')].length === 4);

  let out = await dragOn(band('top'), { dy: -40 });
  check('dragging a band writes that side', props(out) === 'padding-top', props(out));
  check('and nothing else', out.length === 1, JSON.stringify(out));

  out = await dragOn(band('top'), { dy: -40, shiftKey: true });
  check(
    'holding shift writes all four',
    props(out) === 'padding-bottom padding-left padding-right padding-top',
    props(out)
  );
  check(
    'to the same value',
    new Set(out.map(([, v]) => v)).size === 1,
    JSON.stringify(out)
  );

  out = await dragOn(band('top'), { dy: -40, altKey: true });
  check(
    'holding alt writes the side and its opposite',
    props(out) === 'padding-bottom padding-top',
    props(out)
  );

  out = await dragOn(band('left'), { dx: -40, altKey: true });
  check('the pair for a side is across from it', props(out) === 'padding-left padding-right', props(out));

  // --- the numbers ------------------------------------------------------------
  out = await dragOn(number('top'), { dy: -40 });
  check('dragging the number drags the side', props(out) === 'padding-top', props(out));
  out = await dragOn(number('top'), { dy: -40, shiftKey: true });
  check(
    'with shift, all four — from the number too',
    props(out) === 'padding-bottom padding-left padding-right padding-top',
    props(out)
  );
  out = await dragOn(number('right'), { dx: 40, altKey: true });
  check('and with alt, the pair', props(out) === 'padding-left padding-right', props(out));

  // A press that goes nowhere is a click: the editor opens, the value is not
  // written.
  out = await dragOn(number('top'), { dy: 0 });
  await act(async () => {
    number('top').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, clientX: 100, clientY: 100 }));
    await settle(0);
  });
  check('pressing a number without moving opens the editor', props(out) === 'edit', JSON.stringify(out));
  check('and writes nothing', !out.some(([p]) => p.startsWith('padding')), JSON.stringify(out));

  // A drag is not a click: the editor must not open on top of it.
  out = await dragOn(number('top'), { dy: -40 });
  await act(async () => {
    number('top').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, clientX: 100, clientY: 60 }));
    await settle(0);
  });
  check('dragging a number does not also open the editor', !out.some(([p]) => p === 'edit'), JSON.stringify(out));

  // Alt-click still clears — the modifier means "clear" on a click and "the
  // opposite side too" on a drag, and only one of them happened.
  out = await dragOn(number('bottom'), { dy: 0, altKey: true });
  await act(async () => {
    number('bottom').dispatchEvent(
      new dom.window.MouseEvent('click', { bubbles: true, clientX: 100, clientY: 100, altKey: true })
    );
    await settle(0);
  });
  check('alt-clicking a number still clears it', out.some(([p, v]) => p === 'padding-bottom' && v === null), JSON.stringify(out));

  // --- which way is up --------------------------------------------------------
  // Padding grows inward: dragging the top band DOWN (into the box) makes it
  // bigger. Margin grows outward: dragging up does.
  out = await dragOn(band('top'), { dy: 40 });
  check('dragging padding inward grows it', parseFloat(value(out)) > 3, value(out));
  out = await dragOn(band('top'), { dy: -40 });
  check('and dragging it outward shrinks it', parseFloat(value(out)) < 3, value(out));
  check('never past zero', parseFloat(await dragOn(band('top'), { dy: -4000 }).then(value)) === 0, 'padding went negative');

  await showBox('margin');
  out = await dragOn(band('top'), { dy: -40 });
  check('dragging a margin outward grows it', parseFloat(value(out)) > 3, value(out));
  check('margins may go negative', parseFloat(await dragOn(band('top'), { dy: 4000 }).then(value)) < 0, 'margin clamped at zero');
  out = await dragOn(number('top'), { dy: -40, shiftKey: true });
  check(
    'and shift on a margin number reaches all four margins',
    props(out) === 'margin-bottom margin-left margin-right margin-top',
    props(out)
  );

  // --- the unit stays the unit ------------------------------------------------
  check('the value keeps the unit it had', /rem$/.test(String(value(out))), String(value(out)));

  // --- a modifier pressed mid-drag --------------------------------------------
  // Reaching for Shift halfway through a drag is the normal way to use it: you
  // start pulling one side, decide you want all of them, and hold Shift without
  // letting go. So the modifiers are read as they are pressed, not as they were
  // when the drag began.
  await showBox('padding');
  {
    const el = number('top');
    const send = (type, opts) =>
      act(async () => {
        el.dispatchEvent(new dom.window.MouseEvent(type, { bubbles: true, clientX: 100, clientY: 100, ...opts }));
        await settle(0);
      });
    const key = (type, opts) =>
      act(async () => {
        dom.window.dispatchEvent(new dom.window.KeyboardEvent(type, { bubbles: true, ...opts }));
        await settle(20);
      });

    committed = [];
    liveWrites = [];
    await send('pointerdown', { clientX: 100, clientY: 100 });
    await send('pointermove', { clientX: 100, clientY: 60 });
    await act(async () => { await settle(20); }); // let the throttled write land
    check(
      'a drag starts on the side it was pressed on',
      new Set(liveWrites.map(([prop]) => prop)).size === 1,
      JSON.stringify(liveWrites)
    );

    // Shift goes down; the pointer does not move.
    liveWrites = [];
    await key('keydown', { key: 'Shift', shiftKey: true });
    check(
      'holding shift mid-drag takes the other three with it',
      new Set(liveWrites.map(([prop]) => prop)).size === 4,
      JSON.stringify(liveWrites)
    );

    // And letting go of it puts them back — they were a preview, never a write.
    liveWrites = [];
    await key('keyup', { key: 'Shift', shiftKey: false });
    const putBack = liveWrites.filter(([, value]) => value === null).map(([prop]) => prop).sort();
    check(
      'letting go of it puts the other three back',
      putBack.join(' ') === 'padding-bottom padding-left padding-right',
      JSON.stringify(liveWrites)
    );

    // Option, the same way, and the release writes what the modifier names then.
    liveWrites = [];
    await key('keydown', { key: 'Alt', altKey: true });
    check(
      'option mid-drag reaches across to the opposite side',
      new Set(liveWrites.map(([prop]) => prop)).size === 2,
      JSON.stringify(liveWrites)
    );
    await send('pointerup', { clientX: 100, clientY: 60, altKey: true });
    check(
      'and releasing writes the pair, not the side it started on',
      props(committed) === 'padding-bottom padding-top',
      props(committed)
    );
    check('to one value', new Set(committed.map(([, v]) => v)).size === 1, JSON.stringify(committed));
  }

  // A modifier let go of before the release is not part of the edit.
  {
    const el = number('top');
    committed = [];
    liveWrites = [];
    await act(async () => {
      el.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true, clientX: 100, clientY: 100, shiftKey: true }));
      await settle(0);
    });
    await act(async () => {
      el.dispatchEvent(new dom.window.MouseEvent('pointermove', { bubbles: true, clientX: 100, clientY: 60, shiftKey: true }));
      await settle(20);
    });
    await act(async () => {
      dom.window.dispatchEvent(new dom.window.KeyboardEvent('keyup', { bubbles: true, key: 'Shift', shiftKey: false }));
      await settle(20);
    });
    await act(async () => {
      el.dispatchEvent(new dom.window.MouseEvent('pointerup', { bubbles: true, clientX: 100, clientY: 60 }));
      await settle(0);
    });
    check(
      'a shift let go of before release writes only the dragged side',
      props(committed) === 'padding-top',
      props(committed)
    );
  }

  // --- pointing at a side, as opposed to changing it --------------------------
  // Hovering `padding-top` in the panel says which property is about to change.
  // What the canvas draws says what that property is holding open — so the panel
  // has to report the sides, and keep reporting while a modifier changes which
  // ones they are.
  await showBox('padding');
  {
    const enter = (el, mods = {}) =>
      act(async () => {
        el.dispatchEvent(new dom.window.MouseEvent('pointerover', { bubbles: true, ...mods }));
        el.dispatchEvent(new dom.window.MouseEvent('pointerenter', { bubbles: false, ...mods }));
        await settle(0);
      });
    // React builds enter/leave out of the over/out pair, so that is what a
    // pointer actually leaving looks like.
    const leave = (el) =>
      act(async () => {
        el.dispatchEvent(
          new dom.window.MouseEvent('pointerout', { bubbles: true, relatedTarget: dom.window.document.body })
        );
        await settle(0);
      });
    const key = (type, mods) =>
      act(async () => {
        dom.window.dispatchEvent(new dom.window.KeyboardEvent(type, { bubbles: true, ...mods }));
        await settle(0);
      });
    const last = () => hovers[hovers.length - 1];

    hovers.length = 0;
    await enter(band('top'));
    check('hovering a band reports it', last()?.sides.join(' ') === 'top', JSON.stringify(last()));
    check('as padding', last()?.kind === 'padding', last()?.kind);
    check('with the value it is showing', last()?.labels?.top === '3rem', JSON.stringify(last()?.labels));

    // Swallowed by a field in the panel — the canvas still has to hear it.
    const greedy = dom.window.document.createElement('input');
    container.appendChild(greedy);
    greedy.addEventListener('keydown', (event) => event.stopPropagation());
    greedy.addEventListener('keyup', (event) => event.stopPropagation());

    await act(async () => {
      greedy.dispatchEvent(new dom.window.KeyboardEvent('keydown', { bubbles: true, key: 'Shift', shiftKey: true }));
      await settle(0);
    });
    check(
      'a key a field swallows still reaches the canvas',
      last()?.sides.length === 4,
      JSON.stringify(last())
    );
    await act(async () => {
      greedy.dispatchEvent(new dom.window.KeyboardEvent('keyup', { bubbles: true, key: 'Shift', shiftKey: false }));
      await settle(0);
    });
    greedy.remove();

    await key('keydown', { key: 'Shift', shiftKey: true });
    check(
      'holding shift over it reports all four',
      last()?.sides.slice().sort().join(' ') === 'bottom left right top',
      JSON.stringify(last())
    );
    check('each with its own value', last()?.labels?.left === '2rem', JSON.stringify(last()?.labels));
    await key('keyup', { key: 'Shift', shiftKey: false });
    check('letting go reports the one side again', last()?.sides.join(' ') === 'top', JSON.stringify(last()));

    await key('keydown', { key: 'Alt', altKey: true });
    check(
      'holding option reports the pair',
      last()?.sides.slice().sort().join(' ') === 'bottom top',
      JSON.stringify(last())
    );

    // Swapping one modifier for the other without leaving: option → shift →
    // option → nothing, each of them answered on the way through.
    await key('keydown', { key: 'Shift', shiftKey: true, altKey: true });
    check('adding shift over option widens to all four', last()?.sides.length === 4, JSON.stringify(last()));
    await key('keyup', { key: 'Shift', shiftKey: false, altKey: true });
    check(
      'and dropping shift falls back to the pair option names',
      last()?.sides.slice().sort().join(' ') === 'bottom top',
      JSON.stringify(last())
    );
    await key('keyup', { key: 'Alt', altKey: false });
    check('letting go of both is the one side again', last()?.sides.join(' ') === 'top', JSON.stringify(last()));

    // The modifier pressed with the canvas focused. Clicking an element on the
    // page puts keyboard focus inside the preview frame, and every key after
    // that is delivered there — the panel's own listeners never fire. The frame
    // forwards what it heard; this is that arriving.
    await act(async () => { setModifiers(true, false); await settle(0); });
    check(
      'a shift pressed with the canvas focused reaches the panel',
      last()?.sides.length === 4,
      JSON.stringify(last())
    );
    await act(async () => { setModifiers(false, true); await settle(0); });
    check(
      'and swapping it for option, from there too',
      last()?.sides.slice().sort().join(' ') === 'bottom top',
      JSON.stringify(last())
    );
    await act(async () => { setModifiers(false, false); await settle(0); });
    check(
      'and releasing both goes back to the one side',
      last()?.sides.join(' ') === 'top',
      JSON.stringify(last())
    );

    // A modifier released while another window had focus is never seen going
    // up; coming back must not leave the canvas lit for it.
    await key('keydown', { key: 'Shift', shiftKey: true });
    check('shift again', last()?.sides.length === 4, JSON.stringify(last()));
    await act(async () => {
      dom.window.dispatchEvent(new dom.window.Event('blur'));
      await settle(0);
    });
    check(
      'and the window losing focus drops what it can no longer see',
      last()?.sides.join(' ') === 'top',
      JSON.stringify(last())
    );

    await leave(band('top'));
    check('leaving it reports nothing at all', last() === null, JSON.stringify(last()));

    // The number on top of the band is the other half of the same control.
    hovers.length = 0;
    await enter(number('left'));
    check('hovering the number reports its side too', last()?.sides.join(' ') === 'left', JSON.stringify(last()));
    await leave(number('left'));
    check('and leaving it clears', last() === null, JSON.stringify(last()));

    // The margin box says margin, so the canvas can colour it differently.
    await showBox('margin');
    hovers.length = 0;
    await enter(band('bottom'));
    check('the margin box reports margin', last()?.kind === 'margin', JSON.stringify(last()));
    await leave(band('bottom'));
  }

  // --- where those sides are on the page --------------------------------------
  // The element's border box plus what it computed to, turned into the strips to
  // draw. Padding lies inside the box, margin outside it.
  {
    const box = { x: 100, y: 50, w: 400, h: 200 };
    const size = {
      padding: { top: 20, right: 10, bottom: 30, left: 10 },
      margin: { top: 8, right: 4, bottom: 8, left: 4 },
    };
    const of = (kind, sides) => spacingBands(box, size, kind, sides);
    const top = of('padding', ['top'])[0];
    check('the padding-top band starts at the top of the box', top.y === 50 && top.x === 100);
    check('is as wide as the box', top.w === 400, `${top.w}`);
    check('and as tall as the padding', top.h === 20, `${top.h}`);

    const bottom = of('padding', ['bottom'])[0];
    check('the padding-bottom band sits on the bottom edge', bottom.y === 50 + 200 - 30, `${bottom.y}`);

    const left = of('padding', ['left'])[0];
    check('a side band runs the height of the box', left.y === 50 && left.h === 200, JSON.stringify(left));
    // Hovered on its own, the top runs corner to corner; hovered alongside a
    // side, it stops where that side starts — the corner belongs to one of them.
    check('the top alone spans the whole width', of('padding', ['top'])[0].w === 400);
    const [tWithLeft, lWithTop] = of('padding', ['top', 'left']);
    check('with a side beside it, it starts after it', tWithLeft.x === 110 && tWithLeft.w === 390, JSON.stringify(tWithLeft));
    check('and the side keeps its full height', lWithTop.h === 200, JSON.stringify(lWithTop));
    check(
      'so no two bands overlap',
      tWithLeft.x >= lWithTop.x + lWithTop.w,
      `${JSON.stringify(tWithLeft)} over ${JSON.stringify(lWithTop)}`
    );

    const mTop = of('margin', ['top'])[0];
    check('a margin band lies outside the box', mTop.y === 50 - 8 && mTop.h === 8, JSON.stringify(mTop));
    check('and spans the corners', mTop.x === 96 && mTop.w === 408, JSON.stringify(mTop));
    const mRight = of('margin', ['right'])[0];
    check('the right margin starts where the box ends', mRight.x === 500, `${mRight.x}`);
    const mLeft = of('margin', ['left'])[0];
    check(
      'and a side margin runs the full height, margins included',
      mLeft.y === 42 && mLeft.h === 216,
      JSON.stringify(mLeft)
    );

    check('all four is four bands', of('padding', ['top', 'right', 'bottom', 'left']).length === 4);
    check('and they come in reading order', of('padding', ['left', 'top']).map((b) => b.side).join(' ') === 'top left');
    // A side with nothing on it is not a strip of anything.
    check(
      'a side with no spacing draws nothing',
      spacingBands(box, { padding: { top: 0, right: 0, bottom: 0, left: 0 } }, 'padding', ['top']).length === 0
    );
    check('and neither does a box nobody measured', spacingBands(null, size, 'padding', ['top']).length === 0);
    check('nor a kind that was never reported', spacingBands(box, {}, 'margin', ['top']).length === 0);
  }

  // --- the canvas draws what it is told ---------------------------------------
  {
    const frame = fs.readFileSync(path.join(__dirname, '..', 'electron', 'preload.js'), 'utf8');
    check(
      'the page forwards the modifiers it hears',
      /type: 'avb:modifiers'/.test(frame),
      'keys pressed with the canvas focused stay in the canvas'
    );
    check(
      'and the app passes them to the panel',
      /avb:modifiers'[\s\S]{0,400}setModifiers\(/.test(
        fs.readFileSync(path.join(__dirname, '..', 'src', 'panels', 'PreviewPane.jsx'), 'utf8')
      ),
      'the message arrives and goes nowhere'
    );
    const pane = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'panels', 'PreviewPane.jsx'),
      'utf8'
    );
    check('the preview draws the bands', /spacingBands\(/.test(pane));
    check('over the selected element', /rects\[selPath\]/.test(pane));
    check('from what the page measured', /spacing\[selPath\]/.test(pane));
    const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'styles.css'), 'utf8');
    check('padding is pink', /\.spacing-band\.is-padding \{ --band: #ec4899; \}/.test(css));
    check('and margin is blue', /\.spacing-band\.is-margin \{ --band: #3b82f6; \}/.test(css));
    const app = fs.readFileSync(path.join(__dirname, '..', 'src', 'App.jsx'), 'utf8');
    check(
      'the panel is wired to the canvas',
      /onSpacingHover=\{setSpacingHover\}/.test(app) && /spacingHover=\{spacingHover\}/.test(app),
      'the style panel reports a hover nothing is listening to'
    );
    const preload = fs.readFileSync(path.join(__dirname, '..', 'electron', 'preload.js'), 'utf8');
    check('and the page reports its spacing', /spacing\[p\] = spacingForPath\(p\)/.test(preload));
  }

  // --- the canvas sees it while it happens ------------------------------------
  liveWrites = [];
  await dragOn(band('top'), { dy: -40, shiftKey: true });
  check(
    'every affected side updates live, not just on release',
    new Set(liveWrites.map(([p]) => p)).size === 4,
    JSON.stringify(liveWrites)
  );

  // --- a value the property cannot take ---------------------------------------
  //
  // A negative gap or padding is not a small one: the browser drops the whole
  // declaration, so the field would sit there showing a number the page hasn't
  // got. Margins and insets are left alone — pulling something out of its box is
  // what they are for.
  check('a negative padding is zero', clampNonNegative('padding-top', '-4rem') === '0');
  check('a negative gap is zero', clampNonNegative('row-gap', '-2px') === '0');
  check('so is a bare -0.5', clampNonNegative('column-gap', '-.5rem') === '0');
  check('and each part of a pair', clampNonNegative('padding', '1rem -2rem') === '1rem 0');
  check('a positive one is untouched', clampNonNegative('padding-top', '4rem') === '4rem');
  check('a margin may be negative', clampNonNegative('margin-top', '-4rem') === '-4rem');
  check('an inset may be negative', clampNonNegative('top', '-4rem') === '-4rem');
  check(
    'an expression is left to the browser',
    clampNonNegative('padding-top', 'clamp(1rem, -2vw, 3rem)') === 'clamp(1rem, -2vw, 3rem)',
    clampNonNegative('padding-top', 'clamp(1rem, -2vw, 3rem)')
  );
  check(
    'including a subtraction that only looks like a sign',
    clampNonNegative('padding-top', 'calc(100% - 2rem)') === 'calc(100% - 2rem)'
  );
  check(
    'and so is a variable',
    clampNonNegative('row-gap', 'var(--gap-negative)') === 'var(--gap-negative)'
  );
  check('a prefix is not a negative number', clampNonNegative('padding-top', '-webkit-fill') === '-webkit-fill');
  check('padding is on the list, margin is not', isNonNegative('padding-inline-start') && !isNonNegative('margin-left'));

  // Stepping down stops at the floor rather than walking past it and being
  // clamped on the way out — the field must never show what the page won't take.
  check(
    'stepping down stops at zero',
    stepNumberAtCaret('1rem', 1, -1, 'whole', 0)?.text === '0rem',
    JSON.stringify(stepNumberAtCaret('1rem', 1, -1, 'whole', 0))
  );
  check(
    'and again at zero, it stays',
    stepNumberAtCaret('0rem', 1, -1, 'whole', 0)?.text === '0rem',
    JSON.stringify(stepNumberAtCaret('0rem', 1, -1, 'whole', 0))
  );
  check(
    'with no floor it goes negative, as a margin should',
    stepNumberAtCaret('0rem', 1, -1, 'whole')?.text === '-1rem',
    JSON.stringify(stepNumberAtCaret('0rem', 1, -1, 'whole'))
  );

  // --- Gap bands ------------------------------------------------------------
  //
  // Padding and margin are four numbers on the element, so the panel works out
  // where they are from the box alone. A gap cannot be: it lives between
  // children, and where those are is something only the laid-out page knows.
  // So the canvas measures the rectangles and this only picks the axis asked
  // for — which is worth checking, because the two axes share a code path with
  // "sides" that are not sides at all.
  {
    const spacing = {
      padding: { top: 10, right: 10, bottom: 10, left: 10 },
      margin: { top: 0, right: 0, bottom: 0, left: 0 },
      gaps: [
        { axis: 'column', x: 100, y: 0, w: 24, h: 50 },
        { axis: 'column', x: 200, y: 0, w: 24, h: 50 },
        { axis: 'row', x: 0, y: 50, w: 300, h: 24 },
      ],
    };
    const box = { x: 0, y: 0, w: 300, h: 200 };

    const both = spacingBands(box, spacing, 'gap', ['row', 'column']);
    check('gap draws every measured space', both.length === 3, JSON.stringify(both));
    // One band per space, not one per axis: a row of four children has three
    // column gaps and they are three separate rectangles.
    check('including two gaps on the same axis', both.filter((b) => b.side === 'column').length === 2);

    const cols = spacingBands(box, spacing, 'gap', ['column']);
    check('one axis draws only its own', cols.length === 2, JSON.stringify(cols));
    check('and they are the column ones', cols.every((b) => b.side === 'column'), JSON.stringify(cols));
    const rows = spacingBands(box, spacing, 'gap', ['row']);
    check('the other axis likewise', rows.length === 1 && rows[0].side === 'row', JSON.stringify(rows));
    // The rectangles come through untouched — they were measured on the page
    // and second-guessing them here would move the outline off the gap.
    check('the geometry is passed through', rows[0].x === 0 && rows[0].y === 50 && rows[0].w === 300 && rows[0].h === 24, JSON.stringify(rows[0]));

    // An element with no gaps measured draws nothing, rather than falling back
    // to padding's four-sided shape.
    check('no measured gaps draws nothing', spacingBands(box, { ...spacing, gaps: [] }, 'gap', ['row', 'column']).length === 0);
    check('and a missing gaps list does not throw', spacingBands(box, { padding: {}, margin: {} }, 'gap', ['row']).length === 0);
    // Gap does not need the element's box at all, so a selection whose rect has
    // not arrived yet still lights up.
    check('gap needs no box', spacingBands(null, spacing, 'gap', ['column']).length === 2);
    // Zero-sized bands are not somewhere to look.
    check(
      'an empty band is skipped',
      spacingBands(box, { gaps: [{ axis: 'row', x: 0, y: 0, w: 300, h: 0 }] }, 'gap', ['row']).length === 0
    );
    // Padding and margin must be unaffected by any of this.
    check('padding still works', spacingBands(box, spacing, 'padding', ['top']).length === 1);
    check('and margin still returns nothing when there is none', spacingBands(box, spacing, 'margin', ['top']).length === 0);
  }

  if (failures.length) {
    console.error(`\nspacing: ${failures.length} failed, ${checked - failures.length} passed\n`);
    console.error(failures.join('\n') + '\n');
    process.exit(1);
  }
  console.log(`spacing: ${checked} passed`);
  process.exit(0);
})();
