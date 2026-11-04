// Goal: attribute-driven site animations must not repeatedly rebuild the navigator's page map.
// Also: a report the app dropped is sent again when it asks, even unchanged.
// Method: classify real MutationObserver records for restyles, class changes, markup and
// mixed batches, including script responses that turn an attribute change into new content.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { JSDOM } = require('jsdom');
const loadRenderer = require('../../helpers/rendererModule');
const { mutationKind } = loadRenderer('electron/preload/frameReports.ts');

test('attributes restyle while classes, text and structural changes still refresh the page', () => {
  const dom = new JSDOM('<!doctype html><body><div class="card">Hello</div></body>');
  global.document = dom.window.document;
  global.Element = dom.window.Element;
  const observer = new dom.window.MutationObserver(() => {});
  observer.observe(document.documentElement, {
    attributes: true,
    attributeOldValue: true,
    childList: true,
    characterData: true,
    subtree: true,
  });
  try {
    const element = document.querySelector('.card');
    for (const name of ['style', 'id', 'hidden', 'open', 'aria-expanded', 'data-progress']) {
      element.setAttribute(name, name === 'style' ? 'margin: 1px' : 'value');
      assert.equal(mutationKind(observer.takeRecords()), 'css', name);
      element.removeAttribute(name);
      assert.equal(mutationKind(observer.takeRecords()), 'css', name);
    }
    element.classList.add('is-open');
    assert.equal(mutationKind(observer.takeRecords()), 'page');
    element.classList.add('stacki-opened');
    assert.equal(mutationKind(observer.takeRecords()), 'none');
    element.setAttribute('aria-expanded', 'true');
    element.append(document.createElement('span'));
    assert.equal(mutationKind(observer.takeRecords()), 'page');
    element.firstChild.data = 'Changed';
    assert.equal(mutationKind(observer.takeRecords()), 'page');
    element.setAttribute('data-progress', '2');
    element.classList.remove('is-open');
    assert.equal(mutationKind(observer.takeRecords()), 'page');
    element.lastChild.remove();
    element.setAttribute('hidden', '');
    assert.equal(mutationKind(observer.takeRecords()), 'page');
    const style = document.createElement('style');
    document.head.append(style);
    assert.equal(mutationKind(observer.takeRecords()), 'css');
    style.textContent = '.card { display: none; }';
    assert.equal(mutationKind(observer.takeRecords()), 'css');
  } finally {
    observer.disconnect();
    dom.window.close();
  }
});

// The app drops the page's reports when its tree changes shape, then asks for
// them again. The page sent each report only when it changed, and the states
// report was not reset by that ask, so an edit that left the same nodes hidden
// or drawing ::before never had it resent: the navigator lost its ::before
// rows and hidden marks until something else on the page changed.
test('a resend request sends the node states again, though nothing changed', () => {
  const dom = new JSDOM('<!doctype html><body><!--avb-s:0--><div style="display: none">Hidden</div><!--avb-e:0--></body>', {
    pretendToBeVisual: true,
  });
  for (const name of ['window', 'document', 'Element', 'Node', 'Comment', 'Text', 'getComputedStyle']) {
    global[name] = name === 'window' ? dom.window : name === 'getComputedStyle' ? dom.window.getComputedStyle.bind(dom.window) : dom.window[name];
  }
  const sent = [];
  dom.window.parent.postMessage = (message) => sent.push(message);
  try {
    const reports = loadRenderer('electron/preload/frameReports.ts');
    const regions = loadRenderer('electron/preload/frameRegions.ts');
    regions.collectRegions();
    const states = () => sent.filter((message) => message.type === 'avb:node-states');
    reports.sendRendered();
    assert.equal(states().length, 1, 'the first pass reports the states');
    assert.deepEqual(states()[0].hidden, ['0']);
    reports.sendRendered();
    assert.equal(states().length, 1, 'an unchanged pass sends nothing new');
    reports.forgetReportedKeys();
    reports.sendRendered();
    assert.equal(states().length, 2, 'after the app asks again, the same states are sent again');
    assert.deepEqual(states()[1].hidden, ['0']);
  } finally {
    dom.window.close();
  }
});
