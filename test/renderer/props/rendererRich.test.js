// Exercise the inline source/DOM contract without browser editing quirks: keep
// supported markup and expressions, flatten unknown wrappers, and reject bounds.
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const loadRenderer = require('../../helpers/rendererModule');
const { domToNodes, nodesToHtml, isInlineOnly } = loadRenderer('src/features/props/richContentModel.ts');
const dom = new JSDOM('<!doctype html><div id="host"></div>');
const host = dom.window.document.getElementById('host');
host.innerHTML = 'Hello <b title="drop">world</b><div>{post.title}</div><br>';
const nodes = domToNodes(host);
assert.deepEqual(nodes, [
  { kind: 'text', value: 'Hello ' },
  { kind: 'element', name: 'strong', props: {}, children: [{ kind: 'text', value: 'world' }] },
  { kind: 'expr', value: '{post.title}' },
  { kind: 'element', name: 'br', props: {}, children: undefined },
]);
assert.equal(isInlineOnly(nodes), true);
assert.match(nodesToHtml(nodes), /data-expr="\{post.title\}"/);
assert.equal(isInlineOnly([{ kind: 'text' }]), false);
assert.equal(
  isInlineOnly([
    {
      kind: 'element',
      name: 'span',
      props: {
        title: { type: 'string' },
      },
      children: [],
    },
  ]),
  false,
);
const text = { kind: 'text', value: '' };
assert.throws(() => nodesToHtml(Array(20001).fill(text)), /node limit exceeded/);
const cyclic = { kind: 'element', name: 'span', children: [] };
cyclic.children.push(cyclic);
assert.throws(() => isInlineOnly([cyclic]), /depth limit exceeded/);
assert.throws(() => nodesToHtml([cyclic]), /depth limit exceeded/);
host.textContent = '{a}'.repeat(20001);
assert.throws(() => domToNodes(host), /expression limit exceeded/);
host.textContent = 'x'.repeat(1000001);
assert.throws(() => domToNodes(host), /text limit exceeded/);
host.textContent = '';
let parent = host;
for (let depth = 0; depth < 66; depth++) {
  const child = dom.window.document.createElement('span');
  parent.appendChild(child);
  parent = child;
}
assert.throws(() => domToNodes(host), /DOM depth limit exceeded/);

// Text the field emits is the value the parser will hold once the save is
// written and read back: whitespace runs squeeze to one space, with one space
// kept at either boundary. The save echo comes back through the parser's own
// rule (textValue in shared/page/htmlText.ts), so anything looser made the echoed
// value differ from the last emission and the field's sync reset the caret
// mid-word.
host.textContent = 'hello  ';
assert.deepEqual(domToNodes(host), [{ kind: 'text', value: 'hello ' }]);
host.textContent = ' hello';
assert.deepEqual(domToNodes(host), [{ kind: 'text', value: ' hello' }]);
host.textContent = 'a\n b';
assert.deepEqual(domToNodes(host), [{ kind: 'text', value: 'a b' }]);
host.innerHTML = 'hi {x}  there';
assert.deepEqual(domToNodes(host), [
  { kind: 'text', value: 'hi ' },
  { kind: 'expr', value: '{x}' },
  { kind: 'text', value: ' there' },
]);
// The negative space: a U+00A0 read from `&nbsp;` is written back as `&#160;`
// and the parser keeps it, so the field keeps it too. Squeezing it as
// whitespace would rewrite the author's non-breaking space on any keystroke.
host.textContent = 'a  b ';
assert.deepEqual(domToNodes(host), [{ kind: 'text', value: 'a  b ' }]);
host.textContent = ' ';
assert.deepEqual(domToNodes(host), [{ kind: 'text', value: ' ' }]);
// Whitespace alone is no text node to the parser; one space is what a browser
// renders for it, never the two the boundary rule would give.
host.innerHTML = '<b>a</b>   <i>b</i>';
assert.deepEqual(domToNodes(host)[1], { kind: 'text', value: ' ' });
// Markup typed as words stays words: `&amp;` typed is `&amp;amp;` in the file.
host.textContent = 'a &amp; b';
assert.deepEqual(domToNodes(host), [{ kind: 'text', value: 'a &amp; b' }]);

dom.window.close();
console.log('renderer-rich: inline round trips, invalid shapes, and traversal limits passed');

// Pasted code is text, braces and all: read as bindings, `{ apiKey: "…" }`
// wrote an expression into the page that did not compile. A literal run reads
// back as text, and text holding braces is drawn as a literal run again, so
// the next edit does not turn its braces into bindings. Typing `{name}` still binds.
{
  const { plainPasteHTML } = loadRenderer('src/features/props/RichContent.tsx');
  host.innerHTML = `Install: ${plainPasteHTML('import { Pidgin } from "@pidgin/sdk";\nnew Pidgin({ apiKey: "x" });')}`;
  const pasted = domToNodes(host);
  assert.ok(
    pasted.every((node) => node.kind !== 'expr'),
    JSON.stringify(pasted),
  );
  assert.deepEqual(
    pasted.map((node) => (node.kind === 'text' ? node.value : node.name)),
    ['Install: ', 'import { Pidgin } from "@pidgin/sdk";', 'br', 'new Pidgin({ apiKey: "x" });'],
  );
  // Redrawn and read again, the braces are still text.
  host.innerHTML = nodesToHtml(pasted);
  assert.deepEqual(domToNodes(host), pasted);
  host.innerHTML = 'Hi {post.title}';
  assert.deepEqual(domToNodes(host)[1], { kind: 'expr', value: '{post.title}' }, 'a typed binding still binds');
  assert.equal(plainPasteHTML(''), '');
}
