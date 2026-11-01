// Goal: the canvas frame announces the token the app and main compute (plan §9,
// step 7). The sandboxed preload cannot require shared/page/previewToken.ts, so it
// carries its own copy of the manifest rules; this pins the copy to the
// original: the same stamps — wherever the page put them, before <html>, in
// <head>, in the body, once per rendered copy — give the same token, and every
// located event carries it. A page whose stamps cannot form one manifest (one
// file stamped with two checksums) announces no token, so its events are
// refused rather than vouched for.
// Method: run the real built preload in jsdom as a canvas frame, with the
// parent's postMessage captured; compare its `avb:render` announcement with
// shared/page/previewToken.ts's manifestOf + canonicalManifest + SHA-256.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const { createHash } = require('node:crypto');
const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources.js');
const { canonicalManifest, manifestOf, stampData, stampComment, parsePreviewRender } = require('#dist/shared/page/previewToken.js');

const settle = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms));
const FIRST_CHECKSUM = 'a'.repeat(64);
const SECOND_CHECKSUM = 'b'.repeat(64);
const page = { file: 'src/pages/index.astro', checksum: FIRST_CHECKSUM };
const card = { file: 'src/components/Hero Card.astro', checksum: SECOND_CHECKSUM };
const head = { file: 'src/components/Seo.astro', checksum: FIRST_CHECKSUM };

