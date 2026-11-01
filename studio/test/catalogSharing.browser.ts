// Goal: concurrent editors share real project/asset scans and still observe new
// files. Method: issue simultaneous HTTP reads against a disposable Astro server,
// compare server scan identifiers, then change disk contents and read them back.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { startStyleFixture } from './stylePanelFixture';
import { parseProject } from '../src/features/project/projectClient';

const fixture = await startStyleFixture();
try {
  const project = await shared('/studio/api/project', 'project-scan');
  const assets = await shared('/studio/api/assets', 'asset-scan');
  assert.ok(project.durationMs >= 0);
  assert.ok(assets.durationMs >= 0);
  await writeFile(path.join(fixture.root, 'src/pages/catalog-added.astro'), '<h1>New page</h1><style>.fresh-page { color: red; }</style>');
  const response = await fetch(new URL('/studio/api/project', fixture.url), {
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(response.status, 200);
  const value: unknown = await response.json();
  assert.ok(parseProject(value).pages.includes('src/pages/catalog-added.astro'));
  for (const name of ['card', 'sheet', 'parent', 'fresh-page']) {
    assert.ok(parseProject(value).classes.includes(name), 'Component, page and CSS classes remain');
  }
  assert.notEqual(timing(response, 'project-scan').identifier, project.identifier);
  await writeFile(path.join(fixture.root, 'src/components/Card.astro'), '<section><slot name="updated" /></section>');
  const changed = await fetch(new URL('/studio/api/project', fixture.url), {
    signal: AbortSignal.timeout(10_000),
  });
  const updated: unknown = await changed.json();
  const component = parseProject(updated).components.find((item) => item.file === 'src/components/Card.astro');
  assert.deepEqual(component?.slots, ['updated'], 'Outside edits replace cached slot analysis');
  assert.ok(!parseProject(updated).classes.includes('card'), 'Removed component CSS is not cached');
  console.log(JSON.stringify({ workload: 'four-concurrent-readers', project, assets }));
} finally {
  await fixture.stop();
}

async function shared(route: string, name: string) {
  const responses = await Promise.all(Array.from({ length: 4 }, () => fetch(new URL(route, fixture.url), { signal: AbortSignal.timeout(10_000) })));
  const timings = responses.map((response) => {
    assert.equal(response.status, 200);
    return timing(response, name);
  });
  await Promise.all(responses.map((response) => response.arrayBuffer()));
  const first = timings[0];
  assert.ok(first);
  assert.equal(new Set(timings.map((value) => value.identifier)).size, 1);
  assert.ok(timings.every((value) => value.durationMs === first.durationMs));
  return first;
}

function timing(response: Response, name: string) {
  const value = response.headers.get('server-timing');
  assert.ok(value, 'Catalog responses expose their measured server work');
  const match = new RegExp(`^${name};dur=([0-9]+\\.[0-9]);desc="([0-9]+)"$`).exec(value);
  assert.ok(match, 'Server timing has a bounded numeric duration and scan identifier');
  const durationMs = Number(match[1]);
  const identifier = Number(match[2]);
  assert.ok(Number.isFinite(durationMs));
  assert.ok(Number.isSafeInteger(identifier));
  return { durationMs, identifier };
}
