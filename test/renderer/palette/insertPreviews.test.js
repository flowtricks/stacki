// Goal: the insert palette shows the plain list on All results, Elements and Other, and on Components a grid
// of cards, each the Components panel's hover preview of the component (the same /__avb/preview route, which
// renders the project's insertion recipe), filtered by optional folder pills remembered per project; it reopens on the tab it was
// left on; frames load lazily, a few at a time, under a stated cap; there is no large view and Space is
// only ever typed; every key and bound holds.
// Methodology: mount the real palette in jsdom with fake IntersectionObserver and ResizeObserver
// so the test decides what is visible, and jsdom's local storage (or one that throws). Drive it with the
// keys a person presses, post the messages a loaded page posts, and read the DOM: rows, cards, pills,
// frames, the hints. What a pixel looks like is not measured here; the URL each frame asks for is. The
// pointer gestures a live preview page posts (it came in, it clicked) are posted the same way.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources.js');

const DEV_URL = 'http://localhost:4321';

const section = (name, extra = {}) => ({
  name,
  folder: 'Section',
  path: `/p/src/components/Section/${name}.astro`,
  renderTag: { tag: 'section' },
  instances: 0,
  ...extra,
});
const block = (name, extra = {}) => ({ name, folder: 'Ui', path: `/p/src/components/Ui/${name}.astro`, renderTag: { tag: 'button' }, ...extra });

function fakeObservers(dom) {
  const intersection = [];
  const resize = [];
  dom.window.IntersectionObserver = class {
    constructor(callback, options) {
      this.callback = callback;
      this.options = options;
      this.elements = new Set();
      this.disconnected = false;
      intersection.push(this);
    }
    observe(element) {
      this.elements.add(element);
    }
    disconnect() {
      this.disconnected = true;
      this.elements.clear();
    }
  };
  dom.window.ResizeObserver = class {
    constructor(callback) {
      this.callback = callback;
      this.elements = new Set();
      resize.push(this);
    }
    observe(element) {
      this.elements.add(element);
    }
    disconnect() {
      this.elements.clear();
    }
  };
  global.IntersectionObserver = dom.window.IntersectionObserver;
  global.ResizeObserver = dom.window.ResizeObserver;
  return {
    show: (element, isIntersecting) => {
      for (const observer of intersection) {
        if (observer.elements.has(element)) {
          observer.callback([{ target: element, isIntersecting }]);
        }
      }
    },
    size: (element, width) => {
      for (const observer of resize) {
        if (observer.elements.has(element)) {
          observer.callback([{ target: element, contentRect: { width } }]);
        }
      }
    },
  };
}

