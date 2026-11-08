// Goal: a drag selection across a <br> or inline child survives mouse up. Replacing one across
// a <br> changes only words; words in an inline child are authored content and are never replaced.
// Method: open a real canvas text session in JSDOM over the markup the preview renders, feed
// it the mouse events a drag produces, then exercise the run buffer and the combined source
// edit directly. JSDOM lays nothing out, so caretRangeFromPoint is stubbed with the point the
// release would hit; real pointer input is covered by studio/test/canvasTextBreak.browser.ts.
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const loadRenderer = require('../../helpers/rendererModule');
const { parsePage } = require('#dist/electron/parse/astroParser.js');
const { canvasTextPlans, applyCanvasText, applyCanvasTexts } = loadRenderer('src/features/preview/canvasTextSource.ts');
const { parseCanvasTextCatalog, parseCanvasTextEvent } = loadRenderer('shared/properties/canvasText.ts');

const pathFor = (id) => id.replace(/^n/, '');
const HERO_SOURCE = '<h1>Messaging with<br class="hero_break" />actual wings.</h1>';
const HERO_HTML = '<h1 data-avb-p="0">Messaging with<br class="hero_break" data-avb-p="0.1">actual wings.</h1><p id="away" data-avb-p="1">Away</p>';
const INLINE_SOURCE = '<p>Hello <strong>bold words</strong> again</p>';
const INLINE_HTML = '<p data-avb-p="0">Hello <strong data-avb-p="0.1">bold words</strong> again</p>';

function plans(source) {
  const parsed = parsePage(source, { locs: true });
  assert.equal(parsed.editable, true);
  return canvasTextPlans(source, parsed.model.nodes, pathFor);
}

// A page with an open editor on the text that reads `opened`, and what the frame posted.
function session(html, source, opened, run) {
  const dom = new JSDOM(`<!doctype html><body>${html}</body>`, { pretendToBeVisual: true });
  const { window } = dom;
  for (const name of ['HTMLElement', 'Node', 'Element', 'Text', 'Comment', 'NodeFilter', 'AbortController', 'InputEvent', 'getComputedStyle']) {
    global[name] = window[name];
  }
  global.window = window;
  global.document = window.document;
  global.location = window.location;
  global.CSSStyleSheet = class {
    replaceSync() {}
  };
  // JSDOM lays nothing out: every box is empty at the origin.
  window.Range.prototype.getBoundingClientRect = () => new window.DOMRect(0, 0, 0, 0);
  let caret;
  window.document.caretRangeFromPoint = () => caret;
  window.document.adoptedStyleSheets = [];
  const posted = [];
  const { createCanvasTextSession } = loadRenderer('electron/preload/frameTextSession.ts');
  const { matchCanvasText } = loadRenderer('electron/preload/frameTextMatch.ts');
  const targets = plans(source).map((plan) => plan.target);
  const catalog = { type: 'avb:text-catalog', session: 'one', file: 'src/pages/index.astro', checksum: 'a'.repeat(64), targets };
  const canvas = createCanvasTextSession((message) => posted.push(message));
  canvas.receive(catalog);
  const target = targets.find((entry) => entry.value === opened);
  const holder = window.document.querySelector(`[data-avb-p="${target.parent}"]`);
  const place = { clientX: 0, clientY: 0 };
  const point = (node, offset) => {
    const range = window.document.createRange();
    range.setStart(node, offset);
    range.collapse(true);
    return range;
  };
  try {
    canvas.open(target, matchCanvasText(target, holder), place);
    run({
      window,
      canvas,
      posted,
      // Presses at one text point and releases at another, as a drag does.
      drag: (start, end, holderOfBoth) => {
        start.node.parentElement.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, button: 0 }));
        const selection = window.getSelection();
        selection.setBaseAndExtent(start.node, start.offset, end.node, end.offset);
        caret = end.outside ? undefined : point(end.node, end.offset);
        return { target: holderOfBoth, clientX: 1, clientY: 1 };
      },
      click: (node, offset) => {
        node.parentElement.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, button: 0 }));
        window.getSelection().collapse(node, offset);
        caret = point(node, offset);
        return { target: node.parentElement, clientX: 1, clientY: 1 };
      },
    });
  } finally {
    canvas.dismiss();
    window.close();
  }
}

