// Goal: shorthand fragments parse into structure with exact source spans, keep
// their spelling on write, and carry preview markers through every wrapper.
// Method: small sources exercise each placement (conditionals, maps, roots,
// attribute and comment text that looks like a delimiter); each is parsed with
// the built parser and checked against its spans, its serialization, and the
// output of both Astro compilers.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parsePage, serializePage, serializePageMarked } = require('#dist/electron/parse/astroParser.js');

function parsed(source, options) {
  const result = parsePage(source, options);
  assert.equal(result.editable, true, result.reason);
  return result.model;
}

function fragment(node) {
  assert.equal(node.kind, 'component');
  assert.equal(node.name, 'Fragment');
  assert.equal(node.shorthand, true);
  assert.equal(node.dynamicTag, undefined);
  assert.notEqual(node.id, 'layout');
  return node;
}

test('conditional shorthand fragments expose children with exact source spans and editable ' + 'attributes', () => {
  const source =
    '---\nconst render = true;\n---\n{render && (<>\n' +
    '  <div class:list={["search", className]}>\n' +
    '    <textarea placeholder="Ask anything" />\n    <button>Search</button>\n  </div>\n' +
    '  <Modal><p>Results</p></Modal>\n</>)}\n';
  const model = parsed(source, { locs: true });
  const condition = model.nodes[0];
  assert.equal(condition.kind, 'cond');
  const group = fragment(condition.children[0].children[0]);
  assert.deepEqual(
    group.children.map((node) => node.name),
    ['div', 'Modal'],
  );
  assert.equal(source.slice(group.start, group.end), source.slice(source.indexOf('<>'), source.indexOf('</>') + 3));
  const field = group.children[0].children[0];
  assert.equal(source.slice(field.start, field.end), '<textarea placeholder="Ask anything" />');
  assert.equal(serializePage(model), source);

  field.props.placeholder.value = 'Ask a question';
  const changed = serializePage(model);
  assert.match(changed, /<textarea placeholder="Ask a question" \/>/);
  assert.match(changed, /<>[\s\S]*<\/Modal>[\s\S]*<\/>/);
  assert.equal(parsed(changed).nodes[0].children[0].children[0].children.length, 2);
  assert.equal(serializePage(parsed(changed)), changed);
});

test('concise, bare and block maps keep shorthand fragment bodies editable', () => {
  for (const expression of [
    '{items.map((item) => (<><p>{item.title}</p><hr /></>))}',
    '{items.map((item) => <><p>{item.title}</p><hr /></>)}',
    '{items.map((item) => { const title = item.title; return (<><p>{title}</p><hr /></>); })}',
  ]) {
    const source = expression + '\n';
    const model = parsed(source);
    assert.equal(model.nodes[0].kind, 'map');
    const group = fragment(model.nodes[0].children[0]);
    assert.deepEqual(
      group.children.map((node) => node.name),
      ['p', 'hr'],
    );
    assert.equal(serializePage(model), source);
    group.children[0].props.class = { type: 'string', value: 'item' };
    const changed = serializePage(model);
    assert.match(changed, /<p class="item">/);
    assert.equal(parsed(changed).nodes[0].kind, 'map');
    assert.equal(serializePage(parsed(changed)), changed);
  }
});

test('fragment matching ignores delimiter text in ' + 'attributes, comments, expressions and raw blocks', () => {
  const source =
    '{render && (<>\n' +
    '  <!-- <> </> -->\n' +
    '  <div title="</>" data-note={"<>"}>{"</>"}</div>\n' +
    '  <script is:inline>\n    const open = "<>";\n    // </> is text here\n  </script>\n' +
    '  <style>\n    .note::after { content: "</> <>"; }\n  </style>\n' +
    '  <><p>Nested</p><Fragment><span>Named</span></Fragment></>\n' +
    '  {other && (<><p>Conditional</p></>)}\n' +
    '</>)}\n';
  const model = parsed(source);
  const group = fragment(model.nodes[0].children[0].children[0]);
  assert.deepEqual(
    group.children.map((node) => node.kind),
    ['comment', 'element', 'raw', 'raw', 'component', 'cond'],
  );
  assert.equal(group.children[1].props.title.value, '</>');
  fragment(group.children[4]);
  fragment(group.children[5].children[0].children[0]);
  assert.equal(serializePage(model), source);
});

