// Goal: a map callback returning conditional JSX exposes both rendered branches.
// Method: parse the navigation shape, check source locations and round trips,
// edit one branch, then compile the marked preview with both Astro compilers.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parsePage, serializePage, serializePageMarked } = require('#dist/electron/parse/astroParser.js');

const navigation = `<nav>
  {settings.mainNav.map((item) =>
    "children" in item ? (
      <details class="nav_dropdown">
        <summary>
          {item.label}
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M16.293 9.293 12 13.586 7.707 9.293" fill="currentColor" />
          </svg>
        </summary>
        <div class="nav_submenu">
          {item.children?.map((link) => (
            <a class="nav_sublink" href={link.href}>{link.label}</a>
          ))}
        </div>
      </details>
    ) : (
      <a class="nav_link" href={item.href}
        aria-current={current === item.href ? "page" : undefined}>
        {item.label}
      </a>
    ),
  )}
</nav>
`;

function navigationLoop(source) {
  const result = parsePage(source, { locs: true });
  assert.equal(result.editable, true, result.reason);
  const loop = result.model.nodes[0]?.children?.[0];
  assert.equal(loop?.kind, 'map');
  return { model: result.model, loop };
}

test('conditional map branches and nested links are editable with source locations', async () => {
  const { model, loop } = navigationLoop(navigation);
  const condition = loop.children[0];
  assert.equal(condition.kind, 'cond');
  assert.equal(condition.test, '"children" in item');
  const dropdown = condition.children[0]?.children?.[0];
  const link = condition.children[1]?.children?.[0];
  assert.equal(dropdown?.name, 'details');
  assert.equal(link?.name, 'a');
  assert.equal(navigation.slice(dropdown.start, dropdown.end).startsWith('<details'), true);
  assert.equal(navigation.slice(link.start, link.end).startsWith('<a'), true);
  const nested = dropdown.children[1]?.children?.[0];
  assert.equal(nested?.kind, 'map');
  assert.equal(nested.children[0]?.name, 'a');
  assert.equal(serializePage(model), navigation);

  link.props.class.value = 'nav_primary';
  const changed = serializePage(model);
  assert.match(changed, /class="nav_primary"/);
  assert.equal(navigationLoop(changed).loop.children[0].kind, 'cond');
  const { transform } = await import('@astrojs/compiler');
  const result = await transform(changed, { filename: '/Nav.astro' });
  assert.deepEqual(
    (result.diagnostics || []).filter((diagnostic) => diagnostic.severity === 'error'),
    [],
  );
});

test('parenthesized conditional callback also stays structural', () => {
  const source = '{items.map((item) => (item.featured ? (<strong>{item.name}</strong>) : ' + '(<span>{item.name}</span>)))}\n';
  const result = parsePage(source);
  assert.equal(result.editable, true, result.reason);
  assert.equal(result.model.nodes[0]?.kind, 'map');
  assert.equal(result.model.nodes[0]?.children?.[0]?.kind, 'cond');
  assert.equal(serializePage(result.model), source);
});

test('conditional map preview compiles with editable branch markers', async () => {
  const marked = serializePageMarked(navigationLoop(navigation).model);
  assert.match(marked, /nav_dropdown[^>]*data-avb-p/);
  assert.match(marked, /nav_link[^>]*data-avb-p/);
  for (const compilerName of ['@astrojs/compiler', '@astrojs/compiler-rs']) {
    const { transform } = await import(compilerName);
    const result = await transform(marked, { filename: '/Nav.astro' });
    const errors = (result.diagnostics || []).filter((diagnostic) => diagnostic.severity === 'error' || diagnostic.severity === 1);
    assert.deepEqual(errors, [], compilerName);
  }
});
