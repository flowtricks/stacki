// The prop that chooses the branch offers every branch.
//
//   node test/variant-options.js
//
// A button's Props is a union: a play control has `pressed`, an arrow control
// has `direction`, and the close and arrow branches say `pressed?: never`.
//
// Select a paused play button — variant="play" pressed — and the variant list
// offered main and play, and nothing else. `pressed` is set, so the two
// branches that forbid it were ruled out, and their variants went with them.
// There was no way to turn that button into a close button, and nothing on
// screen said why: the markup was correct and the panel simply did not offer
// the switch.
//
// The props a branch allows are its CONSEQUENCES, not its conditions. The
// panel already knows how to change branch — setPropCascading clears what the
// new branch forbids and hands it back if you switch in again — so the only
// thing missing was the offer.
//
// The narrowing this comes from is real and stays: `emphasis` is primary,
// secondary or link on a main button and only the first two elsewhere. The
// difference is that emphasis names no branch (primary is allowed on all four
// variants), while a variant names exactly one — which is what makes it the
// prop you change the branch WITH.

const fs = require('fs');
const path = require('path');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
};

// The shape from the report, trimmed to the props it turns on.
const BUTTON = [
  '---',
  'type Emphasis = "primary" | "secondary";',
  'type Kind =',
  '  | {',
  '      variant?: "main";',
  '      emphasis?: Emphasis | "link";',
  '      label?: never;',
  '      direction?: never;',
  '    }',
  '  | {',
  '      variant: "play";',
  '      emphasis?: Emphasis;',
  '      label?: string;',
  '      /** Whether it is playing. Defaults to `false`. */',
  '      pressed?: boolean;',
  '      direction?: never;',
  '    }',
  '  | {',
  '      variant: "close";',
  '      emphasis?: Emphasis;',
  '      label?: string;',
  '      pressed?: never;',
  '      direction?: never;',
  '    }',
  '  | {',
  '      variant: "arrow";',
  '      emphasis?: Emphasis;',
  '      label?: string;',
  '      pressed?: never;',
  '      /** Which way the arrow points. Defaults to `forward`. */',
  '      direction?: "forward" | "back";',
  '    };',
  'type Props = { render?: boolean } & Kind;',
  'const { variant, emphasis, label, pressed, direction } = Astro.props;',
  '---',
  '<button>{variant}{emphasis}{label}{pressed}{direction}</button>',
].join('\n');