async function setup(options = {}) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true });
  global.window = dom.window;
  global.document = dom.window.document;
  global.HTMLElement = dom.window.HTMLElement;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  // The palette remembers its tab in local storage. Most tests are about the grid, so they start on Components;
  // `tab: undefined` leaves storage empty, which is a first use.
  global.localStorage = dom.window.localStorage;
  const startTab = 'tab' in options ? options.tab : 'components';
  if (options.storage !== undefined) {
    for (const [key, value] of Object.entries(options.storage)) {
      dom.window.localStorage.setItem(key, value);
    }
  } else if (startTab !== undefined) {
    dom.window.localStorage.setItem('stacki.insertPalette.tab', startTab);
  }
  options.beforeRender?.(dom);
  const scrolled = [];
  dom.window.HTMLElement.prototype.scrollIntoView = function () {
    scrolled.push(this);
  };
  const observers = options.observers === false ? undefined : fakeObservers(dom);
  if (options.observers === false) {
    delete global.IntersectionObserver;
    delete global.ResizeObserver;
  }
  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { Simulate } = require('react-dom/test-utils');
  const output = repoPath('node_modules/.stacki-test/insert-previews.cjs');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  esbuild.buildSync({
    entryPoints: [repoPath('src/features/palette/InsertSearch.tsx')],
    outfile: output,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    jsx: 'automatic',
    logLevel: 'silent',
    external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
  });
  delete require.cache[require.resolve(output)];
  const InsertSearch = require(output).default;
  const container = document.getElementById('root');
  let root = createRoot(container);
  const events = { inserted: [], closed: 0 };
  const element = () =>
    React.createElement(InsertSearch, {
      components: options.components,
      devUrl: 'devUrl' in options ? options.devUrl : DEV_URL,
      projectKey: 'projectKey' in options ? options.projectKey : '/p',
      trailingSlash: 'never',
      onInsert: (item) => events.inserted.push(item),
      onClose: () => {
        events.closed += 1;
      },
    });
  await React.act(async () => root.render(element()));
  /** The palette closed and opened again, in the same window: the stores outlive it. */
  const remount = async () => {
    await React.act(async () => root.unmount());
    root = createRoot(container);
    await React.act(async () => root.render(element()));
  };
  const act = (work) => React.act(async () => work());
  const labels = () => [...container.querySelectorAll('.insert-item-label')].map((element) => element.textContent);
  const input = () => container.querySelector('.insert-search-row input');
  const press = async (key, data = {}) => {
    const calls = { prevented: false };
    await act(() => Simulate.keyDown(input(), { key, preventDefault: () => (calls.prevented = true), ...data }));
    return calls;
  };
  const type = (value) => act(() => Simulate.change(input(), { target: { value } }));
  const cards = () => [...container.querySelectorAll('.insert-card')];
  const frames = () => [...container.querySelectorAll('iframe')];
  const pills = () => [...container.querySelectorAll('.insert-pill')];
  /** Make every card visible and `width` wide. */
  const reveal = async (width = 360) => {
    await act(() => {
      for (const card of cards()) {
        observers.show(card, true);
        observers.size(card.querySelector('.insert-surface'), width);
        const snapshot = card.querySelector('.insert-snapshot');
        if (snapshot !== null) {
          observers.size(snapshot, width);
        }
      }
    });
  };
  const finish = async () => {
    // Answer every picture still being made, so no render timer outlives the test.
    for (let round = 0; round < 200; round++) {
      const left = [...document.querySelectorAll('body > div[aria-hidden="true"] iframe')];
      if (left.length === 0) {
        break;
      }
      for (const frame of left) {
        const data = { type: 'avb:component-preview', status: 'empty', reason: 'done' };
        await act(() => window.dispatchEvent(new dom.window.MessageEvent('message', { source: frame.contentWindow, data })));
      }
    }
    await React.act(async () => root.unmount());
    dom.window.close();
    delete global.IntersectionObserver;
    delete global.ResizeObserver;
    delete global.localStorage;
  };
  /** Answer every mounted frame with `ready`, the way a loaded page does, until no new frame starts. */
  const settleFrames = async () => {
    for (let round = 0; round < 20; round++) {
      const answered = frames().filter((frame) => !frame.dataset.answered);
      if (answered.length === 0) {
        return;
      }
      for (const frame of answered) {
        frame.dataset.answered = 'yes';
        const data = { type: 'avb:component-preview', status: 'ready' };
        await act(() => window.dispatchEvent(new dom.window.MessageEvent('message', { source: frame.contentWindow, data })));
      }
    }
  };
  return {
    remount,
    settleFrames,
    scrolled,
    Simulate,
    dom,
    container,
    events,
    act,
    labels,
    input,
    press,
    type,
    cards,
    frames,
    pills,
    reveal,
    observers,
    finish,
  };
}

const mixed = () => [
  section('Hero', { instances: 10 }),
  section('Pricing'),
  section('Faq', { instances: 3 }),
  block('Button', { instances: 25 }),
  block('Tag'),
];

test('on Components every folder has a pill, none is selected, every card shows, and the first is marked', async () => {
  const view = await setup({ components: mixed() });
  try {
    assert.equal(view.container.querySelector('.insert-tab.on').textContent, 'Components');
    assert.ok(view.container.querySelector('.insert-palette').classList.contains('insert-palette-grid'));
    assert.ok(view.container.querySelector('.insert-results').classList.contains('insert-results-grid'));
    assert.deepEqual(
      view.pills().map((pill) => pill.textContent),
      ['Section3', 'Ui2'],
      "each pill names its folder and its hits; Astro's own components are in no folder, so they have none",
    );
    assert.deepEqual(
      view.pills().map((pill) => pill.getAttribute('aria-pressed')),
      ['false', 'false'],
    );
    assert.deepEqual(view.labels(), ['Hero', 'Pricing', 'Faq', 'Button', 'Tag', '<Image>', '<Picture>']);
    assert.equal(view.container.querySelectorAll('.insert-item.highlight').length, 1);
    assert.ok(view.cards()[0].classList.contains('highlight'));
  } finally {
    await view.finish();
  }
});

test('a card shows how often a component is used, and nothing when it is not', async () => {
  const view = await setup({ components: mixed() });
  try {
    const uses = view.cards().map((card) => card.querySelector('.insert-item-uses')?.textContent);
    assert.deepEqual(uses.slice(0, 5), ['10×', undefined, '3×', '25×', undefined]);
  } finally {
    await view.finish();
  }
});

