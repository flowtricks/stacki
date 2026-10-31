// Goal: the binding picker's sample of a page's import call — `await getCampusPastors()` —
// runs only what the page's own render runs, and returns a bounded sample.
// Method: a stand-in dev server resolves imports and loads modules from a table, so each
// guard (module under src/, export taking no arguments, export name) and the sample's bounds
// can be checked without starting Astro.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import type { ViteDevServer } from 'vite';
import { valueSampler } from '../src/features/project/valueSampler';

const ROOT = path.resolve('/project');
const MODULES: Record<string, Record<string, unknown>> = {
  [path.join(ROOT, 'src/sanity/queries.ts')]: {
    getPastors: async () => [
      { name: 'Joey & Sarai Kahl', photo: 'https://cdn.sanity.io/images/a.avif', at: new Date(0) },
      ...Array.from({ length: 10 }, (_, index) => ({ name: `Pastor ${index}` })),
    ],
    getSermon: async (slug: string) => slug,
    secret: 'not a call',
  },
  [path.join(ROOT, 'node_modules/pkg/index.js')]: { getAll: async () => [] },
};
const RESOLVED: Record<string, string> = {
  '@/sanity/queries.ts': path.join(ROOT, 'src/sanity/queries.ts'),
  pkg: path.join(ROOT, 'node_modules/pkg/index.js'),
};

const server = {
  pluginContainer: {
    resolveId: async (spec: string) => (RESOLVED[spec] ? { id: RESOLVED[spec] } : null),
  },
  ssrLoadModule: async (id: string) => MODULES[id] ?? {},
} as unknown as ViteDevServer;
const sample = valueSampler(server, ROOT);
const ask = (spec: string, name: string) => sample({ file: 'src/pages/index.astro', spec, name });

test('a page call to a project query comes back as a bounded sample', async () => {
  const { value } = await ask('@/sanity/queries.ts', 'getPastors');
  assert.ok(Array.isArray(value));
  assert.equal(value.length, 9, 'eight entries and a marker saying how many more');
  assert.deepEqual(value[8], { __stacki: 'more', count: 3 });
  assert.deepEqual(value[0], {
    name: 'Joey & Sarai Kahl',
    photo: 'https://cdn.sanity.io/images/a.avif',
    at: { __stacki: 'date', value: '1970-01-01T00:00:00.000Z' },
  });
});

test('only what a render would run is run', async () => {
  await assert.rejects(ask('@/sanity/queries.ts', 'getSermon'), /no arguments/);
  await assert.rejects(ask('@/sanity/queries.ts', 'secret'), /no arguments/);
  await assert.rejects(ask('pkg', 'getAll'), /under src\//, 'a dependency is not project code');
  await assert.rejects(ask('missing', 'getAll'), /under src\//);
  await assert.rejects(ask('@/sanity/queries.ts', 'get(); process.exit'), /Not an export name/);
  await assert.rejects(
    sample({ file: '../outside.astro', spec: '@/sanity/queries.ts', name: 'getPastors' }),
    /under src\//,
  );
});