test('a drag across a <br> belongs to the editor in either direction', () => {
  session(HERO_HTML, HERO_SOURCE, 'Messaging with', ({ window, canvas, drag }) => {
    const heading = window.document.querySelector('h1');
    const [first, , second] = heading.childNodes;
    assert.equal(canvas.contains(drag({ node: first, offset: 10 }, { node: second, offset: 6 }, heading)), true, 'down across the break');
    assert.equal(canvas.contains(drag({ node: second, offset: 6 }, { node: first, offset: 10 }, heading)), true, 'up across the break');
  });
  session(HERO_HTML, HERO_SOURCE, 'actual wings.', ({ window, canvas, drag }) => {
    const heading = window.document.querySelector('h1');
    const [first, , second] = heading.childNodes;
    assert.equal(canvas.contains(drag({ node: second, offset: 6 }, { node: first, offset: 10 }, heading)), true, 'opened on the lower run');
    assert.equal(canvas.contains(drag({ node: first, offset: 10 }, { node: second, offset: 6 }, heading)), true, 'pressed on the other run');
  });
});

test('a drag across or out of an inline child belongs to the editor', () => {
  session(INLINE_HTML, INLINE_SOURCE, 'Hello ', ({ window, canvas, drag }) => {
    const paragraph = window.document.querySelector('p');
    const [before, strong, after] = paragraph.childNodes;
    assert.equal(canvas.contains(drag({ node: before, offset: 2 }, { node: strong.firstChild, offset: 4 }, paragraph)), true, 'into the child');
    assert.equal(canvas.contains(drag({ node: before, offset: 2 }, { node: after, offset: 3 }, paragraph)), true, 'past the child');
  });
  session(INLINE_HTML, INLINE_SOURCE, 'bold words', ({ window, canvas, drag }) => {
    const paragraph = window.document.querySelector('p');
    const [, strong, after] = paragraph.childNodes;
    // The browser keeps the selection inside the editing host; the click lands outside it.
    const release = drag({ node: strong.firstChild, offset: 2 }, { node: strong.firstChild, offset: 10, outside: true }, paragraph);
    assert.equal(after.isConnected, true);
    assert.equal(canvas.contains(release), true, 'released beyond the child');
  });
});

test('words selected inside inline markup are offered to the bar as the text they sit in', () => {
  // The editor opens on the words beside <strong>; selecting inside it must report the
  // strong's own text, so the host lights Bold and a press can take it off again.
  session(INLINE_HTML, INLINE_SOURCE, 'Hello ', ({ window, posted }) => {
    const paragraph = window.document.querySelector('p');
    const [before, strong, after] = paragraph.childNodes;
    const selectionsAfter = (start, end) => {
      const count = posted.length;
      window.getSelection().setBaseAndExtent(start.node, start.offset, end.node, end.offset);
      window.document.dispatchEvent(new window.Event('selectionchange'));
      return posted.slice(count).filter((message) => message.type === 'avb:text-selection');
    };
    const keyOf = (value) => plans(INLINE_SOURCE).find((plan) => plan.target.value === value).target.key;
    const inside = selectionsAfter({ node: strong.firstChild, offset: 0 }, { node: strong.firstChild, offset: 4 });
    assert.equal(inside.length, 1);
    assert.equal(inside[0].key, keyOf('bold words'), 'the strong’s text, not the opened one');
    assert.deepEqual([inside[0].range.start, inside[0].range.end], [0, 4]);
    const own = selectionsAfter({ node: before, offset: 0 }, { node: before, offset: 5 });
    assert.equal(own[0].key, keyOf('Hello '), 'the opened words still report as themselves');
    assert.deepEqual([own[0].range.start, own[0].range.end], [0, 5]);
    // Across the markup there is no one text to format: the bar goes.
    const across = selectionsAfter({ node: before, offset: 2 }, { node: after, offset: 3 });
    assert.equal(across.length, 1);
    assert.equal(across[0].range, undefined);
  });
});

test('plain clicks keep their meaning while an editor is open', () => {
  session(HERO_HTML, HERO_SOURCE, 'Messaging with', ({ window, canvas, click, drag }) => {
    const heading = window.document.querySelector('h1');
    const [first, , second] = heading.childNodes;
    assert.equal(canvas.contains(click(first, 3)), true, 'a click in the edited words places the caret');
    assert.equal(canvas.contains(click(second, 3)), false, 'a click on the other words leaves the editor');
    const away = window.document.querySelector('#away');
    assert.equal(canvas.contains(click(away.firstChild, 1)), false, 'a click away ends editing');
    // A selection left behind never claims a click that was pressed elsewhere.
    drag({ node: first, offset: 2 }, { node: first, offset: 6 }, heading);
    away.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, button: 0 }));
    assert.equal(canvas.contains({ target: away, clientX: 1, clientY: 1 }), false, 'pressed outside');
  });
});