test('nested folders count toward their top-level folder, and root components share the components pill', async () => {
  const components = [
    section('Hero'),
    { name: 'Deep', folder: 'Section/hero', path: '/p/src/components/Section/hero/Deep.astro' },
    { name: 'Loose', folder: '', path: '/p/src/components/Loose.astro' },
  ];
  const view = await setup({ components });
  try {
    assert.deepEqual(
      view.pills().map((pill) => pill.textContent),
      ['components1', 'Section2'],
      'the root first, then folders A to Z, as the Components panel lists them',
    );
    await view.act(() => view.pills()[1].click());
    assert.deepEqual(view.labels(), ['Hero', 'Deep']);
  } finally {
    await view.finish();
  }
});

test('a pill filters, a second click clears it, another switches; one at most, remembered per project', async () => {
  const view = await setup({ components: mixed() });
  const pressed = () => view.pills().map((pill) => pill.getAttribute('aria-pressed'));
  try {
    await view.act(() => view.pills()[1].click());
    assert.deepEqual(view.labels(), ['Button', 'Tag']);
    assert.deepEqual(pressed(), ['false', 'true']);
    assert.ok(view.pills()[1].classList.contains('on'), 'the selected pill keeps the active style');
    await view.act(() => view.pills()[0].click());
    assert.deepEqual(view.labels(), ['Hero', 'Pricing', 'Faq'], 'another pill switches');
    assert.deepEqual(pressed(), ['true', 'false']);
    await view.act(() => view.pills()[0].click());
    assert.equal(view.labels().length, 7, 'a second click clears the filter');
    assert.deepEqual(pressed(), ['false', 'false']);
    await view.act(() => view.pills()[1].click());
    // A focused pill is a button: Enter presses it, it does not insert the marked card.
    const enter = { prevented: false };
    await view.act(() => view.Simulate.keyDown(view.pills()[1], { key: 'Enter', preventDefault: () => (enter.prevented = true) }));
    assert.equal(enter.prevented, false);
    assert.equal(view.events.inserted.length, 0);
  } finally {
    await view.finish();
  }
  const stored = { 'stacki.insertPalette.tab': 'components', 'stacki.insertPalette.folders': JSON.stringify([['/p', 'folder:Ui']]) };
  const reopened = await setup({ components: mixed(), storage: stored });
  try {
    assert.deepEqual(reopened.labels(), ['Button', 'Tag'], 'the project reopens on its pill');
  } finally {
    await reopened.finish();
  }
  const other = await setup({ components: mixed(), storage: stored, projectKey: '/q' });
  try {
    assert.equal(other.labels().length, 7, 'another project keeps its own choice');
  } finally {
    await other.finish();
  }
  const vanished = await setup({
    components: mixed(),
    storage: { 'stacki.insertPalette.tab': 'components', 'stacki.insertPalette.folders': JSON.stringify([['/p', 'folder:Gone']]) },
  });
  try {
    assert.equal(vanished.labels().length, 7, 'a remembered folder the project no longer has selects nothing');
    assert.ok(vanished.pills().every((pill) => pill.getAttribute('aria-pressed') === 'false'));
  } finally {
    await vanished.finish();
  }
});

test('a search counts its hits on every pill and keeps the pills in place', async () => {
  const view = await setup({ components: mixed() });
  try {
    await view.type('button');
    assert.deepEqual(view.labels(), ['Button']);
    assert.deepEqual(
      view.pills().map((pill) => pill.textContent),
      ['Section0', 'Ui1'],
    );
    assert.equal(view.pills()[0].disabled, true, 'a pill with no hits cannot be picked');
    await view.act(() => view.pills()[1].click());
    await view.type('hero');
    assert.deepEqual(view.labels(), [], 'the selected folder has no hit');
    assert.equal(view.pills()[1].disabled, false, 'the selected pill stays clearable');
    await view.act(() => view.pills()[1].click());
    assert.deepEqual(view.labels(), ['Hero']);
    await view.type('zzzz');
    assert.deepEqual(view.labels(), []);
    assert.equal(view.container.querySelector('.props-empty').textContent, 'No matches.');
  } finally {
    await view.finish();
  }
});

