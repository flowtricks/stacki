// Goal: the insert palette shows components as cards with a live, scaled, inert picture, sorted into
// sections and blocks, and every key and bound in that contract holds.
// Methodology: mount the real palette in jsdom with fake IntersectionObserver and ResizeObserver
// so the test decides what is visible and how wide a card is. Drive it with the keys a person
// presses, and read the DOM: cards, pills, frames, the large view, the hints. What a pixel looks
// like is not measured here; the scale each surface asks for is.
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
  const InsertSearch = require(output).default;
  const container = document.getElementById('root');
  const root = createRoot(container);
  const events = { inserted: [], closed: 0 };
  await React.act(async () => {
    root.render(
      React.createElement(InsertSearch, {
        components: options.components,
        devUrl: 'devUrl' in options ? options.devUrl : DEV_URL,
        shots: options.shots,
        trailingSlash: 'never',
        onInsert: (item) => events.inserted.push(item),
        onClose: () => {
          events.closed += 1;
        },
      }),
    );
  });
  const act = (work) => React.act(async () => work());
  const labels = () =>
    [...container.querySelectorAll('.insert-item-label')].filter((element) => !element.closest('.insert-enlarged')).map((element) => element.textContent);
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
      }
    });
  };
  const finish = async () => {
    await React.act(async () => root.unmount());
    dom.window.close();
    delete global.IntersectionObserver;
    delete global.ResizeObserver;
  };
  return { scrolled, Simulate, dom, container, events, act, labels, input, press, type, cards, frames, pills, reveal, observers, finish };
}

const JPEG = (name) => `data:image/jpeg;base64,${name}`;

/** A fake of the desktop's photographs: which components have one, what reading costs, and a way to say new ones arrived. */
function fakeShots(components, images = {}, widths = {}) {
  const state = { components: [...components], reads: [], listeners: new Set() };
  return {
    state,
    source: {
      list: async () => state.components.map((component) => ({ component, width: widths[component] ?? 1440, height: 800 })),
      read: async (component) => {
        state.reads.push(component);
        return images[component];
      },
      onChanged: (listener) => {
        state.listeners.add(listener);
        return () => state.listeners.delete(listener);
      },
    },
    announce: () => state.listeners.forEach((listener) => listener()),
  };
}

const settle = async (view) => {
  await view.act(async () => {});
  await view.act(async () => {});
};

const mixed = () => [
  section('Hero', { instances: 10 }),
  section('Pricing'),
  section('Faq', { instances: 3 }),
  block('Button', { instances: 25 }),
  block('Tag'),
];

test('the palette opens on Components with the Sections pill and the first card marked', async () => {
  const view = await setup({ components: mixed() });
  try {
    assert.equal(view.container.querySelector('.insert-tab.on').textContent, 'Components');
    assert.deepEqual(
      view.pills().map((pill) => pill.textContent),
      ['Sections3', 'Blocks4'],
      'each pill names its group and its hits; the blocks include the two astro:assets components',
    );
    assert.deepEqual(
      view.pills().map((pill) => pill.classList.contains('on')),
      [true, false],
    );
    assert.deepEqual(view.labels(), ['Hero', 'Pricing', 'Faq']);
    assert.equal(view.container.querySelectorAll('.insert-item.highlight').length, 1);
    assert.ok(view.cards()[0].classList.contains('highlight'));
    assert.equal(view.container.querySelector('.insert-palette') !== null, true);
  } finally {
    await view.finish();
  }
});

test('a card shows how often a component is used, and nothing when it is not', async () => {
  const view = await setup({ components: mixed() });
  try {
    const uses = view.cards().map((card) => card.querySelector('.insert-item-uses')?.textContent);
    assert.deepEqual(uses, ['10×', undefined, '3×']);
  } finally {
    await view.finish();
  }
});

