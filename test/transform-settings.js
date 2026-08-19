// The settings behind the transform list: origin, backface, and the two perspectives.
//
//   node test/transform-settings.js
//
// Two of these are ordinary properties. The self perspective is not: it is a
// `perspective()` FUNCTION living inside the element's own `transform`, sharing
// that value with every layer in the list. Which makes it the one setting that
// can be destroyed by editing something else — parseTransforms drops any
// function it does not recognise, so a self perspective left in the value would
// disappear the next time a layer was moved, hidden, or added, with nothing on
// screen to say it had gone.
//
// Its position matters as much as its presence. `perspective()` is legal
// anywhere in the list, so nothing complains, but the matrix depends on WHERE.
// That is checked against a real browser at the bottom rather than asserted.

const fs = require('fs');
const path = require('path');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
};

(async () => {
  const esbuild = require('esbuild');
  const buildDir = path.join(__dirname, '..', 'node_modules', '.stacki-test');
  fs.mkdirSync(buildDir, { recursive: true });
  const lib = (f) => JSON.stringify(path.join(__dirname, '..', 'src', 'style-panel', 'lib', f));
  const entry = path.join(buildDir, 'transform-settings.entry.ts');
  fs.writeFileSync(
    entry,
    `export * from ${lib('transform-settings.ts')};\n` +
      `export { parseTransforms, serializeTransforms } from ${lib('transform.ts')};\n` +
      `export { parseHideable, serializeHideable } from ${lib('hideable.ts')};\n`
  );
  const bundlePath = path.join(buildDir, 'transform-settings.bundle.js');
  await esbuild.build({ entryPoints: [entry], outfile: bundlePath, bundle: true, format: 'cjs', platform: 'node', logLevel: 'silent' });
  const {
    parseOrigin, serializeOrigin, originPreset, ORIGIN_PRESETS,
    takeSelfPerspective, withSelfPerspective,
    parseTransforms, serializeTransforms, parseHideable, serializeHideable,
  } = require(bundlePath);

  // --- Reading an origin ------------------------------------------------------
  {
    // Keywords and percentages are the same corner, and the pad has to light up
    // for both — a file written by hand says `left top`, the panel writes `0% 0%`.
    check('left top is the top-left corner', JSON.stringify(parseOrigin('left top')) === JSON.stringify({ x: '0%', y: '0%', z: '' }), JSON.stringify(parseOrigin('left top')));
    check('and so is 0% 0%', originPreset(parseOrigin('0% 0%')) === 0, String(originPreset(parseOrigin('0% 0%'))));
    check('and so is 0 0', originPreset(parseOrigin('0 0')) === 0, String(originPreset(parseOrigin('0 0'))));
    // Two keywords may be written either way round — `top left` is a corner, not
    // a nonsense x of `top`.
    check('top left is the same corner written backwards', JSON.stringify(parseOrigin('top left')) === JSON.stringify({ x: '0%', y: '0%', z: '' }), JSON.stringify(parseOrigin('top left')));
    check('right bottom is the far corner', originPreset(parseOrigin('right bottom')) === 8, String(originPreset(parseOrigin('right bottom'))));
    check('bottom right too', originPreset(parseOrigin('bottom right')) === 8, String(originPreset(parseOrigin('bottom right'))));

    // One value: the other axis is the centre.
    check('a lone `left` centres the other axis', JSON.stringify(parseOrigin('left')) === JSON.stringify({ x: '0%', y: '50%', z: '' }), JSON.stringify(parseOrigin('left')));
    check('a lone `top` sets y, not x', JSON.stringify(parseOrigin('top')) === JSON.stringify({ x: '50%', y: '0%', z: '' }), JSON.stringify(parseOrigin('top')));
    check('a lone length is x', JSON.stringify(parseOrigin('10px')) === JSON.stringify({ x: '10px', y: '50%', z: '' }), JSON.stringify(parseOrigin('10px')));

    // Nothing declared is the centre, which is what both properties do anyway.
    check('an empty value is the centre', originPreset(parseOrigin('')) === 4, String(originPreset(parseOrigin(''))));
    check('and so is `center`', originPreset(parseOrigin('center')) === 4, String(originPreset(parseOrigin('center'))));

    // A value between the dots lights up none of them rather than the nearest.
    check('an in-between origin matches no dot', originPreset(parseOrigin('30% 70%')) === -1, String(originPreset(parseOrigin('30% 70%'))));

    // A calc() has spaces in it and must not be split into two axes.
    check('a calc keeps its spaces', parseOrigin('calc(50% + 10px) 0%').x === 'calc(50% + 10px)', parseOrigin('calc(50% + 10px) 0%').x);
    check('and the axis after it still reads', parseOrigin('calc(50% + 10px) 0%').y === '0%', parseOrigin('calc(50% + 10px) 0%').y);

    // transform-origin takes a third, z value. Nothing in the UI shows it, so it
    // has to be carried through rather than dropped.
    check('a z origin is kept', parseOrigin('50% 50% 20px').z === '20px', JSON.stringify(parseOrigin('50% 50% 20px')));
    check('and written back out', serializeOrigin(parseOrigin('50% 50% 20px')) === '50% 50% 20px', serializeOrigin(parseOrigin('50% 50% 20px')));
  }

  // --- Writing one back -------------------------------------------------------
  {
    check('a corner serializes', serializeOrigin({ x: '0%', y: '100%', z: '' }) === '0% 100%', serializeOrigin({ x: '0%', y: '100%', z: '' }));
    // The centre IS the default, so writing it would leave a declaration saying
    // nothing — the caller clears the property instead.
    check('the centre serializes to nothing', serializeOrigin({ x: '50%', y: '50%', z: '' }) === '', serializeOrigin({ x: '50%', y: '50%', z: '' }));
    check('unless it carries a z', serializeOrigin({ x: '50%', y: '50%', z: '20px' }) === '50% 50% 20px');
    check('every dot round-trips', ORIGIN_PRESETS.every((p, i) => originPreset(parseOrigin(serializeOrigin({ x: p.x, y: p.y, z: '' }) || 'center')) === i));
  }

  // --- Lifting the self perspective out --------------------------------------
  {
    const t = takeSelfPerspective('perspective(500px) rotateX(0deg) rotateY(0deg) rotateZ(45deg)');
    check('the distance comes out', t.distance === '500px', t.distance);
    check('and the layers are left behind', t.rest === 'rotateX(0deg) rotateY(0deg) rotateZ(45deg)', t.rest);
    // The rest has to be something parseTransforms can still read.
    check('which still parse as layers', parseTransforms(t.rest).length === 1, JSON.stringify(parseTransforms(t.rest)));

    // Written by hand somewhere other than the front — still found, because
    // leaving it in would mean parseTransforms silently dropping it.
    const mid = takeSelfPerspective('translateX(10px) perspective(800px) rotateZ(45deg)');
    check('one written mid-list is found too', mid.distance === '800px', mid.distance);
    check('and the layers around it survive', mid.rest === 'translateX(10px) rotateZ(45deg)', mid.rest);

    check('a value with none reports none', takeSelfPerspective('scale3d(2, 2, 1)').distance === '', takeSelfPerspective('scale3d(2, 2, 1)').distance);
    check('and hands the value back whole', takeSelfPerspective('scale3d(2, 2, 1)').rest === 'scale3d(2, 2, 1)');
    check('an empty value is fine', takeSelfPerspective('').distance === '' && takeSelfPerspective('').rest === '');

    // A name that merely ends in the word is a different function.
    check('a different function keeping the word is left alone', takeSelfPerspective('my-perspective(5px) scale(2)').distance === '', takeSelfPerspective('my-perspective(5px) scale(2)').distance);

    // A hidden layer's text is inside a comment — not part of the list, so a
    // perspective() mentioned in there is not this element's perspective.
    const hid = takeSelfPerspective('scale3d(2, 2, 1) /* perspective(900px) */');
    check('one inside a hidden layer is not taken', hid.distance === '', hid.distance);
    check('and the comment is left where it was', hid.rest === 'scale3d(2, 2, 1) /* perspective(900px) */', hid.rest);
  }

  // --- Putting it back --------------------------------------------------------
  {
    check('it goes in front', withSelfPerspective('rotateZ(45deg)', '500px') === 'perspective(500px) rotateZ(45deg)', withSelfPerspective('rotateZ(45deg)', '500px'));
    check('on its own when there are no layers', withSelfPerspective('', '500px') === 'perspective(500px)', withSelfPerspective('', '500px'));
    check('no distance writes nothing extra', withSelfPerspective('rotateZ(45deg)', '') === 'rotateZ(45deg)');
    // A zero perspective is not a subtle one, it is an invalid one.
    check('zero counts as none', withSelfPerspective('rotateZ(45deg)', '0') === 'rotateZ(45deg)', withSelfPerspective('rotateZ(45deg)', '0'));
    check('and so does 0px', withSelfPerspective('rotateZ(45deg)', '0px') === 'rotateZ(45deg)');

    // `none` is the placeholder written when every layer is hidden, to stop the
    // declaration being empty. A perspective() is a value in its own right, so
    // the placeholder is not needed — and `perspective(500px) none` is not a
    // valid transform, which would drop the declaration AND every hidden
    // layer's comment with it.
    const allHidden = 'none /* rotateZ(45deg) */';
    check(
      'the all-hidden placeholder gives way to it',
      withSelfPerspective(allHidden, '500px') === 'perspective(500px) /* rotateZ(45deg) */',
      withSelfPerspective(allHidden, '500px')
    );
    check('and comes back when the perspective goes', withSelfPerspective(allHidden, '') === allHidden, withSelfPerspective(allHidden, ''));
  }

  // --- It survives editing the layers ----------------------------------------
  //
  // The failure this guards: every layer edit rewrites the whole `transform`
  // value, and the self perspective is inside it.
  {
    const start = 'perspective(600px) translate3d(10px, 20px, 0px) rotateX(0deg) rotateY(0deg) rotateZ(45deg)';
    const round = (value, edit) => {
      const { distance, rest } = takeSelfPerspective(value);
      const rows = parseHideable(rest, ' ', parseTransforms);
      return withSelfPerspective(serializeHideable(edit(rows), ' ', serializeTransforms), distance);
    };
    check('it survives a reorder', round(start, (r) => [r[1], r[0]]).startsWith('perspective(600px) '), round(start, (r) => [r[1], r[0]]));
    check('it survives hiding a layer', round(start, (r) => r.map((x, i) => (i === 0 ? { ...x, hidden: true } : x))).startsWith('perspective(600px) '), round(start, (r) => r.map((x, i) => (i === 0 ? { ...x, hidden: true } : x))));
    check('it survives removing one', round(start, (r) => r.slice(1)).startsWith('perspective(600px) '), round(start, (r) => r.slice(1)));
    check('it survives removing them all', round(start, () => []) === 'perspective(600px)', round(start, () => []));
    check('it survives hiding them all', round(start, (r) => r.map((x) => ({ ...x, hidden: true }))).startsWith('perspective(600px) /*'), round(start, (r) => r.map((x) => ({ ...x, hidden: true }))));
    // And the layers are still all there afterwards.
    const after = round(start, (r) => r);
    check('and nothing else changed', after === start, after);
  }

  // --- The ⋯ button, and what its controls write ------------------------------
  //
  // The settings are only reachable through it, so a popup that does not open —
  // or opens and writes the wrong property — is the whole feature gone. Driven
  // through the real section rather than the popup alone, so the button, the
  // popover and the writes are all exercised the way a press exercises them.
  {
    const bundle2 = path.join(buildDir, 'effects.bundle.js');
    await esbuild.build({
      entryPoints: [path.join(__dirname, '..', 'src', 'style-panel', 'EffectsSection.tsx')],
      outfile: bundle2,
      bundle: true,
      format: 'cjs',
      platform: 'node',
      jsx: 'automatic',
      external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
      loader: { '.css': 'empty' },
      logLevel: 'silent',
    });

    const { JSDOM } = require('jsdom');
    const dom = new JSDOM('<!doctype html><body></body>', { pretendToBeVisual: true });
    global.window = dom.window;
    global.document = dom.window.document;
    global.navigator = dom.window.navigator;
    global.Element = dom.window.Element;
    global.HTMLElement = dom.window.HTMLElement;
    global.Node = dom.window.Node;
    global.getComputedStyle = dom.window.getComputedStyle;
    global.MutationObserver = dom.window.MutationObserver;
    global.requestAnimationFrame = (fn) => setTimeout(fn, 0);
    global.cancelAnimationFrame = clearTimeout;
    global.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
    dom.window.ResizeObserver = global.ResizeObserver;
    global.IS_REACT_ACT_ENVIRONMENT = true;

    const React = require('react');
    const { createRoot } = require('react-dom/client');
    const { act } = React;
    const EffectsSection = require(bundle2).default;

    const mount = async (decls) => {
      const host = document.createElement('div');
      document.body.appendChild(host);
      const root = createRoot(host);
      const set = [];
      const cleared = [];
      const read = (prop) =>
        decls[prop] != null
          ? {
              source: 'selected',
              overridden: false,
              contributors: [],
              winner: { selectorText: '.x', value: decls[prop], important: false },
              selectedValue: { value: decls[prop], important: false },
            }
          : undefined;
      await act(async () => {
        root.render(
          React.createElement(EffectsSection, {
            read,
            busy: false,
            setProp: (prop, value) => set.push([prop, value]),
            clearProp: (prop) => cleared.push(...(Array.isArray(prop) ? prop : [prop])),
            liveSetProp: () => {},
            onProvenance: () => {},
            onSelectSelector: () => {},
          })
        );
      });
      const click = async (el) => {
        await act(async () => {
          el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
        });
      };
      // Typing, as React sees it. Setting `.value` straight goes through React's
      // own value tracker, which then treats the change as already-seen and
      // fires nothing — so it goes through the native setter. And onBlur is
      // delivered from `focusout`, not `blur`, which does not bubble.
      const type = async (input, text) => {
        await act(async () => {
          const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
          setter.call(input, text);
          input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
        });
        await act(async () => {
          input.dispatchEvent(new dom.window.FocusEvent('focusout', { bubbles: true }));
        });
      };
      return {
        host, set, cleared, click, type,
        // The popover portals to <body>, so it is looked for there.
        popup: () => document.querySelector('[aria-label="Transform settings"][role], .embed-editor_tsettings'),
        trigger: () => host.querySelector('button[aria-label="Transform settings"]'),
        done: async () => { await act(async () => root.unmount()); host.remove(); },
      };
    };

    const m = await mount({ transform: 'rotateX(0deg) rotateY(0deg) rotateZ(45deg)' });
    check('the transform list has a settings button', !!m.trigger(), m.host.innerHTML.slice(0, 200));
    check('and it is closed to begin with', !document.querySelector('.embed-editor_tsettings'));

    await m.click(m.trigger());
    const popup = document.querySelector('.embed-editor_tsettings');
    check('pressing it opens the settings', !!popup, document.body.innerHTML.slice(-300));
    if (popup) {
      const text = popup.textContent || '';
      for (const heading of ['Transform settings', 'Self perspective', 'Children perspective']) {
        check(`it has a "${heading}" section`, text.includes(heading), text.slice(0, 200));
      }
      check('with a backface control', !!popup.querySelector('[aria-label="Backface visibility"]'));
      // ...showing which way it is set. Nothing declared is not "no answer":
      // backface-visibility is `visible` until something says otherwise, so a
      // control with NEITHER segment lit is telling the truth about the
      // stylesheet and lying about the element. It highlights what the page
      // computes, and falls back to the CSS initial value with no canvas to ask —
      // the same rule every other unset control in the panel follows.
      const segs = [...popup.querySelectorAll('[aria-label="Backface visibility"] button')];
      const lit = segs.filter((b) => b.getAttribute('aria-checked') === 'true');
      check('with one of its segments lit even though nothing is set', lit.length === 1, JSON.stringify(segs.map((b) => [b.textContent, b.getAttribute('aria-checked')])));
      check('and it is Visible, which is what the element actually does', lit.length === 1 && (lit[0].textContent || '').trim() === 'Visible', lit.map((b) => b.textContent).join(','));
      check('a transform-origin pad', !!popup.querySelector('[aria-label="Transform origin"]'));
      check('and a perspective-origin pad', !!popup.querySelector('[aria-label="Perspective origin"]'));
      check('plus both distances', popup.querySelectorAll('input[aria-label$="perspective distance"]').length === 2, String(popup.querySelectorAll('input[aria-label$="perspective distance"]').length));

      // A pad dot writes the origin it shows.
      const pad = popup.querySelector('[aria-label="Transform origin"]');
      await m.click(pad.querySelectorAll('button')[0]);
      check('a pad dot writes transform-origin', m.set.some(([p, v]) => p === 'transform-origin' && v === '0% 0%'), JSON.stringify(m.set));

      // The centre is the default, so choosing it clears rather than writes.
      await m.click(pad.querySelectorAll('button')[4]);
      check('and the centre clears it instead', m.cleared.includes('transform-origin'), JSON.stringify(m.cleared));

      // Backface writes its own property, not the transform.
      const hidden = [...popup.querySelectorAll('[aria-label="Backface visibility"] button')].find((b) => (b.textContent || '').trim() === 'Hidden');
      await m.click(hidden);
      check('Hidden writes backface-visibility', m.set.some(([p, v]) => p === 'backface-visibility' && v === 'hidden'), JSON.stringify(m.set));

      // The two perspectives are different CSS, and the popup must not confuse
      // them: children writes the `perspective` property, self writes into the
      // element's own transform.
      const child = popup.querySelector('input[aria-label="Children perspective distance"]');
      await m.type(child, '500');
      check('children perspective writes the property', m.set.some(([p, v]) => p === 'perspective' && v === '500px'), JSON.stringify(m.set));
      check('and never touches the transform', !m.set.some(([p, v]) => p === 'transform' && v.includes('perspective')) || m.set.filter(([p]) => p === 'transform').length === 0, JSON.stringify(m.set.filter(([p]) => p === 'transform')));

      const self = popup.querySelector('input[aria-label="Self perspective distance"]');
      await m.type(self, '500');
      const wrote = m.set.filter(([p]) => p === 'transform').pop();
      check('self perspective writes into the transform', !!wrote, JSON.stringify(m.set));
      // In front, which is the half that decides what it means.
      check('at the front of the list', !!wrote && wrote[1].startsWith('perspective(500px) '), JSON.stringify(wrote));
      // And without losing the layer that was already there.
      check('keeping the layer already there', !!wrote && wrote[1].includes('rotateZ(45deg)'), JSON.stringify(wrote));
    }
    await m.done();

    // A declared value still decides — the fallback only fills a gap.
    {
      const h = await mount({ transform: 'rotateZ(45deg)', 'backface-visibility': 'hidden' });
      await h.click(h.trigger());
      const lit = [...document.querySelectorAll('[aria-label="Backface visibility"] button')]
        .filter((b) => b.getAttribute('aria-checked') === 'true');
      check('a declared backface lights its own segment', lit.length === 1 && (lit[0].textContent || '').trim() === 'Hidden', lit.map((b) => b.textContent).join(','));
      await h.done();
    }

    // The regression this whole lifting-out exists for: an element that ALREADY
    // has a self perspective, and someone touches the layer list. Every layer
    // edit rewrites the entire `transform`, and parseTransforms drops functions
    // it does not know — so without lifting it out first, adding a layer would
    // quietly delete the perspective.
    {
      const e = await mount({ transform: 'perspective(600px) rotateX(0deg) rotateY(0deg) rotateZ(45deg)' });
      // It is a setting, not a layer: it must not show up as a row in the list.
      check('a self perspective is not a layer in the list', e.host.querySelectorAll('.embed-editor_bg-layer').length === 1, String(e.host.querySelectorAll('.embed-editor_bg-layer').length));

      await e.click(e.host.querySelector('button[aria-label="Add a transform"]'));
      const added = e.set.filter(([p]) => p === 'transform').pop();
      check('adding a layer keeps the self perspective', !!added && added[1].startsWith('perspective(600px) '), JSON.stringify(added));
      check('and still in front', !!added && added[1].indexOf('perspective(') === 0, JSON.stringify(added));
      check('with the layer that was there', !!added && added[1].includes('rotateZ(45deg)'), JSON.stringify(added));

      // And the settings popup reads the existing distance back out rather than
      // showing an empty field over a perspective that is really set.
      await e.click(e.trigger());
      const field = document.querySelector('input[aria-label="Self perspective distance"]');
      check('the popup shows the perspective already set', field && field.value === '600px', field && field.value);
      await e.done();
    }
  }

  // --- What the browser makes of it ------------------------------------------
  //
  // Position is the whole point: `perspective()` is legal anywhere in the list,
  // so nothing errors, but the matrix depends on where it sits. This asks a real
  // browser whether the value the panel writes means what the panel says.
  const electronPath = (() => {
    try {
      return require('electron');
    } catch {
      return null;
    }
  })();
  if (typeof electronPath !== 'string') {
    if (failures.length) {
      console.error(`transform-settings: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
      process.exit(1);
    }
    console.log(`transform-settings: ${checked} passed  [the browser check needs a Chromium]`);
    return;
  }

  const CASES = [
    // What the panel writes for a self perspective plus a rotate.
    { name: 'panel output', prop: 'transform', value: withSelfPerspective(serializeTransforms(parseTransforms('rotateY(45deg)')), '500px') },
    // The same two functions the other way round — must NOT compute the same.
    { name: 'reversed', prop: 'transform', value: 'rotateX(0deg) rotateY(45deg) rotateZ(0deg) perspective(500px)' },
    // Every layer hidden, with a perspective — the case where the `none`
    // placeholder would have made the whole declaration invalid.
    { name: 'all hidden', prop: 'transform', value: withSelfPerspective('none /* rotateZ(45deg) */', '500px') },
    // Every layer hidden and NO perspective — the placeholder must stay.
    { name: 'all hidden, no perspective', prop: 'transform', value: withSelfPerspective('none /* rotateZ(45deg) */', '') },
    { name: 'origin', prop: 'transform-origin', value: serializeOrigin({ x: '0%', y: '100%', z: '' }) },
    { name: 'origin with z', prop: 'transform-origin', value: serializeOrigin({ x: '0%', y: '100%', z: '20px' }) },
    { name: 'perspective origin', prop: 'perspective-origin', value: serializeOrigin({ x: '0%', y: '100%', z: '' }) },
  ];

  const { spawnSync } = require('child_process');
  const probePath = path.join(buildDir, 'transform-settings.probe.js');
  fs.writeFileSync(
    probePath,
    `const { app, BrowserWindow } = require('electron');
     const CASES = ${JSON.stringify(CASES)};
     app.disableHardwareAcceleration();
     app.on('window-all-closed', () => app.quit());
     app.whenReady().then(async () => {
       const win = new BrowserWindow({ show: false, width: 400, height: 300 });
       await win.loadURL('data:text/html,<div id=x style="width:100px;height:100px"></div>');
       const out = await win.webContents.executeJavaScript(
         '(' + ((cases) => {
           const el = document.getElementById('x');
           return cases.map((c) => {
             const st = document.createElement('style');
             st.textContent = '#x { ' + c.prop + ': ' + c.value + '; }';
             document.head.appendChild(st);
             const kept = st.sheet.cssRules[0].style.getPropertyValue(c.prop);
             const computed = getComputedStyle(el).getPropertyValue(c.prop);
             st.remove();
             return { ...c, kept, computed };
           });
         }).toString() + ')(' + JSON.stringify(CASES) + ')'
       );
       console.log(JSON.stringify(out));
       app.quit();
     });`
  );
  const run = spawnSync(electronPath, [probePath], { encoding: 'utf8', timeout: 120000 });
  const line = (run.stdout || '').split('\n').find((l) => l.trim().startsWith('['));
  if (!line) {
    check('the browser probe ran', false, (run.stderr || run.stdout || '').slice(0, 400));
  } else {
    const out = JSON.parse(line);
    const by = Object.fromEntries(out.map((r) => [r.name, r]));
    for (const r of out) {
      check(`the browser accepts the ${r.name} value`, r.kept !== '', `dropped: ${r.value}`);
    }
    // The point of the ordering: same two functions, different result.
    check(
      'a leading perspective is not the same as a trailing one',
      by['panel output'].computed !== by.reversed.computed,
      `both computed ${by['panel output'].computed}`
    );
    // And the panel's is the leading one.
    check(
      'the panel writes the leading form',
      by['panel output'].value.startsWith('perspective('),
      by['panel output'].value
    );
    check('which the browser resolves to a 3D matrix', /^matrix3d\(/.test(by['panel output'].computed), by['panel output'].computed);
    // Every layer hidden but a perspective set: still a live declaration.
    check('a perspective with every layer hidden still applies', /^matrix3d\(/.test(by['all hidden'].computed), by['all hidden'].computed);
    check('and the hidden layer is still in the text', by['all hidden'].value.includes('rotateZ(45deg)'), by['all hidden'].value);
    // And with no perspective, the placeholder keeps the comment alive.
    check('with no perspective the placeholder holds the declaration open', by['all hidden, no perspective'].kept !== '', by['all hidden, no perspective'].value);
    check('and applies nothing', by['all hidden, no perspective'].computed === 'none', by['all hidden, no perspective'].computed);
    // The origins land where they say.
    check('the origin lands where the pad says', by.origin.computed === '0px 100px', by.origin.computed);
    check('a z origin survives to the browser', by['origin with z'].computed === '0px 100px 20px', by['origin with z'].computed);
    check('and the perspective origin too', by['perspective origin'].computed === '0px 100px', by['perspective origin'].computed);
  }

  if (failures.length) {
    console.error(`transform-settings: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`transform-settings: ${checked} passed  [origin, self vs children perspective, in a real browser]`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