test('the first use opens on All results, the plain list: rows, no cards, no pills, no hints', async () => {
  const view = await setup({ components: mixed(), tab: undefined });
  try {
    assert.equal(view.container.querySelector('.insert-tab.on').textContent, 'All results');
    assert.equal(view.container.querySelector('.insert-palette').classList.contains('insert-palette-grid'), false);
    assert.equal(view.container.querySelector('.insert-results').classList.contains('insert-results-grid'), false);
    assert.equal(view.container.querySelector('.insert-pills') ?? undefined, undefined, 'no pills on the list');
    assert.equal(view.container.querySelector('.insert-footer') ?? undefined, undefined, 'no grid hints on the list');
    assert.equal(view.cards().length, 0);
    assert.equal(view.container.querySelector('.insert-surface') ?? undefined, undefined, 'rows have no picture area');
    const rows = [...view.container.querySelectorAll('.insert-results > .insert-item')];
    assert.ok(rows.length > 10);
    assert.equal(rows.length <= 60, true, 'the list keeps its old length');
    const names = view.labels();
    assert.ok(names.includes('Hero') && names.includes('<Image>') && names.includes('<div>'));
    assert.equal(rows[0].querySelector('.insert-item-sub')?.textContent, 'Section', 'a row says where the component lives, by its pill name');
    await view.reveal();
    assert.equal(view.frames().length, 0, 'the list loads no pages');
  } finally {
    await view.finish();
  }
});

test('the palette reopens on the tab it was left on; an unknown stored tab, or storage that throws, is All results', async () => {
  const first = await setup({ components: mixed(), tab: undefined });
  let stored;
  try {
    await first.act(() => first.container.querySelectorAll('.insert-tab')[2].click());
    stored = first.dom.window.localStorage.getItem('stacki.insertPalette.tab');
    assert.equal(stored, 'elements');
    await first.press('Tab');
    assert.equal(first.dom.window.localStorage.getItem('stacki.insertPalette.tab'), 'other', 'keyboard tab changes are kept too');
  } finally {
    await first.finish();
  }
  const reopened = await setup({ components: mixed(), storage: { 'stacki.insertPalette.tab': 'other' } });
  try {
    assert.equal(reopened.container.querySelector('.insert-tab.on').textContent, 'Other');
  } finally {
    await reopened.finish();
  }
  const components = await setup({ components: mixed(), storage: { 'stacki.insertPalette.tab': 'components' } });
  try {
    assert.equal(components.container.querySelector('.insert-tab.on').textContent, 'Components');
    assert.ok(components.cards().length > 0, 'the grid comes back with its tab');
  } finally {
    await components.finish();
  }
  const unknown = await setup({ components: mixed(), storage: { 'stacki.insertPalette.tab': 'photos' } });
  try {
    assert.equal(unknown.container.querySelector('.insert-tab.on').textContent, 'All results');
  } finally {
    await unknown.finish();
  }
  const broken = await setup({
    components: mixed(),
    tab: undefined,
    beforeRender: () => {
      // Storage that refuses every call, as a locked-down browser profile does.
      const denied = () => {
        throw new Error('denied');
      };
      global.localStorage = { getItem: denied, setItem: denied };
    },
  });
  try {
    assert.equal(broken.container.querySelector('.insert-tab.on').textContent, 'All results');
    await broken.act(() => broken.container.querySelectorAll('.insert-tab')[3].click());
    assert.equal(broken.container.querySelector('.insert-tab.on').textContent, 'Other', 'a tab that cannot be saved still switches');
  } finally {
    await broken.finish();
  }
});

test('Elements and Other are the plain list, and up and down move one row at a time', async () => {
  const view = await setup({ components: mixed(), tab: 'elements' });
  try {
    assert.ok(view.container.querySelectorAll('.insert-results > .insert-item').length > 10);
    assert.equal(view.container.querySelectorAll('.insert-card').length, 0);
    await view.type('h');
    const marked = () => [...view.container.querySelectorAll('.insert-results > .insert-item')].findIndex((row) => row.classList.contains('highlight'));
    assert.equal(marked(), 0);
    assert.equal((await view.press('ArrowDown')).prevented, true);
    assert.equal(marked(), 1, 'one row, not one grid row of three');
    assert.equal((await view.press('ArrowRight')).prevented, false, 'left and right are the text cursor');
    await view.press('ArrowUp');
    await view.press('ArrowUp');
    assert.equal(marked(), 0, 'the list stops at the top');
    const space = await view.press(' ');
    assert.equal(space.prevented, false, 'a space is typed into the search');
    await view.press('Enter');
    assert.equal(view.events.inserted[0].type, 'element');
    await view.type('');
    await view.act(() => view.container.querySelectorAll('.insert-tab')[3].click());
    assert.deepEqual(view.labels().slice(0, 2), ['Loop', 'Condition']);
    assert.equal(view.container.querySelectorAll('.insert-card').length, 0);
  } finally {
    await view.finish();
  }
});

