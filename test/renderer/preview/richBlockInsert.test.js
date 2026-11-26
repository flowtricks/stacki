// Goal: a block put into rich text (an image, a video, a rule, a list) is always a block of its own: it never lands
// inside a paragraph, heading or quote; it replaces an empty line, goes before or after a block the caret is at an edge
// of, and splits one the caret is inside. What the browser's own commands leave nested is moved out before saving.
// Method: JSDOM, a caret set in the markup, and the shared functions both editors use (shared/page/richBlockDom.ts).
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const loadRenderer = require('../../helpers/rendererModule');

function editor(markup, run) {
  const dom = new JSDOM(`<!doctype html><body><div id="host">${markup}</div></body>`);
  const { window } = dom;
  for (const name of ['Node', 'Element', 'HTMLElement', 'Text']) {
    global[name] = window[name];
  }
  global.window = window;
  global.document = window.document;
  const rich = loadRenderer('shared/page/richBlockDom.ts');
  const host = window.document.getElementById('host');
  const caret = (node, offset) => {
    const range = window.document.createRange();
    range.setStart(node, offset);
    range.collapse(true);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);
    return range;
  };
  const insert = (range, kind = 'img') => rich.insertRichBlocks(host, range, [rich.richElement(window.document, kind, '/a.png')]);
  const saved = () => {
    const copy = host.cloneNode(true);
    Array.from(copy.children)
      .filter(rich.isSpareRichLine)
      .forEach((line) => line.remove());
    return copy.innerHTML.replaceAll(' data-avb-line=""', '');
  };
  try {
    run({ host, caret, insert, saved, rich });
  } finally {
    window.close();
  }
}

const IMG = '<img src="/a.png" alt="">';

test('an empty paragraph is replaced, with a line left to go on typing in', () => {
  editor('<p>one</p><p><br></p><p>two</p>', ({ host, caret, insert, saved }) => {
    insert(caret(host.children[1], 0));
    assert.equal(saved(), `<p>one</p>${IMG}<p>two</p>`);
    assert.equal(host.children.length, 4);
    assert.equal(window.getSelection().focusNode, host.children[2], 'the caret is in the spare line');
  });
});

for (const [name, tag] of [
  ['paragraph', 'p'],
  ['heading', 'h2'],
  ['quote', 'blockquote'],
]) {
  test(`the middle of a ${name} splits it around the block`, () => {
    editor(`<${tag}>onetwo</${tag}>`, ({ host, caret, insert, saved }) => {
      insert(caret(host.firstChild.firstChild, 3));
      assert.equal(saved(), `<${tag}>one</${tag}>${IMG}<${tag}>two</${tag}>`);
    });
  });
}

test('the end and the start of a paragraph keep it whole', () => {
  editor('<p>one</p><p>two</p>', ({ host, caret, insert, saved }) => {
    const first = host.firstChild;
    insert(caret(first.firstChild, 3));
    assert.equal(saved(), `<p>one</p>${IMG}<p>two</p>`);
    assert.equal(host.firstChild, first, 'the paragraph itself is kept');
  });
  editor('<p>one</p>', ({ host, caret, insert, saved }) => {
    insert(caret(host.firstChild.firstChild, 0), 'hr');
    assert.equal(saved(), '<hr><p>one</p>');
  });
});

test('a list splits between its items, and an empty item leaves it', () => {
  editor('<ul><li>a</li><li><br></li><li>b</li></ul>', ({ host, caret, insert, saved }) => {
    insert(caret(host.querySelectorAll('li')[1], 0));
    assert.equal(saved(), `<ul><li>a</li></ul>${IMG}<ul><li>b</li></ul>`);
  });
});

test('inline markup around the caret is split without leaving empty elements', () => {
  editor('<p><strong>bold</strong> after</p>', ({ host, caret, insert, saved }) => {
    insert(caret(host.querySelector('strong').firstChild, 4));
    assert.equal(saved(), `<p><strong>bold</strong></p>${IMG}<p> after</p>`);
  });
});

test('a block put in is taken back and again, until something was typed after it', () => {
  editor('<p>one</p><p><br></p>', ({ host, caret, rich }) => {
    const history = rich.createRichHistory(host);
    const before = host.innerHTML;
    const range = caret(host.children[1], 0);
    history.record(() => rich.insertRichBlocks(host, range, [rich.richElement(window.document, 'hr')]));
    const after = host.innerHTML;
    assert.equal(history.undo(), true);
    assert.equal(host.innerHTML, before);
    assert.equal(history.redo(), true);
    assert.equal(host.innerHTML, after);
    host.firstChild.firstChild.data = 'one more';
    assert.equal(history.undo(), false, 'typing is the browser history first');
  });
});

