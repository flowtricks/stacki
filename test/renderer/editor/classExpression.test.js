// Goal: adding a class preserves computed classes for Astro elements and components.
// Method: edit parsed source, compile with the real Astro compiler, and render with
// Astro's container. A counter proves the original expression still runs exactly once.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { pathToFileURL } = require('node:url');
const { parsePage, serializePage } = require('#dist/electron/parse/astroParser.js');
const load = require('../../helpers/rendererModule');
const { repoPath } = require('../../helpers/sources');
const { transform } = require(repoPath('studio/node_modules/@astrojs/compiler-rs'));
const { withClass } = load('src/editor/classAttr.ts');

async function compiledURL(source) {
  const internalURL = pathToFileURL(repoPath('studio/node_modules/astro/dist/runtime/compiler/index.js')).href;
  const compiled = await transform(source, {
    internalURL,
    filename: '/class-expression.astro',
    resolvePath: (specifier) => specifier,
    resultScopedSlot: true,
  });
  return `data:text/javascript;base64,${Buffer.from(compiled.code).toString('base64')}`;
}

test('computed classes survive visual additions and evaluate once', async () => {
  const containerURL = pathToFileURL(repoPath('studio/node_modules/astro/dist/container/index.js'));
  const { experimental_AstroContainer } = await import(containerURL.href);
  const container = await experimental_AstroContainer.create({ streaming: false });
  const cardURL = await compiledURL('<div class={Astro.props.class}></div>');
  const cases = [
    ['div', 'classes()'],
    ['Card', 'classes()'],
    ['div', 'classes() // keep this comment\n'],
    ['Card', '0, classes()'],
  ];
  for (const [tag, expression] of cases) {
    const source = [
      '---',
      `import Card from '${cardURL}';`,
      'let calls = 0;',
      'const classes = () => { calls += 1; return "computed"; };',
      '---',
      `<${tag} class={${expression}} />`,
      '<p>{calls}</p>',
    ].join('\n');
    const page = parsePage(source);
    assert.ok(page.editable);
    const node = page.model.nodes.find((node) => node.name === tag);
    assert.ok(node);
    const edit = withClass(node.props, 'added');
    assert.ok(edit);
    node.props[edit.key] = edit.value;
    if (edit.remove) {
      delete node.props[edit.remove];
    }
    const updated = serializePage(page.model, source);
    assert.ok(updated.includes(expression.trim()), 'the expression is preserved');
    const component = await import(await compiledURL(updated));
    const html = await container.renderToString(component.default, { partial: true });
    assert.match(html, /class="computed added"/);
    assert.match(html, /<p>1<\/p>/, 'the original expression runs exactly once');
  }
});