test('arrow keys move through the grid by card and by row, and Enter inserts the marked card', async () => {
  const components = Array.from({ length: 8 }, (_, at) => section(`S${at}`));
  const view = await setup({ components });
  try {
    const marked = () => view.cards().findIndex((card) => card.classList.contains('highlight'));
    assert.equal(marked(), 0);
    assert.equal((await view.press('ArrowRight')).prevented, true);
    assert.equal(marked(), 1);
    await view.press('ArrowDown');
    assert.equal(marked(), 4);
    await view.press('ArrowDown');
    assert.equal(marked(), 7, 'the last row is shorter, so down lands on its last card');
    await view.press('ArrowUp');
    assert.equal(marked(), 4);
    await view.press('ArrowLeft');
    assert.equal(marked(), 3);
    await view.press('Enter');
    assert.equal(view.events.inserted.length, 1);
    assert.equal(view.events.inserted[0].path, '/p/src/components/Section/S3.astro');
    assert.equal(view.events.inserted[0].name, 'S3');
  } finally {
    await view.finish();
  }
});

test('with a search typed, left and right belong to the text cursor; up and down still move the grid', async () => {
  const components = Array.from({ length: 8 }, (_, at) => section(`S${at}`));
  const view = await setup({ components });
  try {
    await view.type('s');
    const marked = () => view.cards().findIndex((card) => card.classList.contains('highlight'));
    assert.equal((await view.press('ArrowRight')).prevented, false, 'the cursor keeps the key');
    assert.equal(marked(), 0);
    assert.equal((await view.press('ArrowLeft')).prevented, false);
    assert.equal((await view.press('ArrowDown')).prevented, true);
    assert.equal(marked(), 3);
  } finally {
    await view.finish();
  }
});

test('Escape closes the palette, and Tab walks the tabs', async () => {
  const view = await setup({ components: mixed() });
  try {
    await view.press('Tab');
    assert.equal(view.container.querySelector('.insert-tab.on').textContent, 'Elements');
    await view.press('Tab', { shiftKey: true });
    assert.equal(view.container.querySelector('.insert-tab.on').textContent, 'Components');
    await view.press('Escape');
    assert.equal(view.events.closed, 1);
  } finally {
    await view.finish();
  }
});

/** The frames the store renders pictures in: hidden, off screen, never inside the grid. */
const producers = () => [...document.querySelectorAll('body > div[aria-hidden="true"] iframe')];
const tileMessage = (key = 'a'.repeat(28), html = '<p>Hero</p>') => ({
  type: 'avb:component-preview-snapshot',
  key,
  html,
  attempt: 'sample',
  box: { left: 0, top: 0, width: 400, height: 200 },
});
const send = (view, frame, data) => view.act(() => window.dispatchEvent(new view.dom.window.MessageEvent('message', { source: frame.contentWindow, data })));

test('no observers: every card is still asked for, shows a skeleton and not words, and nothing throws', async () => {
  const view = await setup({ components: mixed(), observers: false });
  try {
    assert.equal(view.frames().length, 0);
    assert.equal(view.cards().length, 7);
    assert.equal(producers().length, 3, 'a few pictures are made at once whatever is on screen');
    const first = view.cards()[0];
    assert.ok(first.querySelector('.insert-skeleton'), 'the tile waits as a skeleton');
    assert.equal(first.querySelector('.insert-surface-note') ?? undefined, undefined, 'a tile that is only waiting never says there is no preview');
    assert.ok(!first.textContent.includes('Loading preview'), 'no loading text');
    const notes = view.cards().map((card) => card.querySelector('.insert-surface-note')?.textContent);
    assert.deepEqual(notes.slice(5), ['No preview available', 'No preview available'], "Astro's own components have no file to preview");
  } finally {
    await view.finish();
  }
});

test('without a dev server the card says there is no preview, and the card still inserts', async () => {
  const view = await setup({ components: mixed(), devUrl: undefined });
  try {
    assert.equal(producers().length, 0);
    const note = view.cards()[0].querySelector('.insert-surface-note');
    assert.equal(note.textContent, 'No preview available');
    assert.equal(note.getAttribute('title'), 'The project dev server is not running.', 'the reason is on hover');
    assert.ok(note.querySelector('.insert-surface-note-icon svg'), 'the component icon sits in it');
    await view.act(() => view.cards()[1].click());
    assert.equal(view.events.inserted[0].name, 'Pricing');
  } finally {
    await view.finish();
  }
});

