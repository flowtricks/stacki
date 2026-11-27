// Goal: after a patch the canvas shows what a fresh load shows, on a page whose own scripts
// have changed it. Four ways it did not, found by comparing a patched canvas with a fresh
// load of a Lumos site:
// - a paragraph inserted before another was written INTO the old one, and the old one built
//   anew; the lines a text script had split the old one into stayed under the new class and
//   the new words never appeared;
// - two swapped siblings were each rewritten into the other, so what an entrance script held
//   invisible on one hid the other's content;
// - a style edit wrote the whole attribute and took away the `visibility: visible` a text
//   entrance had set;
// - words a script had split into lines never changed again, and a video whose <source>
//   changed kept playing the old file.
// Method: jsdom, the real patch modules, driven as the morph client drives them: the live
// page is the previous rendering plus what a "script" did to it.

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { JSDOM } = require('jsdom');
const loadMorphModules = require('../../helpers/morphModules.js');

function setup(body) {
  const dom = new JSDOM(`<!doctype html><body>${body}</body>`);
  global.document = dom.window.document;
  const morph = loadMorphModules();
  const parse = (markup) => new dom.window.DOMParser().parseFromString(`<!doctype html><body>${markup}</body>`, 'text/html').body;
  let previous = parse(body);
  const apply = (markup) => {
    const next = parse(markup);
    morph.patchChildren(dom.window.document.body, previous, next);
    previous = next;
  };
  return { document: dom.window.document, apply, morph };
}

// What a line-splitting text entrance leaves: the words in one wrapper per line.
function splitIntoLines(element, lines) {
  element.replaceChildren(...lines.map((line) => Object.assign(element.ownerDocument.createElement('div'), { textContent: line })));
  element.style.visibility = 'visible';
}

const PARAGRAPH = '<p class="text" data-avb-p="0.0">A long mission statement</p>';

test('a paragraph inserted before a split one is new; the split one is left alone', () => {
  const { document, apply } = setup(PARAGRAPH);
  const old = document.querySelector('p');
  splitIntoLines(old, ['A long mission', 'statement']);
  apply('<p class="faded" data-avb-p="0.0">Added line</p><p class="text" data-avb-p="0.1">A long mission statement</p>');
  const [added, kept] = document.querySelectorAll('p');
  assert.equal(added.textContent, 'Added line');
  assert.equal(added.children.length, 0);
  assert.equal(kept, old, 'the unchanged paragraph is the same node, whatever its path became');
  assert.equal(kept.getAttribute('class'), 'text');
  assert.equal(kept.getAttribute('data-avb-p'), '0.1');
});

test('of two swapped siblings one is kept as it is and the other built anew', () => {
  const rich = '<div class="rich">Words</div>';
  const buttons = '<div class="buttons">View</div>';
  const { document, apply } = setup(`<h2>Title</h2>${rich}${buttons}<div class="grid"></div>`);
  const held = document.querySelector('.buttons');
  held.style.visibility = 'hidden';
  apply(`${buttons}${rich}<div class="grid"></div>`);
  const [first, second] = document.querySelectorAll('div');
  assert.deepEqual([first.textContent, second.textContent], ['View', 'Words']);
  assert.equal(second.hasAttribute('style'), false, 'what held the buttons hidden never moves to the words');
});

test('lists without an unchanged node are still lined up by kind', () => {
  const { document, apply } = setup('<p class="a">one</p><p class="b">two</p>');
  const [first, second] = document.querySelectorAll('p');
  apply('<p class="c">uno</p><p class="d">dos</p>');
  assert.deepEqual([...document.querySelectorAll('p')], [first, second]);
  assert.equal(document.body.textContent, 'unodos');
});

test('a style edit keeps what the page wrote into the same attribute', () => {
  const heading = (style) => `<h2 class="heading" style="${style}">Title</h2>`;
  const { document, apply } = setup(heading('--_mw: 17ch; margin: 0'));
  const live = document.querySelector('h2');
  live.style.visibility = 'visible';
  apply(heading('--_mw: 24ch; margin: 0'));
  assert.equal(live.style.getPropertyValue('--_mw'), '24ch');
  assert.equal(live.style.visibility, 'visible');
  assert.equal(live.style.margin, '0px');
  apply(heading('margin: 0'));
  assert.equal(live.style.getPropertyValue('--_mw'), '', 'what the server dropped goes');
  assert.equal(live.style.visibility, 'visible');
  apply('<h2 class="heading">Title</h2>');
  assert.equal(live.style.margin, '');
  assert.equal(live.style.visibility, 'visible', 'removing the server style leaves the page its own');
});