test('root fragments stay structural and switch to named syntax when given attributes', () => {
  for (const source of ['<>\n  <div>One</div>\n  <div>Two</div>\n</>\n', '<>\n\n</>\n']) {
    const model = parsed(source);
    const group = fragment(model.nodes[0]);
    assert.equal(serializePage(model), source);
    group.props.slot = { type: 'string', value: 'content' };
    const changed = serializePage(model);
    assert.match(changed, /^<Fragment slot="content">/);
    assert.match(changed, /<\/Fragment>\n$/);
    assert.equal(parsed(changed).nodes[0].props.slot.value, 'content');
  }
  const named = parsed('<Fragment><p>Text</p></Fragment>\n').nodes[0];
  assert.notEqual(named.id, 'layout');
  assert.equal(named.dynamicTag, undefined);
  assert.equal(parsePage('<>\n<p>Unclosed</p>\n').editable, false);
});

test('fragment root markers carry caller paths ' + 'through block, inline, nested and map wrappers', () => {
  const cases = [
    ['{render && (<><div>Root</div></>)}\n', '0.0.0.0'],
    ['<><span>Root</span></>\n', '0.0'],
    ['<>\n  <>\n    <div>Root</div>\n  </>\n</>\n', '0.0.0'],
    ['{items.map((item) => (<><div>{item}</div></>))}\n', '0.0.0'],
  ];
  for (const [source, path] of cases) {
    const marked = serializePageMarked(parsed(source));
    assert.ok(marked.includes(`data-avb-p={["${path}", Astro.props["data-avb-p"]].filter(Boolean).join(" ")}`), marked);
  }
  const nested = serializePageMarked(parsed('<>\n  <div><span>Nested</span></div>\n</>\n'));
  assert.match(nested, /<span data-avb-p="0\.0\.0">/);
  const forwarded = serializePageMarked(parsed('<><span {...rest}>Root</span></>\n'));
  assert.match(forwarded, /<span data-avb-p=\{\["0\.0", Astro\.props\["data-avb-p"\]\][\s\S]*?\} \{\.\.\.rest\}>/);
});

test('both Astro compilers retain preview markers around shorthand fragments', async () => {
  const sources = [
    '---\nconst render = true;\n---\n{render && (<><div>Search</div><aside>Results</aside></>)}\n',
    '---\nconst render = true;\n---\n{render ? (<><span>Yes</span> <a href="/">Home</a></>) ' + ': (<><p>No</p></>)}\n',
    '---\nconst items = [1];\n---\n{items.map((item) => (<><div>{item}</div><hr /></>))}\n',
    '<>\n  <><span>Inline root</span></>\n  <div>Block root</div>\n</>\n',
    '---\nconst { ...rest } = Astro.props;\n---\n<><span {...rest}>Root</span></>\n',
  ];
  for (const compilerName of ['@astrojs/compiler', '@astrojs/compiler-rs']) {
    const { transform } = await import(compilerName);
    for (const source of sources) {
      const model = parsed(source);
      for (const output of [serializePage(model), serializePageMarked(model)]) {
        const result = await transform(output, { filename: '/fragment.astro' });
        const errors = (result.diagnostics || []).filter((diagnostic) => diagnostic.severity === 'error' || diagnostic.severity === 1);
        assert.deepEqual(errors, [], `${compilerName}: ${output}`);
        for (const marker of new Set(output.match(/avb-[se]:[\w|./-]+?-->/g) || [])) {
          assert.ok(result.code.includes(marker), `${compilerName} dropped ${marker}`);
        }
      }
    }
  }
});