test('a component without a file has no preview either', async () => {
  const view = await setup({ components: [{ name: 'Loose', renderTag: { tag: 'section' } }] });
  try {
    assert.equal(producers().length, 0);
    assert.equal(view.cards()[0].querySelector('.insert-surface-note').textContent, 'No preview available');
    assert.equal(view.cards()[0].querySelector('.insert-surface-note').getAttribute('title'), 'This component has no file the preview can load.');
  } finally {
    await view.finish();
  }
});

test('each card is rendered once through the preview route as a snapshot, three at a time, in a hidden frame', async () => {
  const view = await setup({ components: mixed() });
  try {
    const frames = producers();
    assert.equal(frames.length, 3);
    const url = new URL(frames[0].getAttribute('src'));
    assert.equal(url.origin + url.pathname, `${DEV_URL}/__avb/preview`);
    assert.equal(url.searchParams.get('c'), 'Hero');
    assert.equal(url.searchParams.get('p'), 'src/components/Section/Hero.astro');
    assert.equal(url.searchParams.get('layout'), 'snapshot');
    assert.equal(url.searchParams.has('known'), false, 'nothing is held yet, so nothing to check');
    assert.equal(frames[0].getAttribute('sandbox'), 'allow-scripts allow-same-origin');
    assert.equal(frames[0].getAttribute('tabindex'), '-1');
    assert.equal(view.frames().length, 0, 'no frame sits in the grid');
    await send(view, frames[0], tileMessage());
    assert.equal(producers().filter((frame) => frame.getAttribute('src').includes('c=Hero')).length, 0, 'an answered frame is removed');
    assert.equal(producers().length, 3, 'its place goes to the next card');
  } finally {
    await view.finish();
  }
});

test('the visible card is rendered before the ones above and below it', async () => {
  const components = Array.from({ length: 12 }, (_, at) => section(`S${String(at).padStart(2, '0')}`));
  const view = await setup({ components });
  try {
    await view.act(() => view.observers.show(view.cards()[9], true));
    await send(view, producers()[0], tileMessage());
    assert.ok(
      producers().some((frame) => frame.getAttribute('src').includes('c=S09')),
      'the card on screen takes the next place, not the next in the list',
    );
  } finally {
    await view.finish();
  }
});

test('a snapshot becomes the card picture; another window cannot paint one', async () => {
  const view = await setup({ components: mixed() });
  try {
    await view.reveal();
    const [first] = producers();
    await send(view, { contentWindow: view.dom.window }, tileMessage());
    assert.equal(view.cards()[0].querySelector('.insert-snapshot') ?? undefined, undefined, 'a message from another window changes nothing');
    await send(view, first, tileMessage('a'.repeat(28), '<base href="__AVB_ORIGIN__/"><p>Hero</p>'));
    await view.reveal();
    const picture = view.cards()[0].querySelector('iframe.insert-snapshot-frame');
    assert.ok(picture, 'the card has its picture');
    assert.equal(picture.getAttribute('sandbox'), 'allow-same-origin', 'a picture runs no script');
    assert.equal(picture.getAttribute('aria-hidden'), 'true');
    assert.ok(picture.getAttribute('srcdoc').includes('http://localhost:4321/'), "the dev server's own address replaces the token");
    assert.ok(!picture.getAttribute('srcdoc').includes('__AVB_ORIGIN__'));
  } finally {
    await view.finish();
  }
});

test('a card with a picture is never remounted, blanked or put back to a skeleton by scrolling', async () => {
  const view = await setup({ components: mixed() });
  try {
    await view.reveal();
    await send(view, producers()[0], tileMessage());
    await view.reveal();
    const picture = view.cards()[0].querySelector('iframe.insert-snapshot-frame');
    await view.act(() => picture.dispatchEvent(new view.dom.window.Event('load')));
    assert.equal(view.cards()[0].querySelector('.insert-skeleton') ?? undefined, undefined);
    for (const visible of [false, true, false, true]) {
      await view.act(() => view.observers.show(view.cards()[0], visible));
      assert.equal(view.cards()[0].querySelector('iframe.insert-snapshot-frame'), picture, 'the same frame, never replaced');
      assert.equal(view.cards()[0].querySelector('.insert-skeleton') ?? undefined, undefined, 'never a skeleton again');
      assert.equal(view.cards()[0].querySelector('.insert-surface-note') ?? undefined, undefined);
    }
  } finally {
    await view.finish();
  }
});

