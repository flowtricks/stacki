// The public counter must accept only its narrow counting route. Build the
// Worker as deployed, replace D1 with a recorder, and verify unrelated
// requests cannot change totals while the scheduled cleanup stays bounded.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const esbuild = require('esbuild');
const { repoPath } = require('../../helpers/sources.js');

async function workerWithQueries() {
  const output = repoPath('node_modules/.stacki-test/usageWorker.bundle.mjs');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  await esbuild.build({
    entryPoints: [repoPath('src/services/usageCounts/worker.ts')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    outfile: output,
    logLevel: 'silent',
  });
  const { default: worker } = await import(pathToFileURL(path.resolve(output)).href);
  const queries = [];
  const database = {
    prepare(query) {
      return {
        bind(value) {
          return {
            async run() {
              queries.push({ query, value });
            },
          };
        },
      };
    },
  };
  return { worker, queries, env: { COUNTS: database } };
}

test('only a POST to the daily route increments the date aggregate', async () => {
  const { worker, queries, env } = await workerWithQueries();
  const base = 'https://stacki-usage-counts.example/daily';
  assert.equal((await worker.fetch(new Request(base), env)).status, 404);
  assert.equal((await worker.fetch(new Request(`${base}-other`, { method: 'POST' }), env)).status, 404);
  assert.equal((await worker.fetch(new Request(base, { method: 'POST' }), env)).status, 204);
  assert.equal(queries.length, 1);
  assert.match(queries[0].query, /^INSERT INTO activity_days/);
  assert.match(queries[0].value, /^\d{4}-\d{2}-\d{2}$/);
});

test('health checks do not count and cleanup only removes old dates', async () => {
  const { worker, queries, env } = await workerWithQueries();
  const response = await worker.fetch(new Request('https://stacki-usage-counts.example/health'), env);
  assert.equal(response.status, 204);
  assert.equal(queries.length, 0);
  await worker.scheduled(undefined, env);
  assert.equal(queries.length, 1);
  assert.match(queries[0].query, /^DELETE FROM activity_days WHERE day < /);
  assert.match(queries[0].value, /^\d{4}-\d{2}-\d{2}$/);
});