test('sections that reach <section> through another component are sections', async () => {
  const components = [
    section('Section'),
    { name: 'Hero', folder: 'Section', path: '/p/src/components/Section/Hero.astro', rootComponent: 'Section' },
    block('Button'),
  ];
  const view = await setup({ components });
  try {
    assert.deepEqual(view.labels(), ['Section', 'Hero']);
  } finally {
    await view.finish();
  }
});

test('Blocks pill and Sections pill switch the grid; an empty pill yields to the other one', async () => {
  const view = await setup({ components: mixed() });
  try {
    await view.act(() => view.pills()[1].click());
    assert.deepEqual(view.labels().slice(0, 2), ['Button', 'Tag'], 'project blocks first, then the astro:assets ones');
    assert.ok(view.labels().includes('<Image>'));
    assert.deepEqual(
      view.pills().map((pill) => pill.classList.contains('on')),
      [false, true],
    );
  } finally {
    await view.finish();
  }
  const blocksOnly = await setup({ components: [block('Button'), block('Tag')] });
  try {
    assert.deepEqual(
      blocksOnly.pills().map((pill) => pill.classList.contains('on')),
      [false, true],
      'no sections, so the blocks pill is the marked one',
    );
    assert.equal(blocksOnly.pills()[0].disabled, true);
  } finally {
    await blocksOnly.finish();
  }
});

test('a search covers both groups and shows the one that has hits, with the counts of the hits', async () => {
  const view = await setup({ components: mixed() });
  try {
    await view.type('button');
    assert.deepEqual(view.labels(), ['Button']);
    assert.deepEqual(
      view.pills().map((pill) => pill.textContent),
      ['Sections0', 'Blocks1'],
    );
    assert.deepEqual(
      view.pills().map((pill) => pill.classList.contains('on')),
      [false, true],
    );
    await view.type('hero');
    assert.deepEqual(
      view.pills().map((pill) => pill.textContent),
      ['Sections1', 'Blocks0'],
    );
    assert.deepEqual(view.labels(), ['Hero']);
    await view.type('zzzz');
    assert.deepEqual(view.labels(), []);
    assert.equal(view.container.querySelector('.props-empty').textContent, 'No matches.');
  } finally {
    await view.finish();
  }
});

test('All results lists sections, then blocks as cards, then elements and other as tiles', async () => {
  const view = await setup({ components: mixed() });
  try {
    await view.act(() => view.container.querySelectorAll('.insert-tab')[0].click());
    assert.equal(view.container.querySelector('.insert-pills') ?? undefined, undefined, 'no pills on All results');
    const items = [...view.container.querySelectorAll('.insert-results > .insert-item')];
    const kinds = items.map((item) => (item.classList.contains('insert-card') ? 'card' : 'tile'));
    const firstTile = kinds.indexOf('tile');
    assert.ok(firstTile > 0);
    assert.ok(kinds.slice(0, firstTile).every((kind) => kind === 'card'));
    assert.ok(kinds.slice(firstTile).every((kind) => kind === 'tile'));
    const names = view.labels();
    assert.deepEqual(names.slice(0, 5), ['Hero', 'Pricing', 'Faq', 'Button', 'Tag']);
    assert.ok(names.includes('<Image>'), 'astro:assets components are blocks');
    assert.equal(items.find((item) => item.textContent.includes('<Image>')).classList.contains('insert-card'), true);
    assert.ok(names.includes('<div>') && names.includes('Loop'));
    assert.equal(view.container.querySelector('.insert-tile .insert-surface') ?? undefined, undefined, 'tiles have no picture area');
  } finally {
    await view.finish();
  }
});