async function frame(html) {
  const dom = new JSDOM(html, {
    url: 'http://127.0.0.1:4321/#avb-design',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  // `jsdom` lays nothing out; the frame measures, so every box is a fixed one.
  const BOX = { x: 0, y: 0, width: 100, height: 20, left: 0, top: 0, right: 100, bottom: 20 };
  window.Element.prototype.getBoundingClientRect = () => BOX;
  window.Range.prototype.getBoundingClientRect = () => BOX;
  window.Range.prototype.getClientRects = () => [BOX];
  const sent = [];
  const globals = {
    window,
    document: window.document,
    location: window.location,
    navigator: window.navigator,
    MutationObserver: window.MutationObserver,
    Element: window.Element,
    HTMLStyleElement: window.HTMLStyleElement,
    getComputedStyle: window.getComputedStyle.bind(window),
    Node: window.Node,
    MouseEvent: window.MouseEvent,
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
  };
  // Node has its own getter-only `navigator`; the frame's globals replace it.
  for (const [name, value] of Object.entries(globals)) {
    Object.defineProperty(global, name, { value, configurable: true, writable: true });
  }
  window.parent = { postMessage: (message) => sent.push(message) };
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
  const entry = repoPath('dist/electron/preload/preload.js');
  delete require.cache[entry];
  try {
    require(entry);
  } finally {
    Module.prototype.require = realRequire;
  }
  await settle();
  // The app turns the frame into a canvas by tracking paths in it; only then
  // does a click select instead of following a link.
  const track = new window.MessageEvent('message', {
    data: { type: 'avb:track', paths: ['0'], scope: '', focus: '', focusOcc: 0 },
  });
  Object.defineProperty(track, 'source', { value: window.parent });
  window.dispatchEvent(track);
  await settle();
  return { window, sent };
}

function expectedToken(stamps) {
  const manifest = manifestOf(stamps);
  assert.ok(manifest.ok);
  return createHash('sha256').update(canonicalManifest(manifest.value)).digest('hex');
}

test('text style queries read their rendered parent without borrowing its selectors', async () => {
  const { window, sent } = await frame(
    '<!doctype html><html><body><h2 class="heading" ' +
      'style="color:rgb(12, 34, 56);font-size:48px;text-align:center;letter-spacing:2px">' +
      '<!--avb-s:0.0-->Heading text<!--avb-e:0.0-->' +
      '<strong style="color:rgb(80, 90, 100);font-size:24px">' +
      '<!--avb-s:0.1.0-->Strong text<!--avb-e:0.1.0--></strong>' +
      '<!--avb-s:0.2-->   <!--avb-e:0.2--></h2></body></html>',
  );
  const query = (path) => {
    const event = new window.MessageEvent('message', {
      data: {
        type: 'avb:query',
        id: 1,
        path,
        selectors: ['.heading', 'h2'],
        props: ['color', 'font-size', 'text-align', 'letter-spacing'],
        compute: ['currentColor'],
      },
    });
    Object.defineProperty(event, 'source', { value: window.parent });
    window.dispatchEvent(event);
    return sent.filter((message) => message.type === 'avb:query-result').at(-1);
  };
  const heading = query('0.0');
  assert.equal(heading.found, true);
  assert.deepEqual(heading.computedProps, {
    color: 'rgb(12, 34, 56)',
    'font-size': '48px',
    'text-align': 'center',
    'letter-spacing': '2px',
  });
  assert.equal(heading.computed.currentColor, 'rgb(12, 34, 56)');
  assert.equal(heading.identity, undefined, 'the parent is not the selected text’s identity');
  assert.deepEqual(heading.matched, { '.heading': false, h2: false });
  const strong = query('0.1.0');
  assert.equal(strong.computedProps.color, 'rgb(80, 90, 100)');
  assert.equal(strong.computedProps['font-size'], '24px', 'the nearest rendered parent wins');
  assert.equal(query('0.2').found, false, 'whitespace alone is not a style target');
  assert.equal(query('missing').found, false, 'unknown paths cannot borrow root styles');
  window.document.documentElement.style.color = 'rgb(1, 2, 3)';
  const root = query('');
  assert.equal(root.computed.currentColor, 'rgb(1, 2, 3)', 'page color queries use the root');
  assert.equal(root.found, false, 'the root is not a selected style target');
  assert.deepEqual(root.computedProps, {}, 'node properties require a selected style target');
  window.close();
});

// Inline serialization tags the strong element but deliberately adds no text
// markers or wrappers. Slot helpers may also strip every comment from this HTML.
test('unmarked text reads parent styles without changing its edit target', async () => {
  const { window, sent } = await frame(
    '<!doctype html><html><body><h1 data-avb-p="src/Heading.astro|0" ' +
      'class="heading" style="font-size:48px;font-family:Georgia;color:rgb(12,34,56)">' +
      'Plain text<strong data-avb-p="src/Heading.astro|0.1">Strong text</strong>' +
      '</h1></body></html>',
  );
  const query = (path, textParentPath) => {
    const event = new window.MessageEvent('message', {
      data: {
        type: 'avb:query',
        id: 1,
        path,
        textParentPath,
        props: ['font-size', 'font-family', 'color'],
        compute: ['currentColor'],
        selectors: ['.heading', 'h1'],
      },
    });
    Object.defineProperty(event, 'source', { value: window.parent });
    window.dispatchEvent(event);
    return sent.filter((message) => message.type === 'avb:query-result').at(-1);
  };
  const path = 'src/Heading.astro|0.0';
  const parent = 'src/Heading.astro|0';
  assert.equal(query(path).found, false, 'ordinary missing-element queries cannot use a parent');
  const text = query(path, parent);
  assert.equal(text.found, true);
  assert.equal(text.computedProps['font-size'], '48px');
  assert.equal(text.computedProps['font-family'], 'Georgia');
  assert.equal(text.computed.currentColor, 'rgb(12, 34, 56)');
  assert.equal(text.identity, undefined, 'text never becomes the parent element');
  assert.deepEqual(text.matched, { '.heading': false, h1: false });
  const sibling = query('src/Heading.astro|0.1');
  assert.equal(sibling.found, true);
  assert.equal(sibling.identity.tag, 'strong');
  for (const invalid of [123, [], {}, 'other|0', 'src/Heading.astro|0.1', 'x'.repeat(9000)]) {
    assert.equal(query(path, invalid).found, false, 'invalid parent contexts are rejected');
  }
  assert.equal(query('src/Heading.astro|0.0.1', parent).found, false, 'only the immediate parent may supply text styles');
  window.close();
});

test('the frame announces the token shared computes; events carry it', async () => {
  const { window, sent } = await frame(
    `${stampComment(page)}<!doctype html><html><head>${stampComment(head)}</head><body>
      <!--avb-s:0--><section id="s" data-avb-d="${stampData(card)}">
        <p>One</p></section><!--avb-e:0-->
      <!--avb-s:1--><section data-avb-d="${stampData(card)}">
        <p>Two</p></section><!--avb-e:1-->
      <!-- a comment of the page's own -->
    </body></html>`,
  );
  const renders = sent.filter((message) => message.type === 'avb:render');
  assert.equal(renders.length, 1, 'one rendering, announced once');
  const [announced] = renders;
  assert.equal(announced.token, expectedToken([page, head, card, card]));
  // What the frame sends is what the renderer's boundary accepts.
  assert.deepEqual(parsePreviewRender(announced), {
    token: announced.token,
    stamps: [card, head, page],
  });
  window.document.querySelector('p').dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  const click = sent.find((message) => message.type === 'avb:click-node');
  assert.ok(click, 'the click is reported');
  assert.equal(click.token, announced.token, 'the click names the rendering it landed on');
  window.document.elementFromPoint = () => window.document.querySelector('p');
  const context = new window.MouseEvent('contextmenu', {
    bubbles: true,
    cancelable: true,
    clientX: 10,
    clientY: 12,
  });
  window.document.querySelector('p').dispatchEvent(context);
  assert.equal(context.defaultPrevented, true, 'the designer replaces the browser menu');
  assert.deepEqual(
    sent.find((message) => message.type === 'avb:context-node'),
    {
      type: 'avb:context-node',
      path: click.path,
      occurrence: click.occurrence,
      outside: false,
      left: 10,
      top: 12,
      token: announced.token,
    },
  );
});

test('late editor registration recovers the current render', async () => {
  const { window, sent } = await frame('<!doctype html><html><body><!--avb-s:0--><p>Ready</p><!--avb-e:0-->' + `${stampComment(page)}</body></html>`);
  const first = sent.find((message) => message.type === 'avb:render');
  assert.ok(first, 'the frame announced its initial rendering');
  sent.length = 0; // The editor missed the announcement while its listener mounted.
  const request = new window.MessageEvent('message', { data: { type: 'avb:request-render' } });
  Object.defineProperty(request, 'source', { value: window.parent });
  window.dispatchEvent(request);
  const recovered = sent.filter((message) => message.type === 'avb:render');
  assert.deepEqual(recovered, [first], 'registration gets the exact current manifest');
  window.document.querySelector('p').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.equal(sent.find((message) => message.type === 'avb:click-node')?.token, first.token, 'the recovered rendering still names subsequent clicks');
});

test('a patched page announces again; a forged second version, never', async () => {
  const { window, sent } = await frame('<!doctype html><html><body><!--avb-s:0--><p>x</p><!--avb-e:0-->' + `${stampComment(page)}</body></html>`);
  const first = sent.filter((message) => message.type === 'avb:render');
  assert.equal(first.length, 1);
  // The patcher gathers the new rendering's stamps at the document's end and
  // says so; the frame reads them again.
  for (const comment of [...window.document.body.childNodes].filter((node) => node.nodeType === 8)) {
    if (comment.data.startsWith('avb-d:')) {
      comment.remove();
    }
  }
  window.document.appendChild(window.document.createComment(stampComment({ ...page, checksum: SECOND_CHECKSUM }).slice(4, -3)));
  window.document.dispatchEvent(new window.CustomEvent('avb:morphed'));
  await settle();
  const second = sent.filter((message) => message.type === 'avb:render');
  assert.equal(second.length, 2, 'the patched rendering is announced');
  assert.equal(second[1].token, expectedToken([{ ...page, checksum: SECOND_CHECKSUM }]));
  assert.notEqual(second[1].token, second[0].token);
  // Page code adds a stamp for the same file with other bytes: no manifest can
  // name that rendering, so the frame announces nothing and its events carry
  // no token.
  window.document.body.appendChild(window.document.createComment(stampComment(page).slice(4, -3)));
  window.document.dispatchEvent(new window.CustomEvent('avb:morphed'));
  await settle();
  assert.equal(sent.filter((message) => message.type === 'avb:render').length, 2);
  const request = new window.MessageEvent('message', { data: { type: 'avb:request-render' } });
  Object.defineProperty(request, 'source', { value: window.parent });
  window.dispatchEvent(request);
  assert.equal(sent.filter((message) => message.type === 'avb:render').length, 2, 'registration cannot replay a token from before an invalid patch');
  window.document.querySelector('p').dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  const clicks = sent.filter((message) => message.type === 'avb:click-node');
  const lastClick = clicks.at(-1);
  assert.ok(lastClick !== undefined, 'the click is still reported');
  // The key is sent, and it names no rendering: absent, as the protocol spells it.
  assert.ok('token' in lastClick, 'the click states its token');
  assert.ok(lastClick.token === undefined, 'a rendering with no token vouches for no click');
});

test('canvas interaction toggles clicks without cancelling slider pointer streams', async () => {
  const { window, sent } = await frame('<!doctype html><body><!--avb-s:0--><button>Open dialog</button><!--avb-e:0--></body>');
  const button = window.document.querySelector('button');
  let clicked = 0;
  let moved = 0;
  window.document.addEventListener(
    'click',
    () => {
      clicked += 1;
    },
    true,
  );
  button.addEventListener('pointermove', () => {
    moved += 1;
  });
  const fire = (type, x = 0) => {
    const event = new window.MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX: x,
      clientY: 0,
    });
    button.dispatchEvent(event);
    return event;
  };
  const mode = (value, source = window.parent) => {
    const event = new window.MessageEvent('message', {
      data: { type: 'avb:interaction', mode: value },
    });
    Object.defineProperty(event, 'source', { value: source });
    window.dispatchEvent(event);
  };
  try {
    assert.equal(fire('click').defaultPrevented, true);
    assert.equal(clicked, 0);
    mode('interact', {});
    assert.equal(fire('click').defaultPrevented, true);
    mode('invalid');
    assert.equal(fire('click').defaultPrevented, true);
    for (const next of ['interact', 'select']) {
      mode(next);
      const hoverCount = sent.filter((item) => item.type === 'avb:hover-node').length;
      window.document.documentElement.dispatchEvent(new window.MouseEvent('mouseleave'));
      fire('mousemove');
      assert.ok(sent.filter((item) => item.type === 'avb:hover-node').length > hoverCount);
      const previousSelections = sent.filter((item) => item.type === 'avb:click-node').length;
      assert.equal(fire('pointerdown').defaultPrevented, false);
      assert.equal(fire('pointermove', 30).defaultPrevented, false);
      fire('pointerup', 30);
      assert.equal(fire('click', 30).defaultPrevented, next === 'select');
      assert.equal(sent.filter((item) => item.type === 'avb:click-node').length, previousSelections);
    }
    assert.equal(moved, 2);
    assert.equal(clicked, 1);
    fire('pointerdown');
    fire('pointerup');
    fire('click');
    assert.equal(clicked, 1);
  } finally {
    window.close();
  }
});
