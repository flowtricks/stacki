// Goal: every keyword control of the style panel (the Align X / Y dropdowns, the
// Display, Direction, Wrap-style segmented bars, Float, Overflow, grid content and
// flow, the two-segment bars) can be connected to a variable the way a typed field
// can, and shows a variable as the purple chip, never as raw `var(--…)` text.
//
//   node test/renderer/style/keywordVariables.test.js
//
// Method: one table, one row per control, each mounted on its own in jsdom with a
// stubbed variable catalog (one String variable, one Size variable). For every row:
//   1. value `var(--stack-align)` draws a chip, and no text the person reads says `var(`;
//   2. a keyword value draws no chip, and the connect dot is there for hover;
//   3. pressing the dot opens the variable picker, and picking a row writes
//      exactly `var(--name)` as the property's whole value;
//   4. the open list or menu offers "Variable…" first, and choosing it opens the picker;
//   5. from the variable, choosing a keyword from the list disconnects it (the write
//      is the keyword, with no `var(` left).
// The coverage half of the audit (every input file is registered) lives in
// keywordVariablesCoverage.test.js.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { repoPath, stubSources } = require('../../helpers/sources.js');

const VARIABLE_VALUE = 'var(--stack-align)';
const VARIABLE_ENTRY = 'Variable…';

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked += 1;
  if (!condition) {
    failures.push(`  ${what}${detail === undefined ? '' : `\n    ${detail}`}`);
  }
};