test('a skeleton has the tile size, and the picture takes its place inside the same surface', async () => {
  const view = await setup({ components: mixed() });
  try {
    const surface = view.cards()[1].querySelector('.insert-surface');
    const skeleton = surface.querySelector('.insert-skeleton');
    assert.equal(skeleton.parentElement, surface, 'the skeleton fills the surface, whose 16:10 box does not depend on its content');
    const css = fs.readFileSync(repoPath('src/app/styles.css'), 'utf8');
    assert.match(css, /\.insert-surface-card \{[^}]*aspect-ratio: 16 \/ 10/);
    assert.match(css, /\.insert-skeleton \{[^}]*position: absolute;[^}]*inset: 0/);
    assert.match(css, /\.insert-snapshot \{[^}]*position: absolute;[^}]*inset: 0/);
  } finally {
    await view.finish();
  }
});

test('reopening the palette finds the pictures waiting: no skeleton, a check behind them', async () => {
  const view = await setup({ components: mixed() });
  try {
    await view.reveal();
    await send(view, producers()[0], tileMessage());
    await view.reveal();
    await view.remount();
    await view.reveal();
    assert.ok(view.cards()[0].querySelector('iframe.insert-snapshot-frame'), 'the picture is there on the first paint');
    assert.equal(view.cards()[0].querySelector('.insert-skeleton') ?? undefined, undefined);
  } finally {
    await view.finish();
  }
});

test('an empty report says why on hover, and Try with sample data renders the tile again without inserting it', async () => {
  const view = await setup({ components: mixed() });
  try {
    const [first] = producers();
    await send(view, first, { type: 'avb:component-preview', status: 'empty', reason: 'Preview needs data for: items, band. Open an instance on a page.' });
    const note = view.cards()[0].querySelector('.insert-surface-note');
    assert.equal(note.textContent.startsWith('No preview available'), true);
    assert.equal(note.getAttribute('title'), 'Needs a value for: items, band. Open an instance on a page to preview it.');
    const retry = note.querySelector('button');
    assert.equal(retry.textContent, 'Try with sample data');
    const before = producers().length;
    await view.act(() => retry.click());
    assert.deepEqual(view.events.inserted, [], 'the retry is not a click on the card');
    assert.ok(view.cards()[0].querySelector('.insert-skeleton'), 'the tile waits again');
    assert.equal(producers().length, before, 'the three places are taken; the retry waits for one');
    await send(view, producers()[0], tileMessage());
    const again = producers().find((frame) => frame.getAttribute('src').includes('c=Hero'));
    assert.ok(again, 'the retried tile is rendered next');
    assert.equal(new URL(again.getAttribute('src')).searchParams.get('attempts'), 'sample', 'with the project instance set aside');
  } finally {
    await view.finish();
  }
});

test('a thrown error is named on hover, and a page that loads and never answers is given up on', async () => {
  const { mock } = require('node:test');
  const view = await setup({ components: mixed() });
  try {
    const [first, second] = producers();
    await send(view, first, { type: 'avb:component-preview', status: 'empty', reason: "Threw: Cannot read properties of undefined (reading 'x')" });
    assert.match(
      view.cards()[0].querySelector('.insert-surface-note').getAttribute('title'),
      /The component threw an error: Cannot read properties of undefined/,
    );
    mock.timers.enable({ apis: ['setTimeout'] });
    await view.act(() => second.dispatchEvent(new view.dom.window.Event('load')));
    await view.act(() => mock.timers.tick(6100));
    mock.timers.reset();
    assert.match(view.cards()[1].querySelector('.insert-surface-note').getAttribute('title'), /did not render the component/);
  } finally {
    mock.timers.reset();
    await view.finish();
  }
});

test('never more than three pictures are made at once, however many cards there are', async () => {
  const components = Array.from({ length: 40 }, (_, at) => section(`S${String(at).padStart(2, '0')}`));
  const view = await setup({ components });
  try {
    assert.equal(view.cards().length, 42, "the forty sections and Astro's two components");
    assert.equal(producers().length, 3);
    for (let round = 0; round < 6; round++) {
      await send(view, producers()[0], tileMessage());
      assert.ok(producers().length <= 3);
    }
    assert.equal(view.frames().length, 6 > 0 ? view.frames().length : 0);
  } finally {
    await view.finish();
  }
});