test('a style the page never touched is written as the server wrote it, and goes when dropped', () => {
  const { document, apply } = setup('<h2 style="color:red">Title</h2>');
  apply('<h2 style="background: url(&quot;data:image/svg+xml;utf8,a&quot;) ;color:blue">Title</h2>');
  assert.equal(document.querySelector('h2').getAttribute('style'), 'background: url("data:image/svg+xml;utf8,a") ;color:blue');
  apply('<h2>Title</h2>');
  assert.equal(document.querySelector('h2').hasAttribute('style'), false);
});

test('a semicolon inside a value does not end a declaration being merged', () => {
  const box = (color) => `<div style="--icon: url('data:image/svg+xml;utf8,<svg/>'); color: ${color}">x</div>`;
  const { document, apply } = setup(box('red'));
  const live = document.querySelector('div');
  live.style.opacity = '0.5';
  apply(box('blue'));
  assert.equal(live.style.color, 'blue');
  assert.equal(live.style.opacity, '0.5');
  assert.match(live.style.getPropertyValue('--icon'), /data:image\/svg\+xml;utf8/);
});

test('new words reach an element a script split into lines, out of reach of its revert', () => {
  const heading = (words) => `<h2 class="heading" data-avb-p="0.0"><strong>Crafted</strong> ${words}</h2>`;
  const { document, apply } = setup(heading('to fit into everyday life'));
  const split = document.querySelector('h2');
  const saved = split.innerHTML;
  splitIntoLines(split, ['Crafted to fit into', 'everyday life']);
  split.setAttribute('aria-label', 'Crafted to fit into everyday life');
  split.classList.add('is-split');
  apply(heading('to fit into daily life'));
  const live = document.querySelector('h2');
  assert.equal(live.innerHTML, '<strong>Crafted</strong> to fit into daily life');
  assert.equal(live.style.visibility, 'visible', 'what the script set on the element stays');
  assert.equal(live.classList.contains('is-split'), true);
  assert.equal(live.hasAttribute('aria-label'), false, 'the label said the old words');
  split.innerHTML = saved; // The split's revert, whenever its animation ends.
  assert.equal(document.querySelector('h2').textContent, 'Crafted to fit into daily life');
  apply(heading('to fit into any life'));
  assert.equal(document.querySelector('h2').textContent, 'Crafted to fit into any life', 'and later edits land');
});

test('negative space: a split element keeps its lines when only its attributes change', () => {
  const { document, apply } = setup('<h2 class="a">Same words</h2>');
  const live = document.querySelector('h2');
  splitIntoLines(live, ['Same', 'words']);
  apply('<h2 class="b">Same words</h2>');
  assert.equal(document.querySelector('h2'), live);
  assert.equal(live.children.length, 2);
});

test('negative space: words the script itself changed, and blocks it rearranged, are left to it', () => {
  const counter = setup('<p class="count">0</p>');
  counter.document.querySelector('p').textContent = '1,204';
  const live = counter.document.querySelector('p');
  counter.apply('<p class="count">10</p>');
  assert.equal(counter.document.querySelector('p'), live);
  assert.equal(live.textContent, '1,204');

  const blocks = setup('<div class="slider"><div>One</div></div>');
  const slider = blocks.document.querySelector('.slider');
  slider.innerHTML = '<div class="track"><div>One</div></div>';
  blocks.apply('<div class="slider"><div>Two</div></div>');
  assert.equal(blocks.document.querySelector('.slider'), slider);
  assert.equal(slider.firstElementChild?.className, 'track', 'a block the script wrapped is not rebuilt as words are');
});

test('a video whose source changed loads it; one left alone is not restarted', () => {
  const video = (source, title) => `<video title="${title}" muted><source src="${source}" type="video/mp4"></video>`;
  const { document, apply } = setup(video('/a.mp4', 'one'));
  let loads = 0;
  document.querySelector('video').load = () => {
    loads += 1;
  };
  apply(video('/a.mp4', 'two'));
  assert.equal(loads, 0);
  apply(video('/b.mp4', 'two'));
  assert.equal(loads, 1);
  assert.equal(document.querySelector('source').getAttribute('src'), '/b.mp4');
});
