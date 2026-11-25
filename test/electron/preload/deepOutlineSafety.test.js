// Deep outlines are for looking (docs/apps.md, "Outline modes").
//
//   node test/electron/preload/deepOutlineSafety.test.js
//
// In deep mode a hover inside a closed component names the innermost component
// instance there, with its component's name, so it draws as any instance does; but a click and the context menu still name what the open page
// owns, the closed instance. Selection is the one way the editor's Delete, cut,
// paste, duplicate and drag reach a node, so none of them can reach an element
// inside a closed component. Normal mode is unchanged.
//
// Method: the built preload over jsdom markup written as the marker serializer
// writes it (instanceRoot.test.js's harness), driven by the messages and pointer
// events the canvas sees, reading what it posts to the editor.
const Module = require('module');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources.js');

const PRELOAD = repoPath('dist/electron/preload/preload.js');
const NAV = 'src/components/Nav.astro|';
const LINK = 'src/components/NavLink.astro|';

(async () => {
  const dom = new JSDOM(
    `<!doctype html><body><!--avb-s:0--><!--avb-s:${NAV}0--><nav class="nav"><!--avb-s:${NAV}0.0--><!--avb-s:${LINK}0--><a class="link" id="home">Home</a><!--avb-e:${LINK}0--><!--avb-e:${NAV}0.0--></nav><!--avb-e:${NAV}0--><!--avb-e:0--><!--avb-s:1--><h1 class="hero" id="hero">Hi</h1><!--avb-e:1--></body>`,
    { url: 'http://localhost:4321/#avb-design', pretendToBeVisual: true },
  );
  const { window } = dom;
  const NO_BOX = { x: 0, y: 0, width: 0, height: 0, left: 0, top: 0, right: 0, bottom: 0 };
  window.Range.prototype.getBoundingClientRect = () => NO_BOX;
  global.window = window;
  global.document = window.document;
  global.location = window.location;
  global.navigator = window.navigator;
  global.MutationObserver = window.MutationObserver;
  global.Element = window.Element;
  global.Node = window.Node;
  global.MouseEvent = window.MouseEvent;
  global.getComputedStyle = window.getComputedStyle.bind(window);
  global.requestAnimationFrame = window.requestAnimationFrame.bind(window);
  const sent = [];
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
  require(PRELOAD);
  Module.prototype.require = realRequire;
  await new Promise((resolve) => setTimeout(resolve, 60));

  const tell = (data) => {
    const event = new window.MessageEvent('message', { data });
    Object.defineProperty(event, 'source', { value: window.parent });
    window.dispatchEvent(event);
  };
  // The canvas tracks paths, which makes it the design canvas: clicks select.
  tell({ type: 'avb:track', paths: [], scope: '', focus: '', focusOcc: 0 });
  const home = window.document.getElementById('home');
  const last = (type) => sent.filter((message) => message.type === type).pop();
  const fire = (element, type) => element.dispatchEvent(new window.MouseEvent(type, { bubbles: true, cancelable: true }));

  fire(home, 'mousemove');
  assert.equal(last('avb:hover-node')?.path, '0', 'normal mode: the hover names the closed instance');

  tell({ type: 'avb:outline-mode', mode: 'deep' });
  fire(window.document.getElementById('hero'), 'mousemove');
  assert.equal(last('avb:hover-node')?.path, '1', 'the page own element hovers as itself');
  fire(home, 'mousemove');
  const deep = last('avb:hover-node');
  assert.equal(deep?.path, `${NAV}0.0`, 'deep mode: the hover names the NavLink instance inside Nav');
  assert.deepEqual(deep?.deep, { kind: 'component', label: 'NavLink', tag: undefined }, 'drawn as that component, as the editor draws an instance');

  fire(home, 'click');
  assert.equal(last('avb:click-node')?.path, '0', 'a click still selects the closed instance, never the link inside it');
  fire(home, 'contextmenu');
  assert.equal(last('avb:context-node')?.path, '0', 'the context menu acts on the closed instance');

  tell({ type: 'avb:outline-mode', mode: 'normal' });
  fire(window.document.getElementById('hero'), 'mousemove');
  fire(home, 'mousemove');
  assert.equal(last('avb:hover-node')?.path, '0', 'back to normal: the instance again');
  console.log('deep-outline-safety: passed');
  dom.window.close();
  process.exit(0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