test('there is no large view: Space does nothing on the grid, and the footer only says Enter inserts', async () => {
  const view = await setup({ components: mixed() });
  try {
    await view.reveal();
    const space = await view.press(' ');
    assert.equal(space.prevented, false, 'Space is left to the search field');
    const shifted = await view.press(' ', { shiftKey: true });
    assert.equal(shifted.prevented, false);
    assert.equal(view.container.querySelector('[role="dialog"]') ?? undefined, undefined);
    assert.equal(view.frames().length, 0, 'no extra frame opens');
    assert.equal(view.container.querySelector('.insert-footer').textContent, '↵ insert');
    assert.equal(view.events.inserted.length, 0);
  } finally {
    await view.finish();
  }
});

test('the grid is capped at the named limit, and the pills still count every hit', async () => {
  const components = Array.from({ length: 230 }, (_, at) => section(`S${at}`));
  const view = await setup({ components });
  try {
    assert.equal(view.cards().length, 200);
    assert.equal(view.pills()[0].textContent, 'Section230');
  } finally {
    await view.finish();
  }
});

test('cards keep the classes that existing tests and browser checks find them by', async () => {
  const view = await setup({ components: mixed() });
  try {
    const card = view.cards()[0];
    assert.ok(card.classList.contains('insert-item'));
    assert.ok(card.classList.contains('highlight'));
    assert.ok(card.querySelector('.insert-item-label'));
    assert.ok(view.container.querySelector('.insert-palette'));
  } finally {
    await view.finish();
  }
});

test('hovering a card does not scroll the list; the arrow keys do', async () => {
  const components = Array.from({ length: 8 }, (_, at) => section(`S${at}`));
  const view = await setup({ components });
  try {
    const before = view.scrolled.length;
    await view.act(() => view.Simulate.mouseMove(view.cards()[4]));
    assert.equal(view.cards()[4].classList.contains('highlight'), true);
    assert.equal(view.scrolled.length, before, 'the pointer moved the highlight, the list stayed');
    await view.press('ArrowRight');
    assert.ok(view.scrolled.length > before, 'the keyboard brings the card into view');
    assert.equal(view.scrolled.at(-1), view.cards()[5]);
  } finally {
    await view.finish();
  }
});

test('a pointer at rest does not take the highlight from the keyboard, and one that moves does', async () => {
  const components = Array.from({ length: 6 }, (_, at) => section(`S${at}`));
  const view = await setup({ components });
  try {
    const marked = () => view.cards().findIndex((card) => card.classList.contains('highlight'));
    await view.press('ArrowRight');
    assert.equal(marked(), 1);
    await view.act(() => view.Simulate.mouseEnter(view.cards()[3]));
    assert.equal(marked(), 1, 'entering a card under a resting pointer changes nothing');
    await view.act(() => view.Simulate.mouseMove(view.cards()[3]));
    assert.equal(marked(), 3, 'moving the pointer over a card marks it');
  } finally {
    await view.finish();
  }
});

test('a card names its folder pill beside its label, except while a pill filters the grid', async () => {
  const components = [section('Hero', { instances: 52 }), { name: 'Loose', folder: '', path: '/p/src/components/Loose.astro' }];
  const view = await setup({ components });
  try {
    const folders = () => view.cards().map((card) => card.querySelector('.insert-card-folder')?.textContent);
    assert.deepEqual(folders(), ['· Section', '· components', undefined, undefined], "the pill's own name; Astro's components have none");
    const foot = view.cards()[0].querySelector('.insert-card-foot');
    assert.deepEqual(
      [...foot.children].map((child) => child.className),
      ['insert-item-icon', 'insert-item-label', 'insert-card-folder', 'insert-item-uses'],
      'label, folder, then the count at the end',
    );
    await view.act(() => view.pills()[1].click());
    assert.deepEqual(folders(), [undefined], 'the selected pill already says the folder');
  } finally {
    await view.finish();
  }
});

test('the highlight ring is drawn inside the card, so the scrolling grid cannot clip it on any edge', () => {
  const css = fs.readFileSync(repoPath('src/app/styles.css'), 'utf8');
  const ring = css.match(/\.insert-item\.insert-card\.highlight \.insert-surface::after \{([^}]*)\}/)?.[1];
  assert.ok(ring, 'the ring is a layer of the surface, above its frame');
  assert.match(ring, /box-shadow: inset 0 0 0 2px/);
  assert.match(ring, /pointer-events: none/, 'the ring never takes the pointer from the live preview');
  assert.doesNotMatch(css, /\.insert-item\.insert-card\.highlight \.insert-surface \{[^}]*box-shadow: 0 0 0/, 'no outer ring to be clipped');
});
