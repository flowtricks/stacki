// Goal: project recipes resolve identically in both hosts without ambiguous references.
// Method: exercise parsing, explicit emptiness, nested overrides, hostile paths and expansion caps.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseComponentDefaults,
  parseDefaultsSource,
  resolveComponentRecipe,
  relinkDefaults,
  DEFAULT_LIMITS,
  type RecipeChild,
} from '#dist/shared/properties/componentDefaults.js';
import { parseIpcPayload } from '#dist/shared/ipc/ipcPayloads.js';
import { parseMetadataResult } from '#dist/shared/properties/projectMetadata.js';

const heading = 'src/components/Heading.astro';
const wrapper = 'src/components/Wrapper.astro';
const catalog = [
  { file: heading, name: 'Heading', props: ['level'], slots: ['default'], slotText: true },
  { file: wrapper, name: 'Wrapper', props: [], slots: ['default', 'aside'], slotText: false },
];
const config = parseComponentDefaults({
  version: 1,
  components: {
    [heading]: { props: { level: 2, hidden: false }, text: 'Literal <text> & {code}' },
    [wrapper]: { children: [{ component: heading }, { component: heading, text: '' }] },
  },
});

test('recipes preserve typed props and distinguish inherited, overridden and empty content', () => {
  const resolved = resolveComponentRecipe(wrapper, config, catalog);
  assert.equal(resolved.ok, true);
  if (!resolved.ok || resolved.value.content.kind !== 'children') {
    assert.fail('Expected wrapper children');
  }
  const first = resolved.value.content.children[0];
  const second = resolved.value.content.children[1];
  assert.ok(first && 'component' in first);
  assert.ok(second && 'component' in second);
  assert.deepEqual(first.content, {
    kind: 'text',
    text: 'Literal <text> & {code}',
  });
  assert.deepEqual(second.content, { kind: 'text', text: '' });
  assert.deepEqual(first.props, { level: 2, hidden: false });
  const empty = parseComponentDefaults({ version: 1, components: { [wrapper]: { children: [] } } });
  assert.deepEqual(resolveComponentRecipe(wrapper, empty, catalog), {
    ok: true,
    value: { component: wrapper, props: {}, content: { kind: 'children', children: [] } },
  });
});

test('malformed recipes and unsafe paths are rejected at the boundary', () => {
  for (const value of [
    undefined,
    {},
    { version: 2, components: {} },
    { version: 1, components: { '../Heading.astro': {} } },
    { version: 1, components: { '/src/Heading.astro': {} } },
    { version: 1, components: { 'src/../Heading.astro': {} } },
    { version: 1, components: { [heading]: { text: 12 } } },
    { version: 1, components: { [heading]: { text: '', children: [] } } },
    { version: 1, components: { [heading]: { props: { level: Infinity } } } },
    { version: 1, components: { [heading]: { props: { value: {} } } } },
    {
      version: 1,
      components: { [heading]: { text: 'x'.repeat(DEFAULT_LIMITS.textCharsMax + 1) } },
    },
  ]) {
    assert.throws(() => parseComponentDefaults(value));
  }
  assert.equal(parseDefaultsSource('{broken').ok, false);
  assert.equal(parseDefaultsSource('x'.repeat(DEFAULT_LIMITS.sourceCharsMax + 1)).ok, false);
});

test('missing files, slots and cycles produce actionable failures', () => {
  assert.equal(resolveComponentRecipe(wrapper, config, catalog.slice(1)).ok, false);
  const cycle = parseComponentDefaults({
    version: 1,
    components: {
      [wrapper]: { children: [{ component: wrapper }] },
    },
  });
  assert.equal(resolveComponentRecipe(wrapper, cycle, catalog).ok, false);
  const noSlot = catalog.map((item) => ({ ...item, slots: [] }));
  assert.equal(resolveComponentRecipe(wrapper, config, noSlot).ok, false);
});

test('stored and expanded trees are bounded independently', () => {
  let child: RecipeChild = { component: wrapper };
  for (let depth = 0; depth <= DEFAULT_LIMITS.depthMax; depth += 1) {
    child = { component: wrapper, children: [child] };
  }
  assert.throws(() => parseComponentDefaults({ version: 1, components: { [wrapper]: { children: [child] } } }));
  assert.throws(() =>
    parseComponentDefaults({
      version: 1,
      components: {
        [wrapper]: {
          children: Array.from({ length: DEFAULT_LIMITS.childrenMax + 1 }, () => ({
            component: heading,
          })),
        },
      },
    }),
  );
  const branching = Array.from({ length: 9 }, (_, index) => ({
    file: `src/components/Branch${index}.astro`,
    name: `Branch${index}`,
    props: [],
    slots: ['default'],
    slotText: false,
  }));
  const recipes = parseComponentDefaults({
    version: 1,
    components: Object.fromEntries(
      branching.map((component, index) => [
        component.file,
        {
          children:
            index === branching.length - 1
              ? []
              : Array.from({ length: 2 }, () => ({
                  component: `src/components/Branch${index + 1}.astro`,
                })),
        },
      ]),
    ),
  });
  const result = resolveComponentRecipe('src/components/Branch0.astro', recipes, branching);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, 'recipe-limit');
  }
});

test('relink updates the owner and nested references without overwriting another preset', () => {
  const next = 'src/components/Title.astro';
  const result = relinkDefaults(config, heading, next);
  assert.equal(result.ok, true);
  if (!result.ok) {
    assert.fail('Relink failed');
  }
  assert.equal(result.value.components[heading], undefined);
  assert.deepEqual(result.value.components[next], config.components[heading]);
  const child = result.value.components[wrapper]?.children?.[0];
  assert.ok(child && 'component' in child);
  assert.equal(child.component, next);
  assert.equal(relinkDefaults(config, heading, wrapper).ok, false);
});

test('metadata IPC validates both directions and restricts file selection', () => {
  assert.deepEqual(parseIpcPayload('project:metadata', { projectPath: '/site', kind: 'guide' }), {
    projectPath: '/site',
    kind: 'guide',
  });
  assert.throws(() => parseIpcPayload('project:metadata', { projectPath: '/site', kind: '../secret' }));
  assert.deepEqual(parseMetadataResult({ ok: true, value: {} }), { ok: true, value: {} });
  assert.throws(() => parseMetadataResult({ ok: true, value: { source: 4 } }));
  assert.throws(() => parseMetadataResult({ ok: false, error: { code: 'disk' } }));
});