test('typing over a selection across a <br> keeps the break, and undo restores both runs', () => {
  const dom = new JSDOM(HERO_HTML);
  const { window } = dom;
  global.window = window;
  global.document = window.document;
  try {
    const { createTextBuffer } = loadRenderer('electron/preload/frameTextBuffer.ts');
    const heading = window.document.querySelector('h1');
    const [first, breakElement, second] = heading.childNodes;
    const drafts = [];
    const buffer = createTextBuffer(heading, { runs: [[first], [second]], primary: 0 }, (value) => drafts.push(value));
    const seam = first.length + 1; // The start of the second run.
    assert.equal(buffer.crosses({ start: 10, end: seam + 6 }), true);
    assert.equal(buffer.crosses({ start: seam, end: seam + 6 }), false);
    assert.equal(buffer.words({ start: seam, end: seam + 6 }), 'actual');
    assert.equal(buffer.words({ start: 10, end: seam + 6 }), undefined);
    buffer.replace({ start: 10, end: seam + 6 }, 'real');
    assert.equal(first.data, 'Messaging real');
    assert.equal(second.data, ' wings.');
    assert.equal(heading.childNodes[1], breakElement, 'the break is the same element');
    assert.deepEqual(buffer.changes(), [
      { run: 0, value: 'Messaging real' },
      { run: 1, value: ' wings.' },
    ]);
    assert.equal(buffer.spread(), true);
    buffer.history('undo');
    assert.equal(heading.textContent, 'Messaging withactual wings.');
    assert.deepEqual(buffer.changes(), []);
    assert.equal(buffer.spread(), false);
    assert.deepEqual(drafts, ['Messaging real', 'Messaging with']);
  } finally {
    window.close();
  }
});

test('a caret keeps its side of the seam, and the seam itself is not deletable', () => {
  const dom = new JSDOM(HERO_HTML);
  const { window } = dom;
  global.window = window;
  global.document = window.document;
  try {
    const { createTextBuffer } = loadRenderer('electron/preload/frameTextBuffer.ts');
    const heading = window.document.querySelector('h1');
    const [first, , second] = heading.childNodes;
    const buffer = createTextBuffer(heading, { runs: [[first], [second]], primary: 0 });
    const seam = first.length + 1;
    buffer.replace({ start: seam, end: seam }, 'X');
    assert.equal(first.data, 'Messaging with', 'typed after the break, not before it');
    assert.equal(second.data, 'Xactual wings.');
    assert.equal(window.getSelection().anchorNode, second);
    buffer.history('undo');
    buffer.replace({ start: first.length, end: seam }, '');
    assert.equal(heading.textContent, 'Messaging withactual wings.');
    assert.deepEqual(buffer.changes(), [], 'a Delete at the end of a run changes nothing');
    assert.throws(() => buffer.replace({ start: 0, end: seam + second.length + 1 }, ''), /must stay inside its segment/);
    buffer.replace({ start: 0, end: seam + second.length }, 'All');
    assert.equal(first.data, 'All');
    assert.equal(second.data, '');
  } finally {
    window.close();
  }
});

test('a caret delete stops at the run edge, and typing over an inline child is refused', () => {
  const input = (window, inputType, data, ranges) => {
    const event = new window.InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType, data });
    event.getTargetRanges = () => ranges;
    return event;
  };
  session(HERO_HTML, HERO_SOURCE, 'Messaging with', ({ window }) => {
    const heading = window.document.querySelector('h1');
    const [first, , second] = heading.childNodes;
    window.getSelection().collapse(first, first.length);
    const forward = window.document.createRange();
    forward.setStart(first, first.length);
    forward.setEnd(second, 1);
    heading.dispatchEvent(input(window, 'deleteContentForward', undefined, [forward]));
    assert.equal(heading.textContent, 'Messaging withactual wings.', 'Delete at the end of a run');
    window.getSelection().collapse(second, 0);
    const backward = window.document.createRange();
    backward.setStart(first, first.length - 1);
    backward.setEnd(second, 0);
    heading.dispatchEvent(input(window, 'deleteContentBackward', undefined, [backward]));
    assert.equal(heading.textContent, 'Messaging withactual wings.', 'Backspace at the start of a run');
    window.getSelection().setBaseAndExtent(first, 10, second, 6);
    heading.dispatchEvent(input(window, 'insertText', 'real', []));
    assert.equal(heading.textContent, 'Messaging real wings.', 'a selection does cross');
    assert.ok(heading.querySelector('br'));
  });
  session(INLINE_HTML, INLINE_SOURCE, 'Hello ', ({ window, posted }) => {
    const paragraph = window.document.querySelector('p');
    const [before, strong] = paragraph.childNodes;
    window.getSelection().setBaseAndExtent(before, 2, strong.firstChild, 4);
    paragraph.dispatchEvent(input(window, 'insertText', 'x', []));
    assert.equal(paragraph.textContent, 'Hello bold words again');
    assert.equal(posted.at(-1).type, 'avb:text-refused');
  });
});