test('Elements and Other are tiles', async () => {
  const view = await setup({ components: mixed() });
  try {
    await view.act(() => view.container.querySelectorAll('.insert-tab')[2].click());
    assert.ok(view.container.querySelectorAll('.insert-tile').length > 10);
    assert.equal(view.container.querySelectorAll('.insert-card').length, 0);
    await view.act(() => view.container.querySelectorAll('.insert-tab')[3].click());
    assert.deepEqual(view.labels().slice(0, 2), ['Loop', 'Condition']);
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

test('no observers: no frame loads, nothing throws, the card says it is loading', async () => {
  const view = await setup({ components: mixed(), observers: false });
  try {
    assert.equal(view.frames().length, 0);
    assert.equal(view.cards().length, 3);
    assert.ok([...view.container.querySelectorAll('.insert-surface-note')].every((note) => note.textContent.includes('Loading preview…')));
  } finally {
    await view.finish();
  }
});

test('without a dev server the card says there is no preview, and the card still inserts', async () => {
  const view = await setup({ components: mixed(), devUrl: undefined });
  try {
    await view.reveal();
    assert.equal(view.frames().length, 0);
    const note = view.cards()[0].querySelector('.insert-surface-note');
    assert.equal(note.textContent, 'No preview available');
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
    await view.reveal();
    assert.equal(view.frames().length, 0);
    assert.equal(view.cards()[0].querySelector('.insert-surface-note').textContent, 'No preview available');
  } finally {
    await view.finish();
  }
});

test('a visible, measured card loads the real route in an inert frame at the width its group is built for', async () => {
  const view = await setup({ components: mixed() });
  try {
    assert.equal(view.frames().length, 0, 'nothing loads before a card is seen');
    await view.reveal(360);
    const frames = view.frames();
    assert.equal(frames.length, 3);
    const first = frames[0];
    const url = new URL(first.getAttribute('src'));
    assert.equal(url.origin + url.pathname, `${DEV_URL}/__avb/preview`);
    assert.equal(url.searchParams.get('c'), 'Hero');
    assert.equal(url.searchParams.get('layout'), 'page', 'a section is laid out at the frame width');
    assert.equal(url.searchParams.get('p'), 'src/components/Section/Hero.astro');
    assert.equal(first.getAttribute('aria-hidden'), 'true');
    assert.equal(first.getAttribute('tabindex'), '-1');
    const surface = view.cards()[0].querySelector('.insert-surface');
    assert.equal(surface.style.getPropertyValue('--surface-width'), '1440px');
    assert.equal(Number(surface.style.getPropertyValue('--surface-scale')), 360 / 1440);
    await view.act(() => view.pills()[1].click());
    await view.reveal(360);
    const blockSurface = view.cards()[0].querySelector('.insert-surface');
    assert.equal(new URL(view.frames()[0].getAttribute('src')).searchParams.get('layout'), 'page', 'a block is laid out at its frame width too, top left');
    assert.equal(blockSurface.style.getPropertyValue('--surface-width'), '640px');
    assert.equal(Number(blockSurface.style.getPropertyValue('--surface-scale')), 360 / 640);
  } finally {
    await view.finish();
  }
});

test('the card shows its loading reason until the frame reports, then the page; an empty report says there is none', async () => {
  const view = await setup({ components: mixed() });
  try {
    await view.reveal();
    const [first, second] = view.frames();
    assert.equal(first.style.opacity, '0');
    assert.ok(view.cards()[0].textContent.includes('Loading preview…'));
    const send = (source, status) =>
      view.act(() => window.dispatchEvent(new view.dom.window.MessageEvent('message', { source, data: { type: 'avb:component-preview', status } })));
    await send(first.contentWindow, 'ready');
    assert.equal(view.frames()[0].style.opacity, '1');
    assert.equal(view.cards()[0].querySelector('.insert-surface-note') ?? undefined, undefined);
    await send(second.contentWindow, 'empty');
    assert.equal(view.cards()[1].querySelector('.insert-surface-note').textContent, 'No preview available');
    await send(view.dom.window, 'ready');
    assert.equal(view.cards()[2].querySelector('.insert-frame').style.opacity, '0', 'a message from another window changes nothing');
  } finally {
    await view.finish();
  }
});

test('a card scrolled out of view loses its frame, and gets a new one when it returns', async () => {
  const view = await setup({ components: mixed() });
  try {
    await view.reveal();
    assert.equal(view.frames().length, 3);
    await view.act(() => view.observers.show(view.cards()[0], false));
    assert.equal(view.frames().length, 2);
    assert.equal(view.cards()[0].querySelector('iframe') ?? undefined, undefined);
    await view.act(() => view.observers.show(view.cards()[0], true));
    assert.equal(view.frames().length, 3);
  } finally {
    await view.finish();
  }
});

test('never more frames than the limit, large view included', async () => {
  const components = Array.from({ length: 40 }, (_, at) => section(`S${String(at).padStart(2, '0')}`));
  const view = await setup({ components });
  try {
    await view.reveal();
    assert.equal(view.cards().length, 40);
    assert.equal(view.frames().length, 11, 'one frame stays free for the large view');
    assert.equal(view.frames()[0].getAttribute('src').includes('c=S00'), true, 'the first cards in grid order get them');
    await view.press(' ');
    const layer = view.container.querySelector('.insert-enlarged');
    assert.ok(layer);
    await view.act(() => view.observers.size(layer.querySelector('.insert-surface'), 1100));
    assert.equal(view.frames().length, 12);
  } finally {
    await view.finish();
  }
});

test('Space opens the large view on an empty search, Escape closes only that layer', async () => {
  const view = await setup({ components: mixed() });
  try {
    await view.reveal();
    assert.equal(view.container.querySelector('.insert-footer').textContent, 'Space to enlarge↵ insert');
    const opened = await view.press(' ');
    assert.equal(opened.prevented, true);
    const layer = view.container.querySelector('.insert-enlarged');
    assert.ok(layer);
    assert.equal(layer.querySelector('.insert-enlarged-head').textContent.startsWith('Hero'), true);
    await view.act(() => view.observers.size(layer.querySelector('.insert-surface'), 1100));
    const surface = layer.querySelector('.insert-surface');
    assert.equal(surface.style.getPropertyValue('--surface-width'), '1440px');
    assert.equal(Number(surface.style.getPropertyValue('--surface-scale')), 1100 / 1440);
    assert.ok(layer.querySelector('iframe'), 'the large view renders the same route');
    await view.press('Escape');
    assert.equal(view.container.querySelector('.insert-enlarged') ?? undefined, undefined);
    assert.equal(view.events.closed, 0, 'the palette stays');
    await view.press(' ');
    assert.ok(view.container.querySelector('.insert-enlarged'));
    await view.press(' ');
    assert.equal(view.container.querySelector('.insert-enlarged') ?? undefined, undefined, 'the same key closes it');
    assert.equal(view.events.closed, 0);
    await view.press('Escape');
    assert.equal(view.events.closed, 1);
  } finally {
    await view.finish();
  }
});

test('while the large view is open the keys do not reach the grid or the search', async () => {
  const view = await setup({ components: mixed() });
  try {
    await view.press(' ');
    const before = view.cards().findIndex((card) => card.classList.contains('highlight'));
    const arrow = await view.press('ArrowRight');
    assert.equal(arrow.prevented, true);
    const letter = await view.press('x');
    assert.equal(letter.prevented, true, 'typing is held back');
    const enter = await view.press('Enter');
    assert.equal(enter.prevented, true);
    assert.equal(view.events.inserted.length, 0);
    await view.press('Escape');
    assert.equal(
      view.cards().findIndex((card) => card.classList.contains('highlight')),
      before,
    );
  } finally {
    await view.finish();
  }
});

test('with a search typed a plain space is the search, and only Shift Space opens the large view', async () => {
  const view = await setup({ components: mixed() });
  try {
    await view.type('hero');
    assert.equal(view.container.querySelector('.insert-footer').textContent, '⇧ Space to enlarge↵ insert');
    const plain = await view.press(' ');
    assert.equal(plain.prevented, false, 'the space is typed');
    assert.equal(view.container.querySelector('.insert-enlarged') ?? undefined, undefined);
    const shifted = await view.press(' ', { shiftKey: true });
    assert.equal(shifted.prevented, true);
    assert.ok(view.container.querySelector('.insert-enlarged'));
    await view.press(' ', { shiftKey: true });
    assert.equal(view.container.querySelector('.insert-enlarged') ?? undefined, undefined);
  } finally {
    await view.finish();
  }
});

test('Space on something with no picture does nothing, and gives no hint', async () => {
  const noServer = await setup({ components: mixed(), devUrl: undefined });
  try {
    assert.equal(noServer.container.querySelector('.insert-footer').textContent, '↵ insert');
    const space = await noServer.press(' ');
    assert.equal(space.prevented, true, 'an empty search never takes a leading space');
    assert.equal(noServer.container.querySelector('.insert-enlarged') ?? undefined, undefined);
    assert.equal(noServer.input().value, '');
  } finally {
    await noServer.finish();
  }
  const tiles = await setup({ components: mixed() });
  try {
    await tiles.act(() => tiles.container.querySelectorAll('.insert-tab')[2].click());
    assert.equal(tiles.container.querySelector('.insert-footer').textContent, '↵ insert');
    await tiles.press(' ');
    assert.equal(tiles.container.querySelector('.insert-enlarged') ?? undefined, undefined);
  } finally {
    await tiles.finish();
  }
});

test('the grid is capped at the named limit, and the pills still count every hit', async () => {
  const components = Array.from({ length: 230 }, (_, at) => section(`S${at}`));
  const view = await setup({ components });
  try {
    assert.equal(view.cards().length, 200);
    assert.equal(view.pills()[0].textContent, 'Sections230');
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

const HERO_FILE = '/p/src/components/Section/Hero.astro';

test('a card with a photograph shows it, inert and top aligned, instead of loading the live route', async () => {
  const shots = fakeShots([HERO_FILE], { [HERO_FILE]: JPEG('HERO') });
  const view = await setup({ components: mixed(), shots: shots.source });
  try {
    await settle(view);
    assert.deepEqual(shots.state.reads, [], 'nothing is fetched before a card is seen');
    await view.reveal();
    await settle(view);
    const image = view.cards()[0].querySelector('img.insert-shot');
    assert.ok(image);
    assert.equal(image.getAttribute('src'), JPEG('HERO'));
    assert.equal(image.getAttribute('alt'), '');
    assert.equal(image.getAttribute('draggable'), 'false');
    assert.equal(image.getAttribute('tabindex'), '-1');
    assert.equal(image.getAttribute('aria-hidden'), 'true');
    assert.ok(view.cards()[0].querySelector('.insert-surface').classList.contains('insert-surface-photo'));
    assert.equal(view.cards()[0].querySelector('iframe') ?? undefined, undefined, 'the live route is not loaded for a photographed card');
    assert.equal(view.frames().length, 2, 'the others still use the live route');
    assert.deepEqual(shots.state.reads, [HERO_FILE], 'only the photographed, seen card is read');
  } finally {
    await view.finish();
  }
});

test('while the photograph is on its way the card says so and does not start the live route', async () => {
  const slow = fakeShots([HERO_FILE]);
  let release = () => {};
  slow.source.read = () => new Promise((resolve) => (release = () => resolve(JPEG('LATE'))));
  const view = await setup({ components: mixed(), shots: slow.source });
  try {
    await settle(view);
    await view.reveal();
    await settle(view);
    assert.ok(view.cards()[0].textContent.includes('Loading preview…'));
    assert.equal(view.cards()[0].querySelector('iframe') ?? undefined, undefined);
    await view.act(async () => release());
    await settle(view);
    assert.equal(view.cards()[0].querySelector('img.insert-shot').getAttribute('src'), JPEG('LATE'));
  } finally {
    await view.finish();
  }
});

test('a photograph that cannot be read falls back to the live route', async () => {
  const shots = fakeShots([HERO_FILE], {});
  const view = await setup({ components: mixed(), shots: shots.source });
  try {
    await settle(view);
    await view.reveal();
    await settle(view);
    assert.equal(view.cards()[0].querySelector('img') ?? undefined, undefined);
    assert.ok(view.cards()[0].querySelector('iframe'));
  } finally {
    await view.finish();
  }
});

test('a component with no photograph, no source and a failing catalog all use the live route', async () => {
  const none = fakeShots([]);
  const view = await setup({ components: mixed(), shots: none.source });
  try {
    await settle(view);
    await view.reveal();
    assert.equal(view.container.querySelectorAll('img.insert-shot').length, 0);
    assert.equal(view.frames().length, 3);
  } finally {
    await view.finish();
  }
  const broken = fakeShots([HERO_FILE]);
  broken.source.list = async () => {
    throw new Error('no main process');
  };
  const failing = await setup({ components: mixed(), shots: broken.source });
  try {
    await settle(failing);
    await failing.reveal();
    assert.equal(failing.frames().length, 3);
  } finally {
    await failing.finish();
  }
});

test('photographs do not count against the frame limit', async () => {
  const components = Array.from({ length: 40 }, (_, at) => section(`S${String(at).padStart(2, '0')}`));
  const photographed = components.slice(0, 20).map((component) => component.path);
  const images = Object.fromEntries(photographed.map((file) => [file, JPEG('X')]));
  const shots = fakeShots(photographed, images);
  const view = await setup({ components, shots: shots.source });
  try {
    await settle(view);
    await view.reveal();
    await settle(view);
    assert.equal(view.container.querySelectorAll('img.insert-shot').length, 20);
    assert.equal(view.frames().length, 11, 'the frames go to the cards without a photograph');
    assert.ok(view.frames()[0].getAttribute('src').includes('c=S20'));
  } finally {
    await view.finish();
  }
});

test('new photographs announced by the main process replace the fallback, and the listener is released', async () => {
  const shots = fakeShots([], { [HERO_FILE]: JPEG('NEW') });
  const view = await setup({ components: mixed(), shots: shots.source });
  try {
    await settle(view);
    await view.reveal();
    assert.ok(view.cards()[0].querySelector('iframe'));
    shots.state.components.push(HERO_FILE);
    await view.act(async () => shots.announce());
    await settle(view);
    await view.reveal();
    await settle(view);
    assert.equal(view.cards()[0].querySelector('img.insert-shot')?.getAttribute('src'), JPEG('NEW'));
    assert.equal(view.cards()[0].querySelector('iframe') ?? undefined, undefined);
    assert.equal(shots.state.listeners.size, 1);
  } finally {
    await view.finish();
  }
  assert.equal(shots.state.listeners.size, 0);
});

test('the large view shows the same photograph, and scrolls instead of cropping', async () => {
  const shots = fakeShots([HERO_FILE], { [HERO_FILE]: JPEG('HERO') });
  const view = await setup({ components: mixed(), shots: shots.source });
  try {
    await settle(view);
    await view.reveal();
    await settle(view);
    await view.press(' ');
    await settle(view);
    const layer = view.container.querySelector('.insert-enlarged');
    assert.ok(layer);
    assert.equal(layer.querySelector('img.insert-shot')?.getAttribute('src'), JPEG('HERO'));
    assert.ok(layer.querySelector('.insert-surface-large.insert-surface-photo'));
    assert.equal(layer.querySelector('iframe') ?? undefined, undefined);
  } finally {
    await view.finish();
  }
});

test('a photograph that cannot be drawn gives way to the live route', async () => {
  const shots = fakeShots([HERO_FILE], { [HERO_FILE]: JPEG('BROKEN') });
  const view = await setup({ components: mixed(), shots: shots.source });
  try {
    await settle(view);
    await view.reveal();
    await settle(view);
    const image = view.cards()[0].querySelector('img.insert-shot');
    assert.ok(image);
    await view.act(() => view.Simulate.error(image));
    await settle(view);
    await view.reveal();
    assert.equal(view.cards()[0].querySelector('img') ?? undefined, undefined);
    assert.ok(view.cards()[0].querySelector('iframe'), 'the card takes a frame again');
  } finally {
    await view.finish();
  }
});

test('the large view opens on a photograph without a dev server', async () => {
  const shots = fakeShots([HERO_FILE], { [HERO_FILE]: JPEG('HERO') });
  const view = await setup({ components: mixed(), devUrl: undefined, shots: shots.source });
  try {
    await settle(view);
    await view.reveal();
    await settle(view);
    assert.equal(view.container.querySelector('.insert-footer').textContent, 'Space to enlarge↵ insert');
    await view.press(' ');
    await settle(view);
    assert.equal(view.container.querySelector('.insert-enlarged img.insert-shot')?.getAttribute('src'), JPEG('HERO'));
    await view.press('Escape');
    await view.press('ArrowRight');
    assert.equal(view.container.querySelector('.insert-footer').textContent, '↵ insert', 'the next card has no photograph and no server');
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

test('a section photographed narrower still fills the card; a block keeps its width in proportion', async () => {
  const BUTTON_FILE = '/p/src/components/Ui/Button.astro';
  const shots = fakeShots([HERO_FILE, BUTTON_FILE], { [HERO_FILE]: JPEG('HERO'), [BUTTON_FILE]: JPEG('BUTTON') }, { [HERO_FILE]: 1200, [BUTTON_FILE]: 300 });
  const view = await setup({ components: mixed(), shots: shots.source });
  try {
    await settle(view);
    await view.reveal();
    await settle(view);
    const sectionShot = view.cards()[0].querySelector('img.insert-shot');
    assert.equal(sectionShot.style.getPropertyValue('--shot-width'), '', 'no width of its own: the CSS gives it the card’s width');
    await view.act(() => view.pills()[1].click());
    await view.reveal();
    await settle(view);
    const blockShot = view.cards()[0].querySelector('img.insert-shot');
    assert.equal(blockShot.style.getPropertyValue('--shot-width'), '300');
    await view.press(' ');
    await settle(view);
    assert.equal(view.container.querySelector('.insert-enlarged img.insert-shot').style.getPropertyValue('--shot-width'), '300');
  } finally {
    await view.finish();
  }
});

test('no live frame starts before the photograph catalog has answered, and an unanswerable catalog is an empty one', async () => {
  const pending = fakeShots([HERO_FILE]);
  let answer = () => {};
  pending.source.list = () => new Promise((resolve) => (answer = () => resolve([])));
  const view = await setup({ components: mixed(), shots: pending.source });
  try {
    await view.reveal();
    assert.equal(view.frames().length, 0, 'the catalog has not answered');
    await view.act(async () => answer());
    await settle(view);
    await view.reveal();
    assert.equal(view.frames().length, 3, 'now the cards know they have no photograph');
  } finally {
    await view.finish();
  }
  const failing = fakeShots([HERO_FILE]);
  failing.source.list = async () => {
    throw new Error('no main process');
  };
  const fallback = await setup({ components: mixed(), shots: failing.source });
  try {
    await settle(fallback);
    await fallback.reveal();
    assert.equal(fallback.frames().length, 3, 'a failed first read leaves the live route to work');
  } finally {
    await fallback.finish();
  }
});

test('a catalog refresh keeps the photograph on screen until its replacement is read', async () => {
  const shots = fakeShots([HERO_FILE], { [HERO_FILE]: JPEG('OLD') });
  const view = await setup({ components: mixed(), shots: shots.source });
  try {
    await settle(view);
    await view.reveal();
    await settle(view);
    assert.equal(view.cards()[0].querySelector('img.insert-shot')?.getAttribute('src'), JPEG('OLD'));
    let release = () => {};
    shots.source.read = () => new Promise((resolve) => (release = () => resolve(JPEG('NEW'))));
    await view.act(async () => shots.announce());
    await settle(view);
    assert.equal(view.cards()[0].querySelector('img.insert-shot')?.getAttribute('src'), JPEG('OLD'), 'the old photograph stays while the new one loads');
    await view.act(async () => release());
    await settle(view);
    assert.equal(view.cards()[0].querySelector('img.insert-shot')?.getAttribute('src'), JPEG('NEW'));
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