test('what is saved is valid HTML: no block inside a paragraph, no styles the browser wrote', () => {
  editor('<p><ul><li>a</li></ul></p><p>x<span style="letter-spacing: 1px">y</span></p>', ({ rich }) => {
    const root = window.document.createElement('div');
    const wrapper = window.document.createElement('p');
    const list = window.document.createElement('ul');
    list.innerHTML = '<li>a</li>';
    wrapper.append('lead ', list);
    root.append(wrapper);
    root.insertAdjacentHTML('beforeend', '<p>x<span style="letter-spacing: 1px">y</span></p>');
    rich.tidyRichContent(root);
    assert.equal(root.innerHTML, '<p>lead </p><ul><li>a</li></ul><p>xy</p>');
  });
});

test('empty paragraphs at the end are not saved; one between blocks is', () => {
  editor('', ({ rich }) => {
    assert.equal(rich.withoutTrailingEmptyBlocks('<p>a</p><p><br></p><p></p>'), '<p>a</p>');
    assert.equal(rich.withoutTrailingEmptyBlocks('<p>a</p><p></p><p>b</p>'), '<p>a</p><p></p><p>b</p>');
    assert.equal(rich.withoutTrailingEmptyBlocks('<hr><p>&nbsp;</p>'), '<hr>');
  });
});

test('typing leaves no empty block, stray non-breaking space or <b>; the author’s own are kept', () => {
  editor('', ({ rich }) => {
    const saved = (markup, opened) => {
      const root = window.document.createElement('div');
      root.innerHTML = markup;
      rich.withoutTypingResidue(root, opened);
      return root.innerHTML;
    };
    assert.equal(saved('<p>a&nbsp;<b>b</b>&nbsp;</p><p></p><ul><li></li></ul>', '<p>a</p>'), '<p>a <strong>b</strong></p>');
    assert.equal(saved('<p>a&nbsp; b</p>', '<p>a</p>'), '<p>a&nbsp; b</p>', 'two spaces stay two');
    const own = '<p>10&nbsp;km <b>x</b></p><p></p>';
    assert.equal(saved(own, own), own);
  });
});

test('a pasted image comes with its address and alt text; one carried as data does not', () => {
  editor('', () => {
    const { cleanPastedHTML } = loadRenderer('shared/page/richPaste.ts');
    const clean = (html) => cleanPastedHTML(html, window.document, { media: true });
    assert.equal(clean('<img src="https://x.test/a.png" alt="A" style="x" width="3">'), '<img src="https://x.test/a.png" alt="A">');
    assert.equal(clean('<img src="data:image/png;base64,AA">'), '');
    assert.equal(cleanPastedHTML('<img src="/a.png">', window.document), '', 'fields of words take none');
  });
});

test('Enter at the end of a quote goes on as a paragraph; inside it the browser splits it', () => {
  editor('<blockquote>quote</blockquote>', ({ host, caret, rich }) => {
    caret(host.firstChild.firstChild, 2);
    assert.equal(rich.leaveQuoteOnEnter(host, rich.createRichHistory(host)), false);
    caret(host.firstChild.firstChild, 5);
    assert.equal(rich.leaveQuoteOnEnter(host, rich.createRichHistory(host)), true);
    assert.equal(host.innerHTML, '<blockquote>quote</blockquote><p><br></p>');
  });
});

test('Backspace and Delete beside an image take it, or the empty line; never leaving loose words', () => {
  const run = (markup, at, offset, key) => {
    let result;
    editor(markup, ({ host, caret, rich }) => {
      caret(at(host), offset);
      assert.equal(rich.deleteBesideRichMedia(host, rich.createRichHistory(host), key), true);
      result = host.innerHTML;
    });
    return result;
  };
  assert.equal(
    run('<img src="/a.png"><p>after</p>', (host) => host.children[1].firstChild, 0, 'Backspace'),
    '<p>after</p>',
  );
  assert.equal(
    run('<p>before</p><hr>', (host) => host.firstChild.firstChild, 6, 'Delete'),
    '<p>before</p>',
  );
  assert.equal(
    run('<p>a</p><hr><p><br></p>', (host) => host.children[2], 0, 'Backspace'),
    '<p>a</p><hr>',
  );
});

test('words typed with the caret between blocks, whitespace and all, get a paragraph of their own', () => {
  editor('\n  <img src="/a.png">\n  ', ({ host, caret, rich }) => {
    caret(host, host.childNodes.length);
    rich.keepTypingInBlocks(host, rich.createRichHistory(host));
    assert.equal(window.getSelection().focusNode.tagName, 'P');
    assert.equal(host.lastChild.tagName, 'P');
  });
});
