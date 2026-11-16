// Goal: every refusal the placement model makes is backed by evidence, not taste: either the
// Astro compiler rejects the structure, or the browser parses it into a different tree, or the
// compiler itself drops the structure. Every allowed placement must survive both unchanged.
// Method: for each case, build the markup the placement would write, run it through
// @astrojs/compiler (parse), compiler-rs (transform) and jsdom's spec-conforming HTML parser, and
// compare the tree that comes back with the tree that was written. The model's verdict for the
// same place is checked against that outcome. Fixtures are generated here, never a real project.
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { LIMITS } = require('#dist/shared/core/limits.js');
const { checkPlacement } = require('#dist/shared/page/placement.js');

const element = (tag) => ({ kind: 'element', tag });

// Each case: the markup, the place it describes, and what the evidence must show.
//   compilerRs: 'rejects' | 'accepts'; browser: 'keeps' | 'reparents' | 'skip'
const cases = [
  {
    name: 'doctype first',
    markup: '<!doctype html><html><body><p>x</p></body></html>',
    node: { kind: 'doctype' },
    frames: [],
    rs: 'accepts',
    browser: 'skip',
    verdict: 'ok',
  },
  {
    name: 'doctype in a div',
    markup: '<div><!doctype html></div>',
    node: { kind: 'doctype' },
    frames: [element('div')],
    rs: 'rejects',
    browser: 'skip',
    verdict: 'refused',
  },
  {
    name: 'doctype in a component',
    markup: '<Foo><!doctype html></Foo>',
    node: { kind: 'doctype' },
    frames: [{ kind: 'component', tag: undefined }],
    rs: 'rejects',
    browser: 'skip',
    verdict: 'refused',
  },
  { name: 'div in p', markup: '<p><div>x</div></p>', node: element('div'), frames: [element('p')], browser: 'reparents', verdict: 'refused' },
  { name: 'span in p', markup: '<p><span>x</span></p>', node: element('span'), frames: [element('p')], browser: 'keeps', verdict: 'ok' },
  { name: 'h2 in h1', markup: '<h1><h2>x</h2></h1>', node: element('h2'), frames: [element('h1')], browser: 'reparents', verdict: 'refused' },
  { name: 'a in a', markup: '<a href="#"><a href="#">x</a></a>', node: element('a'), frames: [element('a')], browser: 'reparents', verdict: 'refused' },
  {
    name: 'button in button',
    markup: '<button><button>x</button></button>',
    node: element('button'),
    frames: [element('button')],
    browser: 'reparents',
    verdict: 'refused',
  },
  {
    name: 'form in form',
    markup: '<form><form><p>x</p></form></form>',
    node: element('form'),
    frames: [element('form')],
    browser: 'reparents',
    verdict: 'refused',
  },
  { name: 'tr in div', markup: '<div><tr><td>a</td></tr></div>', node: element('tr'), frames: [element('div')], browser: 'reparents', verdict: 'refused' },
  { name: 'td in div', markup: '<div><td>a</td></div>', node: element('td'), frames: [element('div')], browser: 'reparents', verdict: 'refused' },
  {
    name: 'tr in tbody',
    markup: '<table><tbody><tr><td>a</td></tr></tbody></table>',
    node: element('tr'),
    frames: [element('table'), element('tbody')],
    browser: 'keeps',
    verdict: 'ok',
  },
  { name: 'div in table', markup: '<table><div>x</div></table>', node: element('div'), frames: [element('table')], browser: 'reparents', verdict: 'refused' },
  {
    name: 'div in select',
    markup: '<select><div>x</div></select>',
    node: element('div'),
    frames: [element('select')],
    browser: 'reparents',
    verdict: 'refused',
  },
  {
    name: 'style in select',
    markup: '<select><style>a{}</style><option>x</option></select>',
    node: element('style'),
    frames: [element('select')],
    browser: 'reparents',
    verdict: 'refused',
  },
  {
    name: 'option in select',
    markup: '<select><option>x</option></select>',
    node: element('option'),
    frames: [element('select')],
    browser: 'keeps',
    verdict: 'ok',
  },
  {
    name: 'html in div',
    markup: '<div><html><body>x</body></html></div>',
    node: element('html'),
    frames: [element('div')],
    browser: 'reparents',
    verdict: 'refused',
  },
  {
    name: 'head in div',
    markup: '<div><head><title>x</title></head></div>',
    node: element('head'),
    frames: [element('div')],
    browser: 'reparents',
    verdict: 'refused',
  },
  { name: 'body in div', markup: '<div><body>x</body></div>', node: element('body'), frames: [element('div')], browser: 'reparents', verdict: 'refused' },
  {
    name: 'div in head',
    markup: '<html><head><div>x</div></head><body></body></html>',
    node: element('div'),
    frames: [element('html'), element('head')],
    browser: 'reparents',
    verdict: 'refused',
  },
  {
    name: 'meta in head',
    markup: '<html><head><meta charset="utf-8"></head><body></body></html>',
    node: element('meta'),
    frames: [element('html'), element('head')],
    browser: 'keeps',
    verdict: 'ok',
  },
  { name: 'li in ul', markup: '<ul><li>x</li></ul>', node: element('li'), frames: [element('ul')], browser: 'keeps', verdict: 'ok' },
  { name: 'li in li', markup: '<li><li>x</li></li>', node: element('li'), frames: [element('li')], browser: 'reparents', verdict: 'refused' },
  {
    name: 'img with a child',
    markup: '<img><span>x</span></img>',
    node: element('span'),
    frames: [element('img')],
    browser: 'skip',
    verdict: 'refused',
    voidCompiler: true,
  },
];

