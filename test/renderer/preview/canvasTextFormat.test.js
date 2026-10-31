// Goal: words selected on the canvas are formatted by the Settings Content field's own code,
// and the selection message the frame sends is checked before the host acts on it.
// Method: parse real Astro pages for the model, find the element the Content field would edit,
// light the buttons from the markup around the text, and run a press in JSDOM through the same
// richFormat functions the panel uses (span and code; JSDOM has no editing commands, so bold and
// the other execCommand presses are left to the panel's own use). The selection parser is fed
// known-good and each known-bad shape.
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const loadRenderer = require('../../helpers/rendererModule');
const { parsePage } = require('#dist/electron/parse/astroParser.js');
const format = loadRenderer('src/app/model/canvasTextFormat.ts');
const { parseCanvasTextSelection } = loadRenderer('shared/properties/canvasTextOverlay.ts');

function model(source) {
  const parsed = parsePage(source, { locs: true });
  assert.equal(parsed.editable, true);
  return parsed.model.nodes;
}
function findText(nodes, value) {
  const stack = [...nodes];
  for (let guard = 0; stack.length && guard < 1000; guard++) {
    const node = stack.pop();
    if (node.kind === 'text' && node.value === value) {
      return node;
    }
    stack.push(...(node.children ?? []));
  }
  throw new Error(`no text ${value}`);
}
function withDocument(run) {
  const dom = new JSDOM('<!doctype html><body></body>');
  const saved = { document: global.document, window: global.window, Node: global.Node };
  Object.assign(global, {
    document: dom.window.document,
    window: dom.window,
    Node: dom.window.Node,
  });
  try {
    return run();
  } finally {
    Object.assign(global, saved);
    dom.window.close();
  }
}

test('the edited element is the text’s parent, or the element around its inline markup', () => {
  const nodes = model('<h2>The way <strong>Follow</strong> together</h2>');
  const plain = format.inlineRootOf(nodes, findText(nodes, ' together').id);
  assert.equal(plain.root.name, 'h2');
  assert.deepEqual(plain.trail, [2]);
  const inside = format.inlineRootOf(nodes, findText(nodes, 'Follow').id);
  assert.equal(inside.root.name, 'h2', 'a press inside <strong> can take the bold off');
  assert.deepEqual(inside.trail, [1, 0]);
  assert.equal(format.inlineRootOf(nodes, 'missing'), undefined);
});

test('content that is not plain inline content is not formatted here', () => {
  const nodes = model('<div><p>One</p> loose words</div>');
  assert.equal(format.inlineRootOf(nodes, findText(nodes, ' loose words').id), undefined);
});

test('the lit buttons are the markup the text already sits in', () => {
  const nodes = model('<p>a <strong><em>b</em></strong> c</p>');
  const found = format.inlineRootOf(nodes, findText(nodes, 'b').id);
  const states = format.inlineStatesAt(found.root.children, found.trail);
  assert.equal(states.bold, true);
  assert.equal(states.italic, true);
  assert.equal(states.code, false);
  assert.throws(
    () => format.inlineStatesAt(found.root.children, []),
    /A trail reaches a text node/,
  );
});

test('typed but unsaved words replace only the text they were typed into', () => {
  const nodes = model('<p>Hello <b>there</b> friend</p>');
  const found = format.inlineRootOf(nodes, findText(nodes, ' friend').id);
  const typed = format.inlineWithValue(found.root.children, found.trail, ' friends');
  assert.equal(typed[2].value, ' friends');
  assert.equal(typed[0].value, 'Hello ');
  assert.equal(typed[1], found.root.children[1], 'untouched nodes are the same objects');
});

test('a span press wraps the selected words, and pressing again takes it off', () => {
  withDocument(() => {
    const children = [{ kind: 'text', value: 'Find hope today' }];
    const selection = { trail: [0], start: 5, end: 9, value: 'Find hope today' };
    const wrapped = format.formatInlineSelection(children, selection, {
      kind: 'wrap',
      tag: 'span',
    });
    assert.deepEqual(
      wrapped.map((node) => node.kind),
      ['text', 'element', 'text'],
    );
    assert.equal(wrapped[1].name, 'span');
    assert.equal(wrapped[1].children[0].value, 'hope');
    const again = format.formatInlineSelection(
      wrapped,
      { trail: [1, 0], start: 0, end: 4, value: 'hope' },
      { kind: 'wrap', tag: 'span' },
    );
    assert.deepEqual(
      again.map((node) => node.kind === 'text' && node.value).join(''),
      'Find hope today',
    );
    assert.ok(!again.some((node) => node.kind === 'element'), 'the span is gone');
    assert.equal(document.body.children.length, 0, 'the working copy is removed');
  });
});

