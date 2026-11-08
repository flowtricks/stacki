// Goal: the bake's component templates come from the real build, and the bake always
// ends. A clean site gets a template for each instance and recipe, with the page's
// own output unchanged; a component that throws for a probe's values costs only the
// probes of the page it ran on, and the bake process exits on its own afterwards,
// because each build runs in a child that is ended when it answers.
// Method: bake disposable projects in a separate process with a time bound, so a
// handle left open fails the test instead of hanging the suite, and read what each
// bake reported and wrote.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseBakeSnapshot } from '../src/features/bake/bakeSnapshot';
import { renderTemplate, joinOutput } from '../src/features/bake/componentTemplates';
import { makeProject } from './demoFixture';

const BAKE_EXIT_MS_MAX = 240_000;
const studio = fileURLToPath(new URL('../', import.meta.url));

/** Bakes `root` in a fresh process and returns what it reported, or fails when the
 * process outlives the bound. */
async function bakeInChild(root: string, out: string): Promise<Readonly<Record<string, unknown>>> {
  const script = path.join(out, '..', `bake-${path.basename(out)}.mts`);
  await writeFile(
    script,
    `import { bakeSite } from ${JSON.stringify(path.join(studio, 'src/features/bake/bakeSite.ts'))};\n` +
      `const result = await bakeSite({ root: ${JSON.stringify(root)}, out: ${JSON.stringify(out)}, base: '/demo/site/', runtime: ${JSON.stringify(path.join(studio, 'dist'))}, studioVersion: '0.0.0-test' });\n` +
      `console.log('BAKE ' + JSON.stringify(result));\n`,
  );
  try {
    const child = spawn(process.execPath, [...process.execArgv, script], { cwd: studio, stdio: ['ignore', 'pipe', 'inherit'] });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    const code = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error('The bake process did not exit: something it opened is still open'));
      }, BAKE_EXIT_MS_MAX);
      child.once('exit', (exitCode) => {
        clearTimeout(timer);
        resolve(exitCode);
      });
    });
    assert.equal(code, 0, 'The bake exits cleanly');
    const line = output.split('\n').find((text) => text.startsWith('BAKE '));
    assert.ok(line, 'The bake reported its result');
    const parsed: unknown = JSON.parse(line.slice('BAKE '.length));
    assert.ok(typeof parsed === 'object' && parsed !== null);
    return Object.fromEntries(Object.entries(parsed));
  } finally {
    await rm(script, { force: true });
  }
}

test('a clean site bakes templates for its instances and exits', { timeout: BAKE_EXIT_MS_MAX + 30_000 }, async () => {
  const project = await makeProject();
  const out = await mkdtemp(path.join(os.tmpdir(), 'stacki-bake-components-'));
  try {
    const result = await bakeInChild(project.root, out);
    assert.equal(result['ok'], true);
    const snapshot = parseBakeSnapshot(await readFile(path.join(out, 'stacki-runtime/snapshot.json'), 'utf8'));
    const index = snapshot.components.instances['src/pages/index.astro']?.['0.1.0.4'];
    assert.notEqual(index, undefined, 'The card on the page has its own template');
    const template = snapshot.components.templates[index ?? -1];
    assert.ok(template);
    const rendered = renderTemplate(template, { title: { type: 'string', value: 'New & title' } }, ['default'], '0.1.0.4');
    assert.ok(rendered.ok);
    assert.match(
      joinOutput(rendered.output, () => 'SLOT'),
      /<h3[^>]*>New &amp; title<\/h3>/,
      'The title fills its hole, escaped',
    );
    const html = await readFile(path.join(out, 'index.html'), 'utf8');
    assert.doesNotMatch(html, /stacki-probe|stkpathsentinel|Sq\dx/, 'No probe output is left on the page');
    const content = snapshot.content;
    assert.ok(content, 'The content collections were read at bake time');
    assert.equal(Object.keys(content.remote.document).length, 1, 'Every entry is a document the panel can open');
    assert.deepEqual(
      content.fields.filter((field) => field.field === 'title').map((field) => field.pages),
      [['src/pages/index.astro']],
      'The title shows as written on the page that lists it',
    );
    assert.ok(snapshot.sources['src/content/notes/first.md'] !== undefined, 'The entry file is a room like any page');
    assert.equal(await readdir(project.root).then((files) => files.includes('.studio-cms-runner')), false, 'The content reader leaves nothing in the project');
  } finally {
    await project.stop();
    await rm(out, { recursive: true, force: true });
  }
});

test('a component that throws for a probe costs that page its probes, and the bake still exits', { timeout: BAKE_EXIT_MS_MAX + 30_000 }, async () => {
  const project = await makeProject();
  const out = await mkdtemp(path.join(os.tmpdir(), 'stacki-bake-throws-'));
  try {
    // An empty title throws: the probe for the "empty" state fails the page's render.
    await writeFile(
      path.join(project.root, 'src/components/Card.astro'),
      `---\nconst { title = "Card" } = Astro.props;\nif (title === "") { throw new Error("A card needs a title"); }\n---\n<article class="card"><h3>{title}</h3><slot /></article>\n<style>\n  .card { padding: 8px; }\n</style>\n`,
    );
    const result = await bakeInChild(project.root, out);
    assert.equal(result['ok'], true, 'The site still bakes');
    const value = result['value'];
    assert.ok(typeof value === 'object' && value !== null && 'probeFailure' in value);
    assert.match(String(value.probeFailure), /rendering \/ /, 'The failure names the page whose probes were dropped');
    const snapshot = parseBakeSnapshot(await readFile(path.join(out, 'stacki-runtime/snapshot.json'), 'utf8'));
    assert.equal(snapshot.components.instances['src/pages/index.astro'], undefined, 'That page has no templates, so its edits refuse');
    assert.match(await readFile(path.join(out, 'index.html'), 'utf8'), /class="card"/, 'The page itself baked as written');
  } finally {
    await project.stop();
    await rm(out, { recursive: true, force: true });
  }
});
