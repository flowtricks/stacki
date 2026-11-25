// Goal: what the canvas script (electron/preload/frame*.ts, the half that runs
// inside the preview frame) spends on a large page, per thing that happens to
// it. A measurement, not a test: it asserts nothing about speed, and prints a
// table to compare before and after a change.
// Method: generate a marked page — sections of cards, every element marked
// with its own node path as the dev server marks them — at 500 and 2 000
// marked elements, load it into jsdom with constant boxes (jsdom has no
// layout), and load the built preload into it as hoverCost.test.js does. Then,
// one operation at a time, trigger it and wait past the preload's own settle
// (120 ms) and frame, counting what it did: querySelectorAll calls (the
// `[data-avb-p]` ones are whole-page walks), getComputedStyle calls, messages
// posted to the app, synchronous time for the trigger itself, and CPU time
// over the whole window. jsdom's milliseconds are not Chromium's; the counts
// are the robust signal, and before/after on one machine is the comparison.
// Run: npm run bench:canvas (after npm run build:runtime).

const Module = require('node:module');
const { performance } = require('node:perf_hooks');
const { repoPath } = require('../helpers/sources.js');

const SIZES = [500, 2000];
const SAMPLES = 8;
const WARM_UPS = 2;
const SETTLE_MS = 400;
const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const marked = (nodePath, html) => `<!--avb-s:${nodePath}-->${html}<!--avb-e:${nodePath}-->`;

// Sections of cards; each card is four marked elements, each section one more.
function pageOf(elements) {
  const cardsPerSection = 20;
  const sections = Math.ceil(elements / (cardsPerSection * 4 + 1));
  const parts = [];
  for (let section = 0; section < sections; section += 1) {
    const cards = [];
    for (let card = 0; card < cardsPerSection; card += 1) {
      const at = `${section}.${card}`;
      const inner =
        marked(`${at}.0`, `<h3 class="card_title">Card ${card}</h3>`) +
        marked(`${at}.1`, `<p class="card_text">Text ${card}</p>`) +
        marked(`${at}.2`, `<a class="card_link" href="#">Link</a>`);
      cards.push(marked(at, `<article class="card is-${card % 3}">${inner}</article>`));
    }
    parts.push(marked(String(section), `<section class="section">${cards.join('')}</section>`));
  }
  const body = `${parts.join('')}<div id="other"></div>`;
  return `<!doctype html><html><head></head><body>${body}</body></html>`;
}

function install(window) {
  const box = { x: 10, y: 10, width: 200, height: 40, left: 10, top: 10, right: 210, bottom: 50 };
  window.Element.prototype.getBoundingClientRect = () => box;
  window.Range.prototype.getBoundingClientRect = () => box;
  for (const name of ['window', 'document', 'location', 'navigator']) {
    global[name] = name === 'window' ? window : window[name];
  }
  // The DOM jsdom builds has no hit testing and only some CSSOM rule classes:
  // the pointer lands on whatever element the bench dispatches on, and the
  // missing rule classes match nothing.
  window.document.elementFromPoint = () => window.__pointed;
  for (const rule of ['CSSGroupingRule', 'CSSMediaRule', 'CSSSupportsRule', 'CSSStyleRule']) {
    global[rule] = window[rule] ?? class {};
  }
  global.MutationObserver = window.MutationObserver;
  global.Element = window.Element;
  global.Node = window.Node;
  global.MouseEvent = window.MouseEvent;
  global.requestAnimationFrame = window.requestAnimationFrame.bind(window);
}

// Counters the operations are measured with, installed before the preload.
function instrument(window) {
  const counts = { qsa: 0, pageWalks: 0, computed: 0, messages: 0 };
  const queryAll = window.Document.prototype.querySelectorAll;
  window.Document.prototype.querySelectorAll = function (selector) {
    counts.qsa += 1;
    if (String(selector).includes('[data-avb-p]')) {
      counts.pageWalks += 1;
    }
    return queryAll.call(this, selector);
  };
  const computedStyle = window.getComputedStyle.bind(window);
  window.getComputedStyle = (...args) => {
    counts.computed += 1;
    return computedStyle(...args);
  };
  global.getComputedStyle = window.getComputedStyle;
  window.parent = { postMessage: () => (counts.messages += 1) };
  return counts;
}