test('a press refuses text that does not read what the canvas selected', () => {
  withDocument(() => {
    const children = [{ kind: 'text', value: 'Find hope' }];
    const stale = { trail: [0], start: 0, end: 4, value: 'Lose hope' };
    assert.equal(
      format.formatInlineSelection(children, stale, { kind: 'wrap', tag: 'code' }),
      undefined,
    );
    assert.throws(
      () =>
        format.formatInlineSelection(
          children,
          { ...stale, start: 4, end: 4 },
          {
            kind: 'wrap',
            tag: 'code',
          },
        ),
      /A format acts on selected words/,
    );
    assert.equal(
      format.formatInlineSelection(
        children,
        { trail: [0], start: 0, end: 4, value: 'Find hope' },
        {
          kind: 'link',
          url: '   ',
        },
      ),
      undefined,
      'an empty link changes nothing',
    );
  });
});

test('the selection message is parsed before the host acts on it', () => {
  const good = {
    type: 'avb:text-selection',
    session: 's',
    key: '0.1',
    range: { start: 2, end: 6, rect: { x: 10, y: 20, w: 30, h: 12 } },
  };
  assert.deepEqual(parseCanvasTextSelection(good), good);
  const cleared = parseCanvasTextSelection({
    type: 'avb:text-selection',
    session: 's',
    key: '0.1',
  });
  assert.equal(cleared.range, undefined);
  assert.equal(parseCanvasTextSelection({ type: 'avb:text-active' }), undefined);
  const bad = (range) => () =>
    parseCanvasTextSelection({ ...good, range: { ...good.range, ...range } });
  assert.throws(bad({ start: 6, end: 6 }), /non-empty text selection/);
  assert.throws(bad({ start: -1 }), /outside the editing limit/);
  assert.throws(bad({ end: 10_001 }), /outside the editing limit/);
  assert.throws(bad({ start: 1.5 }), /Expected a text offset/);
  assert.throws(bad({ rect: { x: Number.NaN, y: 0, w: 1, h: 1 } }), /selection coordinate/);
  assert.throws(bad({ rect: { x: 0, y: 0, w: -1, h: 1 } }), /non-negative selection size/);
  assert.throws(bad({ rect: { x: 2e6, y: 0, w: 1, h: 1 } }), /off the page/);
});

// The frame's text and the source text can differ in whitespace alone — a component's template
// indentation around a trimmed slot. Positions cross folded, and land on the same words.
test('a selection crosses as shown characters and lands on the same words', () => {
  const { canvasTextFolded, canvasTextUnfolded } = loadRenderer('shared/properties/canvasText.ts');
  const rendered = '\n        Find hope. Let’s change the world together!\n      ';
  const source = ' Find hope. Let’s change the world together! ';
  const start = rendered.indexOf('together');
  const folded = {
    start: canvasTextFolded(rendered, start),
    end: canvasTextFolded(rendered, start + 'together'.length),
  };
  const at = canvasTextUnfolded(source, folded.start, 'start');
  const to = canvasTextUnfolded(source, folded.end, 'end');
  assert.equal(source.slice(at, to), 'together');
  assert.equal(canvasTextFolded('a   b', 5), 3, 'a run of spaces is one');
  assert.equal(canvasTextUnfolded('a   b', 2, 'start'), 4, 'a start skips to the next word');
  assert.equal(canvasTextUnfolded('a   b', 1, 'end'), 1, 'an end stays after the last word');
  assert.equal(canvasTextUnfolded('ab', 5, 'end'), undefined, 'past the text');
  assert.throws(() => canvasTextFolded('ab', 3), /outside its text/);
  assert.throws(() => canvasTextUnfolded('ab', -1, 'start'), /non-negative integer/);
});
