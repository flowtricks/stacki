// Every declaration shows up somewhere in the panel.
//
//   node test/renderer/style/panelSections.test.js
//
// A rule holding `inset: 0` showed nothing for it. Not in Position, which is
// where `inset` sorts; not in Other properties, which is where everything the
// panel has no control for goes; nowhere. The declaration was in the file, the
// panel drew no row, and the only way to find out it was there was to read the
// CSS.
//
// A section's `order` is where a property SORTS when it is rendered. It was
// being read as a claim that it is rendered — and Position's controls ask for
// top, right, bottom and left one side at a time. They have never asked for the
// shorthand.
//
// So: a property with no control belongs in Other properties, where it can at
// least be read and changed as text. This checks both halves — the ones known
// to have no control land there, and no property is quietly claimed by a
// section that never draws it.

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { repoPath } = require('../../helpers/sources.js');

// Source folders nest a handful deep; a walk past this has met a cycle or a
// generated tree, and should stop loudly rather than recurse on.
const WALK_LIMITS = { directoryDepthMax: 32 };

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) {
    failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  }
};

(async () => {
  const esbuild = require('esbuild');
  const buildDirectory = repoPath('node_modules/.stacki-test');
  fs.mkdirSync(buildDirectory, { recursive: true });
  const out = path.join(buildDirectory, 'sections.bundle.js');
  await esbuild.build({
    entryPoints: [repoPath('src/features/style/model/sections.ts')],
    outfile: out,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    logLevel: 'silent',
  });
  const { sectionOf, groupDeclarations, groupProps } = require(out);

  // ── The one that was missing ──────────────────────────────────────────────
  const decls = [
    { prop: 'position', value: 'absolute' },
    { prop: 'inset', value: '0' },
    { prop: 'content', value: '""' },
  ];
  const groups = Object.fromEntries(
    groupDeclarations(decls).map((group) => [
      group.def.label,
      group.decls.map((declaration) => declaration.prop),
    ]),
  );
  check('inset is drawn', Object.values(groups).flat().includes('inset'), JSON.stringify(groups));
  check(
    'under Other properties, with the rest the panel has no control for',
    (groups['Other properties'] || []).join(',') === 'inset,content',
    JSON.stringify(groups),
  );
  check(
    'and Position still has what it does draw',
    (groups.Position || []).join(',') === 'position',
    JSON.stringify(groups),
  );
  check(
    'the same holds for the resolved model',
    groupProps(['inset', 'top']).some(
      (group) => group.def.id === 'other' && group.props.includes('inset'),
    ),
    JSON.stringify(groupProps(['inset', 'top']).map((group) => [group.def.id, group.props])),
  );

  // ── Shorthands with no control ────────────────────────────────────────────
  // Each of these has longhands that DO have controls; writing a control for
  // one is what takes it off the list.
  for (const [prop, longhand] of [
    ['inset', 'top'],
    ['grid-area', 'grid-column-start'],
    ['outline', 'outline-color'],
    ['border-top', 'border-top-width'],
    ['border-left', 'border-left-style'],
    ['columns', 'column-count'],
    ['column-rule', 'column-rule-width'],
  ]) {
    check(`${prop} goes to Other properties`, sectionOf(prop) === 'other', sectionOf(prop));
    check(
      `while ${longhand} keeps its section`,
      sectionOf(longhand) !== 'other',
      sectionOf(longhand),
    );
  }
  check('an unknown property still goes there too', sectionOf('--brand') === 'other');
  check(
    'and a property with a control does not',
    sectionOf('box-shadow') === 'effects',
    sectionOf('box-shadow'),
  );

  // Generated property names cannot be found as string literals. Mount their
  // actual controls, show each value and commit an edit before treating them as
  // covered. Dead adapters or a matching comment cannot satisfy these checks.
  await esbuild.build({
    entryPoints: {
      BordersSection: repoPath('src/features/style/BordersSection.tsx'),
      FlexChildSection: repoPath('src/features/style/FlexChildSection.tsx'),
    },
    outdir: path.join(buildDirectory, 'section-controls'),
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
    loader: { '.css': 'empty' },
    logLevel: 'silent',
  });
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    pretendToBeVisual: true,
    url: 'http://localhost/',
  });
  global.window = dom.window;
  for (const key of [
    'document',
    'navigator',
    'HTMLElement',
    'Element',
    'Node',
    'MutationObserver',
  ]) {
    global[key] = dom.window[key];
  }
  global.getComputedStyle = dom.window.getComputedStyle;
  global.requestAnimationFrame = (callback) => setTimeout(callback, 0);
  global.cancelAnimationFrame = clearTimeout;
  global.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  dom.window.ResizeObserver = global.ResizeObserver;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  const React = require('react');
  const { act } = React;
  const { createRoot } = require('react-dom/client');
  const root = createRoot(document.getElementById('root'));
  const BordersSection = require(
    path.join(buildDirectory, 'section-controls', 'BordersSection.js'),
  ).default;
  const FlexChildSection = require(
    path.join(buildDirectory, 'section-controls', 'FlexChildSection.js'),
  ).default;
  const declared = (value) => ({
    source: 'selected',
    overridden: false,
    contributors: [],
    winner: { selectorText: '.box', value, important: false },
    selectedValue: { value, important: false },
  });
  const values = {};
  const writes = [];
  let mountedComponent;
  const controlProps = {
    read: (prop) => (values[prop] === undefined ? undefined : declared(values[prop])),
    busy: false,
    setProp: (prop, value) => {
      writes.push([prop, value]);
      values[prop] = value;
      root.render(React.createElement(mountedComponent, controlProps));
    },
    liveSetProp: () => {},
    clearProp: () => {},
    onProvenance: () => {},
    onSelectSelector: () => {},
  };
  const dynamicControls = new Set();
  const render = async (Component) =>
    act(async () => {
      mountedComponent = Component;
      root.render(React.createElement(Component, controlProps));
    });
  const click = async (element) =>
    act(async () => {
      element.focus();
      element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });
  const inputFor = (label) => document.querySelector(`input[aria-label="${label}"]`);
  const commit = async (input, value) => {
    await act(async () => {
      input.focus();
    });
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(
        input,
        value,
      );
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
    await act(async () => {
      input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
  };
  for (const [i, side] of ['top', 'right', 'bottom', 'left'].entries()) {
    values[`border-${side}-width`] = `${i + 1}px`;
    values[`border-${side}-color`] = '#123456';
  }
  await render(BordersSection);
  for (const [i, side] of ['top', 'right', 'bottom', 'left'].entries()) {
    await click(
      document.querySelector(
        `button[aria-label="${side[0].toUpperCase() + side.slice(1)} border"]`,
      ),
    );
    for (const [facet, value, next] of [
      ['width', `${i + 1}px`, '9px'],
      ['color', '#123456', '#abcdef'],
    ]) {
      const prop = `border-${side}-${facet}`;
      const input = inputFor(`${side} border ${facet}`);
      check(`${prop} has a field showing its value`, input?.value === value, input?.value);
      if (input) {
        await commit(input, next);
        const written = writes.some(([property, value]) => property === prop && value === next);
        check(`${prop} can be edited through its side control`, written, JSON.stringify(writes));
        if (input && written) {
          dynamicControls.add(prop);
        }
      }
    }
  }
  Object.assign(values, {
    'grid-column-start': '2',
    'grid-column-end': '5',
    'grid-row-start': '3',
    'grid-row-end': '7',
  });
  await render(FlexChildSection);
  for (const [axis, start, end] of [
    ['column', '2', '5'],
    ['row', '3', '7'],
  ]) {
    for (const [position, value] of [
      ['start', start],
      ['end', end],
    ]) {
      const prop = `grid-${axis}-${position}`;
      const label =
        `${axis[0].toUpperCase() + axis.slice(1)} ` +
        `${position[0].toUpperCase() + position.slice(1)}`;
      const input = inputFor(label);
      check(`${prop} has a field showing its value`, input?.value === value, input?.value);
      if (input?.value === value) {
        dynamicControls.add(prop);
      }
    }
    await commit(inputFor(`${axis[0].toUpperCase() + axis.slice(1)} Start`), '4');
    check(
      `grid-${axis} placement can be edited`,
      writes.some(([property, value]) => property === `grid-${axis}` && value === `4 / ${end}`),
      JSON.stringify(writes),
    );
  }
  await act(async () => root.unmount());
  dom.window.close();

  // ── Nothing else is claimed and then dropped ──────────────────────────────
  // Every property a section sorts has to be one its controls actually read.
  // Static controls name the property they edit as a string; generated names
  // are covered by the mounted controls above.
  //
  // Heuristic in one direction only — a name that appears for another reason
  // (`inset` is also a box-shadow keyword) can hide a missing control, which is
  // why the list above is spelled out by hand as well.
  const panelDirectory = repoPath('src/features/style');
  const sectionsFile = repoPath('src/features/style/model/sections.ts');
  const sources = [];
  const walk = (directory, depth) => {
    assert.ok(depth <= WALK_LIMITS.directoryDepthMax, 'walk: depth limit');
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(file, depth + 1);
      } else if (/\.(tsx|ts)$/.test(entry.name) && file !== sectionsFile) {
        sources.push(fs.readFileSync(file, 'utf8'));
      }
    }
  };
  walk(panelDirectory, 0);
  const text = sources.join('\n');

  const sectionsSource = fs.readFileSync(sectionsFile, 'utf8');
  const ordered = [
    ...new Set(
      [...sectionsSource.matchAll(/order: \[([\s\S]*?)\]/g)].flatMap((match) =>
        [...match[1].matchAll(/'([^']+)'/g)].map((x) => x[1]),
      ),
    ),
  ];
  check('the sections name properties to sort', ordered.length > 40, `${ordered.length}`);

  const swallowed = ordered.filter(
    (prop) =>
      sectionOf(prop) !== 'other' &&
      !dynamicControls.has(prop) &&
      !text.includes(`'${prop}'`) &&
      !text.includes(`"${prop}"`),
  );
  check(
    'and every one of them is drawn by the section that claims it',
    swallowed.length === 0,
    `nothing renders: ${swallowed.join(', ')} — give it a control, or list it in NO_CONTROL`,
  );

  if (failures.length) {
    console.error(
      `\npanel-sections: ${failures.length} failed, ${checked - failures.length} passed\n`,
    );
    console.error(failures.join('\n') + '\n');
    process.exit(1);
  }
  console.log(`panel-sections: ${checked} passed  [nothing swallowed]`);
})();