test('only literal neighbours join the editor, and other words end the run list', () => {
  const runs = (html, source, opened, check) => {
    session(html, source, opened, () => {
      const { matchCanvasText, textRunsAround } = loadRenderer('electron/preload/frameTextMatch.ts');
      const targets = plans(source).map((plan) => plan.target);
      const target = targets.find((entry) => entry.value === opened);
      const element = document.querySelector(`[data-avb-p="${target.parent}"]`);
      const catalog = { targets };
      const found = textRunsAround(catalog, { target, match: matchCanvasText(target, element) });
      check(found.map((run) => run.target.value));
    });
  };
  runs(HERO_HTML, HERO_SOURCE, 'Messaging with', (values) => assert.deepEqual(values, ['Messaging with', 'actual wings.']));
  runs(HERO_HTML, HERO_SOURCE, 'actual wings.', (values) => assert.deepEqual(values, ['Messaging with', 'actual wings.']));
  runs(INLINE_HTML, INLINE_SOURCE, 'Hello ', (values) => assert.deepEqual(values, ['Hello ']));
  runs(INLINE_HTML, INLINE_SOURCE, ' again', (values) => assert.deepEqual(values, [' again']));
  runs(INLINE_HTML, INLINE_SOURCE, 'bold words', (values) => assert.deepEqual(values, ['bold words']));
  const shared = '---\nconst title = "Shared";\n---\n<p>Before <b>{title}</b> after</p>';
  runs('<p data-avb-p="0">Before <b data-avb-p="0.1">Shared</b> after</p>', shared, 'Before ', (values) => assert.deepEqual(values, ['Before ']));
  runs('<p data-avb-p="0">Before <b data-avb-p="0.1">Shared</b> after</p>', shared, ' after', (values) => assert.deepEqual(values, [' after']));
});

test('a combined save rewrites only the words of each text, as one edit', () => {
  const edits = plans(HERO_SOURCE);
  const [first, second] = edits;
  const value = applyCanvasTexts(HERO_SOURCE, [
    { plan: first, value: 'Messaging real' },
    { plan: second, value: ' wings.' },
  ]);
  assert.equal(value, '<h1>Messaging real<br class="hero_break" /> wings.</h1>');
  const reversed = applyCanvasTexts(HERO_SOURCE, [
    { plan: second, value: 'B' },
    { plan: first, value: 'A' },
  ]);
  assert.equal(reversed, '<h1>A<br class="hero_break" />B</h1>', 'order does not matter');
  assert.equal(applyCanvasTexts(HERO_SOURCE, [{ plan: first, value: 'A' }]), applyCanvasText(HERO_SOURCE, first, 'A'));
  assert.equal(
    applyCanvasTexts(HERO_SOURCE, [
      { plan: first, value: '' },
      { plan: second, value: '' },
    ]),
    '<h1><br class="hero_break" /></h1>',
    'the break outlives its words',
  );
  assert.throws(() => applyCanvasTexts(HERO_SOURCE, []), /has edits/);
  assert.throws(
    () =>
      applyCanvasTexts(HERO_SOURCE, [
        { plan: first, value: 'A' },
        { plan: first, value: 'B' },
      ]),
    /do not overlap/,
  );
});

test('literal text is marked, and only literal text', () => {
  const [literal] = plans('<p>Words</p>');
  assert.equal(literal.target.literal, true);
  const [shared] = plans('---\nconst title = "Shared";\n---\n<p>{title}</p>');
  assert.equal(shared.target.literal, undefined);
  const catalog = { type: 'avb:text-catalog', session: 'one', file: 'a.astro', checksum: 'a'.repeat(64), targets: [literal.target] };
  assert.equal(parseCanvasTextCatalog(catalog).targets[0].literal, true);
  assert.throws(() => parseCanvasTextCatalog({ ...catalog, targets: [{ ...literal.target, literal: false }] }), /literal/);
});

test('a combined save message is parsed and bounded', () => {
  const save = { type: 'avb:text-save', session: 'one', key: '0.0', value: 'A' };
  assert.deepEqual(parseCanvasTextEvent(save), save);
  const also = [{ key: '0.2', value: '' }];
  assert.deepEqual(parseCanvasTextEvent({ ...save, also }).also, also);
  assert.throws(() => parseCanvasTextEvent({ ...save, also: [] }), /bounded list/);
  assert.throws(() => parseCanvasTextEvent({ ...save, also: Array.from({ length: 101 }, () => also[0]) }), /bounded list/);
  assert.throws(() => parseCanvasTextEvent({ ...save, also: [{ key: '0.2' }] }));
  assert.throws(() => parseCanvasTextEvent({ ...save, also: [{ key: '0.2', value: 'x'.repeat(10001) }] }), /exceeds limit/);
  const draft = parseCanvasTextEvent({ type: 'avb:text-draft', session: 'one', key: '0.0', value: 'A', also });
  assert.equal(draft.also, undefined, 'a draft names one text');
});