// A tree as tags: text becomes `t`, whitespace is ignored; the written tree and the parsed tree must agree.
function shapeOfDom(node, depth = 0) {
  assert.ok(depth <= LIMITS.treeDepthMax, 'a fixture is shallow');
  const parts = [];
  for (const child of node.childNodes) {
    if (child.nodeType === 3) {
      if (child.textContent.trim() !== '') {
        parts.push('t');
      }
    } else if (child.nodeType === 1) {
      parts.push(`${child.localName}(${shapeOfDom(child, depth + 1)})`);
    }
  }
  return parts.join(',');
}

function shapeOfAst(node, depth = 0) {
  assert.ok(depth <= LIMITS.treeDepthMax, 'a fixture is shallow');
  if (node.type === 'text') {
    return node.value.trim() === '' ? undefined : 't';
  }
  const inner = (node.children ?? [])
    .map((child) => shapeOfAst(child, depth + 1))
    .filter((part) => part !== undefined)
    .join(',');
  if (node.type === 'element' || node.type === 'component') {
    return `${node.name.toLowerCase()}(${inner})`;
  }
  return undefined;
}

test('every case: the model agrees with the compilers and the browser', async () => {
  const { parse } = await import('@astrojs/compiler');
  const { transform } = await import('@astrojs/compiler-rs');
  for (const entry of cases) {
    const verdict = checkPlacement({ node: entry.node, frames: entry.frames, before: [], after: [], document: 'unknown' });
    const label = entry.name;
    if (entry.verdict === 'ok') {
      assert.equal(verdict.ok, true, `${label}: the model allows it`);
    } else {
      assert.equal(verdict.ok, false, `${label}: the model refuses it`);
    }
    if (entry.rs !== undefined) {
      let rejected = false;
      try {
        const result = await transform(entry.markup, { filename: '/fixture.astro' });
        rejected = (result.diagnostics ?? []).some((diagnostic) => diagnostic.severity === 1 || /unexpected/i.test(diagnostic.text));
      } catch {
        rejected = true;
      }
      assert.equal(rejected, entry.rs === 'rejects', `${label}: compiler-rs ${entry.rs}`);
    }
    if (entry.browser !== 'skip' && entry.browser !== undefined) {
      const written = (await parse(entry.markup)).ast.children
        .map(shapeOfAst)
        .filter((part) => part !== undefined)
        .join(',');
      const whole = entry.markup.startsWith('<html');
      const document = new JSDOM(whole ? entry.markup : `<!doctype html><html><body>${entry.markup}</body></html>`).window.document;
      const parsed = shapeOfDom(whole ? document : document.body);
      if (entry.browser === 'keeps') {
        assert.equal(parsed, written, `${label}: the browser keeps the written tree`);
      } else {
        assert.notEqual(parsed, written, `${label}: the browser changes the written tree (${written} -> ${parsed})`);
      }
    }
    if (entry.voidCompiler === true) {
      const written = (await parse(entry.markup)).ast.children
        .map(shapeOfAst)
        .filter((part) => part !== undefined)
        .join(',');
      assert.equal(written, 'img(),span(t)', `${label}: the compiler moves the child out of the void tag`);
    }
  }
});

test('a doctype inside a node is the structure compiler-rs refuses, and the legacy compiler accepts: the model refuses for both', async () => {
  const legacy = await import('@astrojs/compiler');
  const modern = await import('@astrojs/compiler-rs');
  const markup = '<div><!doctype html></div>';
  const legacyResult = await legacy.transform(markup, { filename: '/fixture.astro' });
  assert.equal((legacyResult.diagnostics ?? []).length, 0, 'the legacy compiler accepts it');
  const modernResult = await modern.transform(markup, { filename: '/fixture.astro' });
  assert.ok((modernResult.diagnostics ?? []).length > 0, 'compiler-rs reports it');
  assert.equal(checkPlacement({ node: { kind: 'doctype' }, frames: [element('div')], before: [], after: [], document: 'page' }).ok, false);
});