function loadPreload() {
  const electron = {
    contextBridge: { exposeInMainWorld: () => {} },
    ipcRenderer: { on: () => {}, send: () => {}, invoke: async () => {} },
    webUtils: {},
  };
  const realRequire = Module.prototype.require;
  Module.prototype.require = function (id) {
    return id === 'electron' ? electron : realRequire.apply(this, arguments);
  };
  process.isMainFrame = false;
  const file = repoPath('dist/electron/preload/preload.js');
  delete require.cache[file];
  require(file);
  Module.prototype.require = realRequire;
}

// The operations, each a function of the sample number so no two samples are
// the same no-op (an attribute set to the value it has records nothing).
function operations(window) {
  const document = window.document;
  const post = (data) => {
    const event = new window.MessageEvent('message', { data });
    Object.defineProperty(event, 'source', { value: window.parent });
    window.dispatchEvent(event);
  };
  const deep = () => document.querySelectorAll('.card_link');
  return [
    ['attribute on an unmarked element', (sample) => document.getElementById('other').setAttribute('data-n', sample)],
    ['class on a marked element', (sample) => deep()[sample % 50].classList.toggle('is-open')],
    ['inline style on a marked element', (sample) => (deep()[sample % 50].style.transform = `translateX(${sample}px)`)],
    ['style-panel probe (compute a colour)', (sample) => post({ type: 'avb:query', id: sample, compute: [`rgb(${sample}, 0, 0)`] })],
    ['set-vh', (sample) => post({ type: 'avb:set-vh', px: 700 + sample })],
    [
      'hover (pointer moves to a node)',
      (sample) => {
        const target = deep()[sample % 200];
        window.__pointed = target;
        target.dispatchEvent(new window.MouseEvent('mousemove', { bubbles: true, clientX: 20, clientY: 20 }));
      },
    ],
    [
      'track a hovered node',
      (sample) =>
        post({
          type: 'avb:track',
          paths: [`${sample % 5}.${sample % 20}.2`],
          scope: '',
          focus: '',
          focusOcc: 0,
        }),
    ],
    ['scroll', () => window.dispatchEvent(new window.Event('scroll'))],
  ];
}

const percentile = (values, rank) => {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil((rank / 100) * sorted.length) - 1)];
};

async function measure(counts, run, sample) {
  const before = { ...counts };
  const cpuBefore = process.cpuUsage();
  const started = performance.now();
  run(sample);
  const syncMs = performance.now() - started;
  await settle(SETTLE_MS);
  const cpu = process.cpuUsage(cpuBefore);
  const delta = (key) => counts[key] - before[key];
  return {
    syncMs,
    cpuMs: (cpu.user + cpu.system) / 1000,
    qsa: delta('qsa'),
    pageWalks: delta('pageWalks'),
    computed: delta('computed'),
    messages: delta('messages'),
  };
}

async function benchSize(elements) {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM(pageOf(elements), {
    url: 'http://localhost:4321/#avb-design',
    pretendToBeVisual: true,
  });
  install(dom.window);
  const counts = instrument(dom.window);
  loadPreload();
  await settle(500);
  const rows = [];
  for (const [label, run] of operations(dom.window)) {
    const samples = [];
    for (let index = 0; index < WARM_UPS + SAMPLES; index += 1) {
      const sample = await measure(counts, run, index + 1);
      if (index >= WARM_UPS) {
        samples.push(sample);
      }
    }
    const mean = (key) => samples.reduce((sum, sample) => sum + sample[key], 0) / samples.length;
    rows.push({
      label,
      sync: percentile(
        samples.map((sample) => sample.syncMs),
        50,
      ),
      cpu: percentile(
        samples.map((sample) => sample.cpuMs),
        50,
      ),
      qsa: mean('qsa'),
      walks: mean('pageWalks'),
      computed: mean('computed'),
      messages: mean('messages'),
    });
  }
  dom.window.close();
  return rows;
}

async function main() {
  const marks = (elements) => `${elements} marked`;
  console.log('Canvas script cost per operation, jsdom; p50 of ' + `${SAMPLES} samples after ${WARM_UPS} warm-ups, counts are means per operation.`);
  for (const elements of SIZES) {
    const rows = await benchSize(elements);
    console.log(`\n${marks(elements)}`);
    console.log('operation                              sync ms  cpu ms  qsa    walks  computed  messages');
    for (const row of rows) {
      console.log(
        `${row.label.padEnd(39)}${row.sync.toFixed(1).padStart(7)}` +
          `${row.cpu.toFixed(0).padStart(8)}` +
          `${row.qsa.toFixed(1).padStart(7)}${row.walks.toFixed(1).padStart(7)}` +
          `${row.computed.toFixed(0).padStart(10)}${row.messages.toFixed(1).padStart(10)}`,
      );
    }
  }
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