(async () => {
  const esbuild = require('esbuild');
  const buildDir = path.join(__dirname, '..', 'node_modules', '.stacki-test');
  fs.mkdirSync(buildDir, { recursive: true });
  const bundle = path.join(buildDir, 'variant-options.bundle.js');
  await esbuild.build({
    entryPoints: [path.join(__dirname, '..', 'src', 'panels', 'PropsPanel.jsx')],
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
  global.window = dom.window;
  global.document = dom.window.document;
  global.navigator = dom.window.navigator;
  global.MutationObserver = dom.window.MutationObserver;
  global.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  global.DOMRect = dom.window.DOMRect;
  global.Element = dom.window.Element;
  global.HTMLElement = dom.window.HTMLElement;
  global.Node = dom.window.Node;
  global.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
  global.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
  global.IS_REACT_ACT_ENVIRONMENT = true;
  dom.window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  global.ResizeObserver = dom.window.ResizeObserver;
  dom.window.Range.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 });
  dom.window.Range.prototype.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: function* () {} });

  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { act } = React;
  const PropsPanel = require(bundle).default;
  const { parsePropSchema } = require('../electron/astroParser.js');

  const parsed = parsePropSchema(BUTTON);
  const schema = Array.isArray(parsed) ? parsed : [...parsed.values()];

  check('the component parses as a union', !!schema.find((f) => f.unions), JSON.stringify(schema.map((f) => f.name)));
  check(
    'and variant knows all four values',
    (schema.find((f) => f.name === 'variant')?.options || []).join() === 'main,play,close,arrow',
    JSON.stringify(schema.find((f) => f.name === 'variant')?.options)
  );

  const str = (value) => ({ type: 'string', value });
  const mount = async (props) => {
    const host = dom.window.document.getElementById('root');
    const root = createRoot(host);
    const written = [];
    await act(async () => {
      root.render(
        React.createElement(PropsPanel, {
          node: { id: 'n1', kind: 'component', name: 'Button', props, children: [] },
          schema,
          projectPath: '/p',
          filePath: '/p/src/pages/index.astro',
          onSetProp: (name, value) => written.push({ [name]: value }),
          onSetProps: (_id, patch) => written.push(patch),
          onRenameProp: () => {},
          onOpenCode: () => {},
          onSetText: () => {},
        })
      );
    });
    // The field for one prop, whichever control it drew: the row is labelled
    // with the prop's name.
    const fieldFor = (name) =>
      [...host.querySelectorAll('.props-field')].find((f) =>
        [...f.querySelectorAll('.props-label, label, .props-label-text')].some(
          (l) => l.textContent.trim().replace(/\s+\{\}$/, '') === name
        )
      );
    // What that field is offering, from either control it can be: a two-value
    // switch draws its options as buttons, a longer list opens a dropdown.
    const offered = async (name) => {
      const field = fieldFor(name);
      if (!field) return null;
      const seg = [...field.querySelectorAll('.props-seg-btn, .seg-btn, button[data-value]')];
      if (seg.length) return seg.map((b) => b.textContent.trim());
      const trigger = field.querySelector('.dd-trigger');
      if (!trigger) return null;
      await act(async () => {
        trigger.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
      });
      const list = [...dom.window.document.querySelectorAll('.dd-option-label')].map((o) =>
        o.textContent.trim()
      );
      await act(async () => {
        dom.window.document.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true }));
      });
      return list;
    };
    return { host, written, fieldFor, offered, done: async () => { await act(async () => root.unmount()) } };
  };

  // --- the report ---------------------------------------------------------------
  //
  // A paused play button: variant="play", pressed set. The close and arrow
  // branches both say `pressed?: never`.
  {
    const m = await mount({ variant: str('play'), pressed: { type: 'expr', value: 'true' } });
    const list = await m.offered('variant');
    check('the variant field is there', list !== null, m.host.textContent.slice(0, 200));
    for (const v of ['main', 'play', 'close', 'arrow']) {
      check(`a paused play button is still offered ${v}`, (list || []).includes(v), JSON.stringify(list));
    }
    await m.done();
  }

  // The same button with nothing else set — the list can only have been
  // narrowed by `pressed`, so this is the control.
  {
    const m = await mount({ variant: str('play') });
    const list = await m.offered('variant');
    check('and so is one that is not pressed', (list || []).length === 4, JSON.stringify(list));
    await m.done();
  }

  // An arrow button, whose branch forbids `pressed` — the same list from the
  // other side.
  {
    const m = await mount({ variant: str('arrow'), direction: str('back') });
    const list = await m.offered('variant');
    check('an arrow button offers every variant too', (list || []).length === 4, JSON.stringify(list));
    await m.done();
  }

  // --- what narrowing is still for ----------------------------------------------
  //
  // emphasis is pinned by every branch as well, but its sets overlap — primary
  // is allowed on all four variants — so choosing one settles nothing, and the
  // branch in force is what says which are available.
  {
    const m = await mount({ variant: str('play') });
    const list = await m.offered('emphasis');
    check('a play button is not offered link', !(list || []).includes('link'), JSON.stringify(list));
    check('but is offered the two it has', (list || []).length === 2, JSON.stringify(list));
    await m.done();
  }
  {
    const m = await mount({ variant: str('main') });
    const list = await m.offered('emphasis');
    check('a main button is offered link', (list || []).includes('link'), JSON.stringify(list));
    await m.done();
  }

  // --- and the switch it makes ---------------------------------------------------
  //
  // Offering close on a pressed button is only honest if picking it writes
  // markup the component accepts. It does: the props the new branch forbids go
  // in the same edit.
  {
    const m = await mount({ variant: str('play'), pressed: { type: 'expr', value: 'true' } });
    const field = m.fieldFor('variant');
    const trigger = field?.querySelector('.dd-trigger');
    if (!trigger) {
      check('picking close clears pressed', false, 'no variant dropdown to open');
    } else {
      await act(async () => {
        trigger.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
      });
      const close = [...dom.window.document.querySelectorAll('.dd-option-label')].find(
        (o) => o.textContent.trim() === 'close'
      );
      if (!close) {
        check('picking close clears pressed', false, 'close was not in the list');
      } else {
        await act(async () => {
          close.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
        });
        const patch = m.written[m.written.length - 1] || {};
        check('picking close writes close', patch.variant?.value === 'close', JSON.stringify(patch));
        check(
          'and takes pressed with it, in the same edit',
          'pressed' in patch && patch.pressed === undefined,
          JSON.stringify(patch)
        );
      }
    }
    await m.done();
  }

  // --- the rule, stated where it lives -------------------------------------------
  const panel = fs.readFileSync(path.join(__dirname, '..', 'src', 'panels', 'PropsPanel.jsx'), 'utf8');
  check(
    'narrowing asks whether the prop chooses the branch',
    /choosesBranch\(union, field\.name\)/.test(panel),
    'narrowOptions no longer excuses the discriminant'
  );
  check(
    'and a prop pinned by one branch alone does not count as choosing',
    /pinning > 1/.test(panel),
    'a single pinned branch would make direction a chooser'
  );

  if (failures.length) {
    console.error(`\nvariant-options: ${failures.length} failed, ${checked - failures.length} passed\n`);
    console.error(failures.join('\n') + '\n');
    process.exit(1);
  }
  console.log(`variant-options: ${checked} passed  [the prop that chooses the branch]`);
  process.exit(0);
})();