(async () => {
  const esbuild = require('esbuild');
  const buildDirectory = repoPath('node_modules/.stacki-test');
  fs.mkdirSync(buildDirectory, { recursive: true });
  const entry = path.join(buildDirectory, 'keyword-variables.entry.jsx');
  const exportsOf = [
    ['default as AlignControl', 'src/features/style/AlignControl.tsx'],
    ['default as DisplayControl', 'src/features/style/DisplayControl.tsx'],
    ['default as DirectionControl', 'src/features/style/DirectionControl.tsx'],
    ['default as SegmentedField', 'src/features/style/SegmentedField.tsx'],
    ['SegBar', 'src/features/style/TypographyKit.tsx'],
    ['SegmentBar', 'src/features/style/SizeSegmentBar.tsx'],
    ['SegmentedIconControl', 'src/features/style/PositionSegments.tsx'],
    ['GridContentControl, GridDirectionControl', 'src/features/style/GridFlowControls.tsx'],
    ['KeywordSegments', 'src/features/style/KeywordConnect.tsx'],
  ];
  fs.writeFileSync(entry, exportsOf.map(([names, file]) => `export { ${names} } from ${JSON.stringify(repoPath(file))};\n`).join(''));
  const bundlePath = path.join(buildDirectory, 'keyword-variables.bundle.js');
  await esbuild.build({
    entryPoints: [entry],
    outfile: bundlePath,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
    loader: { '.tsx': 'tsx', '.ts': 'ts', '.jsx': 'jsx', '.css': 'empty' },
    logLevel: 'silent',
    plugins: [
      // No project here: the catalog is two variables, a keyword one (String, which the
      // keyword properties take) and a length one (Size, which order / flex take). The rest
      // of the module is the real one; only its variable stream is replaced.
      stubSources('stub-variables', {
        'src/features/style/model/webflow.ts': (file) => {
          const real = fs.readFileSync(file, 'utf8');
          const marker = 'streamProjectVariables, ';
          assert.ok(real.includes(marker), 'webflow.ts re-exports the variable stream');
          return {
            contents:
              real.replace(marker, '') +
              `
            export async function streamProjectVariables(onAdd) {
              onAdd({ name: 'stack-align', collection: 'Layout', group: '', value: 'center', binding: 'var(--stack-align)', type: 'String' });
              onAdd({ name: 'stack-size', collection: 'Layout', group: '', value: '2', binding: 'var(--stack-size)', type: 'Size' });
              return [];
            }
          `,
            loader: 'ts',
            resolveDir: path.dirname(file),
          };
        },
      }),
    ],
  });

  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/', pretendToBeVisual: true });
  require('../../helpers/popupDom').installPopupDOM(dom.window);
  global.window = dom.window;
  global.document = dom.window.document;
  global.navigator = dom.window.navigator;
  global.Element = dom.window.Element;
  global.HTMLElement = dom.window.HTMLElement;
  global.Node = dom.window.Node;
  global.getComputedStyle = dom.window.getComputedStyle;
  global.MutationObserver = dom.window.MutationObserver;
  global.requestAnimationFrame = (callback) => setTimeout(callback, 0);
  global.cancelAnimationFrame = clearTimeout;
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  dom.window.ResizeObserver = global.ResizeObserver;
  global.IS_REACT_ACT_ENVIRONMENT = true;

  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { act } = React;
  const controls = require(bundlePath);
  const create = React.createElement;
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  const press = (element) => {
    element.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    element.dispatchEvent(new dom.window.MouseEvent('mouseup', { bubbles: true }));
    element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  };

  const noop = () => undefined;
  const read = () => undefined;
  // The table: how to mount each control on a value, how its list or menu opens, and
  // the keyword it shows when not connected. `write` receives every value written.
  const rows = [
    {
      name: 'Align X (justify-content dropdown)',
      keyword: 'center',
      list: 'select',
      mount: (value, write) =>
        create(controls.AlignControl, {
          justify: value,
          align: 'stretch',
          column: false,
          busy: false,
          read,
          onSet: (prop, next) => (prop === 'justify-content' ? write(next) : undefined),
          onLive: noop,
          onClear: noop,
          onProvenance: noop,
          onSelectSelector: noop,
        }),
      scope: (host) => host.querySelector('.embed-editor_align-axis'),
    },
    {
      name: 'Display bar',
      keyword: 'flex',
      list: 'menu',
      mount: (value, write) => create(controls.DisplayControl, { value, important: false, busy: false, onCommit: (next) => write(next) }),
    },
    {
      name: 'Direction bar',
      keyword: 'row',
      list: 'direction-menu',
      mount: (value, write) =>
        create(controls.DirectionControl, {
          value: value.startsWith('var(') ? 'row' : value,
          rawDirection: value,
          important: false,
          busy: false,
          onCommit: (direction) => write(direction),
          onCommitCustom: (next) => write(next),
        }),
    },
    {
      name: 'Pointer events bar (SegmentedField)',
      keyword: 'auto',
      list: 'menu',
      mount: (value, write) =>
        create(controls.SegmentedField, {
          value,
          important: false,
          options: [
            { value: 'auto', label: 'Auto', menuLabel: 'Auto' },
            { value: 'none', label: 'None', menuLabel: 'None' },
          ],
          prop: 'pointer-events',
          fallback: 'auto',
          busy: false,
          ariaLabel: 'Pointer events',
          onCommit: (next) => write(next),
        }),
    },
    {
      name: 'Align self bar (SegBar)',
      keyword: 'center',
      list: 'menu',
      mount: (value, write) =>
        create(controls.SegBar, {
          segs: [
            { value: 'flex-start', icon: 'S', label: 'Start' },
            { value: 'center', icon: 'C', label: 'Center' },
          ],
          current: value,
          ariaLabel: 'Align self',
          prop: 'align-self',
          busy: false,
          onCommit: (next) => write(next),
          onLiveCommit: noop,
          onClear: noop,
        }),
    },
    {
      name: 'Overflow bar (SegmentBar)',
      keyword: 'hidden',
      list: 'menu',
      mount: (value, write) =>
        create(controls.SegmentBar, {
          prop: 'overflow',
          config: {
            segments: [
              { value: 'visible', content: 'V', ariaLabel: 'Visible', menuLabel: 'Visible' },
              { value: 'hidden', content: 'H', ariaLabel: 'Hidden', menuLabel: 'Hidden' },
            ],
            fallback: 'visible',
            tooltips: {},
            groupLabel: 'Overflow',
            moreLabel: 'More',
            customLabel: 'Custom overflow',
          },
          value,
          busy: false,
          onCommit: (next) => write(next),
          onLiveCommit: noop,
          onClear: noop,
        }),
    },
    {
      name: 'Float bar (SegmentedIconControl)',
      keyword: 'left',
      list: 'menu',
      mount: (value, write) =>
        create(controls.SegmentedIconControl, {
          prop: 'float',
          ariaLabel: 'Float',
          segments: [
            { value: 'none', icon: 'N', label: 'None' },
            { value: 'left', icon: 'L', label: 'Left' },
          ],
          current: value,
          read,
          busy: false,
          setProp: (prop, next) => write(next),
          clearProp: noop,
          liveSetProp: noop,
          onProvenance: noop,
          onSelectSelector: noop,
        }),
    },
    {
      name: 'Grid columns content bar',
      keyword: 'center',
      list: 'menu',
      mount: (value, write) =>
        create(controls.GridContentControl, {
          value,
          prop: 'justify-content',
          vertical: false,
          ariaLabel: 'Columns',
          busy: false,
          onSet: (next) => write(next),
          onCommitCustom: (next) => write(next),
        }),
    },
    {
      name: 'Grid direction bar',
      keyword: 'row',
      list: 'menu',
      mount: (value, write) =>
        create(controls.GridDirectionControl, { value, busy: false, onSet: (next) => write(next), onCommitCustom: (next) => write(next) }),
    },
    {
      name: 'Truncate bar (KeywordSegments)',
      keyword: 'clip',
      list: 'none',
      mount: (value, write) =>
        create(
          controls.KeywordSegments,
          { prop: 'text-overflow', value, important: false, ariaLabel: 'Truncate', busy: false, onWrite: (next) => write(next), onClear: () => write('') },
          create('button', { type: 'button', role: 'radio', 'aria-checked': true, onClick: () => write('ellipsis') }, 'Clip'),
        ),
    },
  ];

  const mount = async (row, value) => {
    const host = document.createElement('div');
    host.className = 'embed-editor_root';
    document.body.appendChild(host);
    const root = createRoot(host);
    const writes = [];
    await act(async () => {
      root.render(row.mount(value, (next) => writes.push(next)));
      await settle();
    });
    const scope = row.scope === undefined ? host : row.scope(host);
    const done = async () => {
      await act(async () => root.unmount());
      host.remove();
    };
    return { host, scope, writes, done };
  };

  // What the person reads: every text node outside a form field's own value.
  const readText = (element) => element.textContent ?? '';

  const openList = async (row, scope) => {
    const opener =
      row.list === 'select'
        ? (scope.querySelector('.u-select-chevron-btn') ?? scope.querySelector('.u-select-button'))
        : (scope.querySelector('.embed-editor_display-arrow') ?? undefined);
    assert.ok(opener, `${row.name}: the list opener exists`);
    await act(async () => {
      opener.click();
      await settle();
    });
  };
  const listEntries = () =>
    [...document.querySelectorAll('.u-select-option, .embed-editor_display-menu-item, .embed-editor_direction-item')].map((element) => ({
      element,
      text: element.textContent.trim(),
    }));
  const pickFirstVariable = async () => {
    const item = document.querySelector('.embed-editor_varpicker-item');
    assert.ok(item, 'the variable picker lists a variable');
    await act(async () => {
      press(item);
      await settle();
    });
  };

  for (const row of rows) {
    // 1. A variable is a chip, never raw text.
    {
      const { scope, done } = await mount(row, VARIABLE_VALUE);
      await act(settle);
      check(`${row.name}: a variable draws the purple chip`, scope.querySelector('.embed-editor_varconnect-token') !== null);
      check(`${row.name}: no text reads var(`, !readText(scope).includes('var('), readText(scope));
      // A field holding the text is fine only when the token editor covers it (is-token).
      const rawFields = [...scope.querySelectorAll('input')].filter((input) => input.value.includes('var(') && input.closest('.is-token') === null);
      check(`${row.name}: no field shows var( as raw text`, rawFields.length === 0, rawFields.map((input) => input.value).join(', '));
      await done();
    }
    // 2. A keyword stays a keyword, with the connect dot ready for hover.
    {
      const { scope, done } = await mount(row, row.keyword);
      check(`${row.name}: a keyword draws no chip`, scope.querySelector('.embed-editor_varconnect-token') === null);
      check(
        `${row.name}: the connect dot is there on hover`,
        scope.querySelector('.embed-editor_varconnect.is-keyword > .embed-editor_varconnect-dot') !== null,
      );
      await done();
    }
    // 3. The dot opens the picker; a pick writes the binding as the whole value.
    {
      const { scope, writes, done } = await mount(row, row.keyword);
      const dot = scope.querySelector('.embed-editor_varconnect-dot');
      check(`${row.name}: the dot exists to press`, dot !== null);
      if (dot !== null) {
        await act(async () => {
          press(dot);
          await settle();
        });
        check(`${row.name}: the dot opens the variable picker`, document.querySelector('.embed-editor_varpicker') !== null);
        await pickFirstVariable();
        check(`${row.name}: the pick writes one value`, writes.length === 1, JSON.stringify(writes));
        check(`${row.name}: the write is a bare var() reference`, /^var\(--[a-z-]+\)$/.test(writes[0] ?? ''), JSON.stringify(writes));
        check(`${row.name}: the picker closes after the pick`, document.querySelector('.embed-editor_varpicker') === null);
      }
      await done();
    }
    if (row.list === 'none') {
      continue;
    }
    // 4. The list offers "Variable…" first, and it opens the picker.
    {
      const { scope, writes, done } = await mount(row, row.keyword);
      await openList(row, scope);
      const entries = listEntries();
      check(`${row.name}: the list opens`, entries.length > 0);
      check(`${row.name}: "Variable…" is the first entry`, entries[0]?.text === VARIABLE_ENTRY, JSON.stringify(entries.map((each) => each.text)));
      if (entries[0]?.text === VARIABLE_ENTRY) {
        await act(async () => {
          entries[0].element.click();
          await settle();
        });
        check(`${row.name}: choosing "Variable…" opens the picker`, document.querySelector('.embed-editor_varpicker') !== null);
        check(`${row.name}: choosing "Variable…" writes nothing`, writes.length === 0, JSON.stringify(writes));
        await pickFirstVariable();
        check(`${row.name}: the pick from the list writes a var() reference`, /^var\(--[a-z-]+\)$/.test(writes[0] ?? ''), JSON.stringify(writes));
      }
      await done();
    }
    // 5. From the variable, a keyword from the list disconnects it.
    {
      const { scope, writes, done } = await mount(row, VARIABLE_VALUE);
      await openList(row, scope);
      const keyword = listEntries().find((each) => each.text !== VARIABLE_ENTRY && !/custom/i.test(each.text));
      check(`${row.name}: the list offers a keyword to go back to`, keyword !== undefined);
      if (keyword !== undefined) {
        await act(async () => {
          keyword.element.click();
          await settle();
        });
        check(`${row.name}: the keyword is written`, writes.length === 1, JSON.stringify(writes));
        check(`${row.name}: no var( is left in the write`, !(writes[0] ?? 'var(').includes('var('), JSON.stringify(writes));
      }
      await done();
    }
  }

  if (failures.length > 0) {
    console.error(`keyword-variables: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`keyword-variables: ${checked} passed  [${rows.length} controls]`);
  process.exit(0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
