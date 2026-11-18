// Goal: project:scan writes, beside each component's instance count, the files that count comes
// from (`uses`), and the editor's live count of any one file agrees with the scan's share for it,
// so the Components panel can swap the open file's share for its live tree without the number
// moving when the page opens (src/app/model/liveInstanceCounts.ts).
//
// Methodology: a temporary project on disk with a page using a component in a slot, a loop, a
// conditional and a layout imported under another name, a second page, and a component using
// another; the real main-process handler runs through the windowless harness; its payload passes
// the contract parser, its shares are checked file by file, and each file's live count (the real
// parser's tree, counted by the renderer module) is compared with its share.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { mainHarness } from '../../helpers/mainHarness.ts';
import { parseScanResult } from '#dist/shared/properties/projectScan.js';
import { parsePage } from '#dist/electron/parse/astroParser.js';
import type { ScanComponent } from '#dist/shared/properties/projectScan.js';

interface FileInstances {
  readonly file: string;
  readonly counts: ReadonlyMap<string, number>;
}
interface LiveCounts {
  readonly fileInstanceCounts: (
    model: unknown,
    context: { readonly project: string; readonly path: string; readonly components: readonly ScanComponent[] },
  ) => FileInstances | undefined;
}

const loadRenderer: unknown = createRequire(import.meta.url)('../../helpers/rendererModule.js');

// The bundled renderer module, checked for the one export this test calls.
const isLoader = (value: unknown): value is (file: string) => unknown => typeof value === 'function';
const isLiveCounts = (value: unknown): value is LiveCounts =>
  typeof value === 'object' && value !== null && 'fileInstanceCounts' in value && typeof value.fileInstanceCounts === 'function';

function liveCounter(): LiveCounts {
  assert.ok(isLoader(loadRenderer), 'the renderer loader is a function');
  const loaded = loadRenderer('src/app/model/liveInstanceCounts.ts');
  assert.ok(isLiveCounts(loaded), 'the module exports fileInstanceCounts');
  return loaded;
}

const FILES: Readonly<Record<string, string>> = {
  'package.json': '{"dependencies":{"astro":"*"}}',
  'src/layouts/BaseLayout.astro': '<html><body><slot /></body></html>\n',
  'src/components/Div.astro': '<div><slot /></div>\n',
  'src/components/Card.astro': "---\nimport Div from './Div.astro';\n---\n<article><Div /></article>\n",
  'src/pages/index.astro': [
    '---',
    "import Layout from '../layouts/BaseLayout.astro';",
    "import Div from '../components/Div.astro';",
    "import Card from '../components/Card.astro';",
    '---',
    '<Layout>',
    '  <Card><Div /></Card>',
    '  {[1, 2, 3].map(() => <Div />)}',
    '  {true ? <Div /> : <Card />}',
    '</Layout>',
    '',
  ].join('\n'),
  'src/pages/about.astro': "---\nimport Div from '../components/Div.astro';\n---\n<Div />\n",
};

function project(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-scan-uses-')));
  for (const [relative, text] of Object.entries(FILES)) {
    const file = path.join(root, ...relative.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  return root;
}

test('project:scan writes each component’s per-file shares, and each file’s live count agrees', async (context) => {
  const root = project();
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-scan-uses-data-'));
  const harness = mainHarness(userData);
  context.after(() => {
    harness.dispose();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(userData, { recursive: true, force: true });
  });
  const scan = parseScanResult(await harness.invoke('project:scan', root));
  const components = [...scan.components, ...scan.layouts];
  const byName = (name: string): ScanComponent => {
    const found = components.find((component) => component.name === name);
    assert.ok(found, `${name} is scanned`);
    return found;
  };
  const shares = (name: string): Readonly<Record<string, number>> => Object.fromEntries((byName(name).uses ?? []).map((use) => [use.file, use.count]));

  // Nodes, not loop iterations; slot and conditional content counts; Card's own Div counts for Card.astro.
  assert.deepEqual(shares('Div'), { 'src/pages/index.astro': 3, 'src/pages/about.astro': 1, 'src/components/Card.astro': 1 });
  assert.equal(byName('Div').instances, 5);
  assert.deepEqual(shares('Card'), { 'src/pages/index.astro': 2 });
  assert.deepEqual(shares('BaseLayout'), { 'src/pages/index.astro': 1 }, 'a layout counts under the name its page imports it as');
  assert.deepEqual(byName('BaseLayout').uses?.length, 1);

  const { fileInstanceCounts } = liveCounter();
  for (const relative of ['src/pages/index.astro', 'src/pages/about.astro', 'src/components/Card.astro']) {
    const file = path.join(root, ...relative.split('/'));
    const parsed = parsePage(fs.readFileSync(file, 'utf8'), { locs: false });
    assert.equal(parsed.editable, true, `${relative} parses`);
    if (!parsed.editable) {
      continue;
    }
    const live = fileInstanceCounts(parsed.model, { project: root, path: file, components });
    assert.ok(live, `${relative} is inside the project`);
    assert.equal(live.file, relative, 'the live key is the scan’s key');
    for (const component of components) {
      const scanned = component.uses?.find((use) => use.file === relative)?.count ?? 0;
      assert.equal(live.counts.get(component.path) ?? 0, scanned, `${component.name} in ${relative}: live and scanned agree`);
    }
  }
});
