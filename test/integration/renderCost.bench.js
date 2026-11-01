// Goal: what one thing happening in the app costs React — how many commits it
// causes, how long App's render takes, and which panels re-render — for the
// things that happen most: a keystroke in a field, the pointer crossing a row
// of the navigator, one chunk of dev-server output, and the canvas reporting
// what it rendered. A measurement, not a test: it prints a table to compare
// before and after a change.
// Method: the real App in jsdom over the gesture harness's bridge
// (test/helpers/appGestures.js: real parse, a real document host), with every
// panel stubbed by a component that counts its renders and renders nothing.
// So "App ms" is App's own work, and the panel column says which panels a
// real app would have re-rendered. App sits in a React Profiler; each
// operation runs in its own act() scope and sums the commits it caused. A
// keystroke's save is a second row: its reply re-renders too. React runs in
// development mode here (act needs it), so absolute times are inflated; the
// commit and render counts are not.
// Run: npm run bench:render (after npm run build:runtime).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SAMPLES = 20;
const WARM_UPS = 2;
const SECTIONS = 20;
const CARDS = 5;
const saved = () => new Promise((resolve) => setTimeout(resolve, 450));

// About 400 nodes: sections of cards, and a 100-rule style block.
function pageOf() {
  const sections = [];
  for (let section = 0; section < SECTIONS; section += 1) {
    const cards = [];
    for (let card = 0; card < CARDS; card += 1) {
      cards.push(`    <article class="card"><h3>Card ${card}</h3><p>Text ${card}</p>` + `<a href="#">Read</a></article>`);
    }
    sections.push(`  <section class="section">\n${cards.join('\n')}\n  </section>`);
  }
  const rules = Array.from({ length: 100 }, (_, index) => `.rule-${index} { margin: ${index}px; }`);
  const style = `<style>\n${rules.join('\n')}\n</style>\n`;
  return `<main>\n  <h1>Heading</h1>\n${sections.join('\n')}\n</main>\n${style}`;
}

const percentile = (values, rank) => {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil((rank / 100) * sorted.length) - 1)];
};

// One operation, sampled: commits, App's render time, and the panels that
// re-rendered at least once (with how many renders, summed over samples).
async function sampleOperation(app, profile, run) {
  const commits = [];
  const durations = [];
  const panels = new Map();
  for (let index = 0; index < WARM_UPS + SAMPLES; index += 1) {
    const before = { ...global.__renders };
    profile.commits = 0;
    profile.duration = 0;
    await run(index, app);
    if (index < WARM_UPS) {
      continue;
    }
    commits.push(profile.commits);
    durations.push(profile.duration);
    for (const [name, renders] of Object.entries(global.__renders)) {
      const added = renders - (before[name] ?? 0);
      if (added > 0) {
        panels.set(name, (panels.get(name) ?? 0) + added);
      }
    }
  }
  return { commits, durations, panels };
}

function operations(emitLog) {
  const act = (app, body) => app.act(async () => body());
  const rendered = ['0', '0.0', '0.1'];
  return [
    ['keystroke in a content field', (index, app) => act(app, () => __panels.PropsPanel.onSetContent(`Heading ${index}`))],
    ['  its save (reply installed)', (_, app) => app.act(() => saved())],
    ['hover a navigator row', (index, app) => act(app, () => __panels.StructurePanel.onHoverNode(index % 2 ? undefined : 'n'))],
    ['one dev-server log chunk', (index, app) => act(app, () => emitLog(`[vite] page reload src/pages/index.astro (x${index})\n`))],
    ['canvas: rendered paths, same', (_, app) => act(app, () => __panels.PreviewPane.onRenderedPaths([...rendered]))],
    ['canvas: rendered paths, changed', (index, app) => act(app, () => __panels.PreviewPane.onRenderedPaths([...rendered, `1.${index}`]))],
    ['canvas: node classes, same', (_, app) => act(app, () => __panels.PreviewPane.onNodeClasses({ 0: ['section'] }))],
  ];
}

async function main() {
  const { mountApp, select, nodeAt } = require('../helpers/appGestures.js');
  const React = require('react');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-render-bench-'));
  fs.mkdirSync(path.join(root, 'src', 'pages'), { recursive: true });
  const file = path.join(root, 'src', 'pages', 'index.astro');
  fs.writeFileSync(file, pageOf());
  const scan = {
    pages: [{ name: 'index.astro', path: file, route: '/' }],
    components: [],
    layouts: [],
    pageFolders: [],
  };
  let emit = () => {};
  const profile = { commits: 0, duration: 0 };
  const onRender = (_id, _phase, actualDuration) => {
    profile.commits += 1;
    profile.duration += actualDuration;
  };
  const app = await mountApp(root, { scan }, 'render-bench', {
    bridge: {
      onDevLog: (listener) => {
        emit = listener;
        return () => {};
      },
    },
    wrap: (element) => React.createElement(React.Profiler, { id: 'app', onRender }, element),
  });
  try {
    await select(app, [0, 0]); // The <h1>: the field a keystroke types into.
    const hovered = nodeAt([0, 1]).id;
    const rows = [];
    for (const [label, run] of operations((chunk) => emit(chunk))) {
      const runWithId = (index, mounted) =>
        label.startsWith('hover') && index % 2 === 0 ? mounted.act(async () => __panels.StructurePanel.onHoverNode(hovered)) : run(index, mounted);
      rows.push([label, await sampleOperation(app, profile, runWithId)]);
    }
    report(rows);
  } finally {
    await app.unmount();
    fs.rmSync(root, { recursive: true, force: true });
  }
  process.exit(0);
}

function report(rows) {
  console.log(
    `React cost per operation, stubbed panels, ~400-node page; p50 / p95 of ${SAMPLES} ` +
      `samples after ${WARM_UPS} warm-ups. Panels: renders summed over the samples.`,
  );
  console.log('operation                          commits  App ms p50  App ms p95  panels re-rendered');
  for (const [label, sample] of rows) {
    const panels = [...sample.panels]
      .sort((left, right) => right[1] - left[1])
      .map(([name, renders]) => `${name} ${renders}`)
      .join(', ');
    console.log(
      `${label.padEnd(35)}${String(percentile(sample.commits, 50)).padStart(7)}` +
        `${percentile(sample.durations, 50).toFixed(1).padStart(12)}` +
        `${percentile(sample.durations, 95).toFixed(1).padStart(12)}  ${panels || '—'}`,
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
