// Goal: the class field suggests every class a project uses, from src/ and
// from public/, which a page links as it is (a stylesheet, a script): written
// in markup, added by a script, or styled. Method: the real main handler in
// the windowless harness over a temporary project.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { mainHarness } from '../../helpers/mainHarness.ts';

test('class suggestions read src/ and public/', async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-classes-'));
  fs.mkdirSync(path.join(root, 'src/pages'), { recursive: true });
  fs.mkdirSync(path.join(root, 'public/js'), { recursive: true });
  fs.mkdirSync(path.join(root, 'user'));
  fs.writeFileSync(path.join(root, 'package.json'), '{"dependencies":{"astro":"*"}}');
  fs.writeFileSync(path.join(root, 'src/pages/index.astro'), '<p class="faq_description">a</p>\n');
  fs.writeFileSync(path.join(root, 'public/site.css'), '.from-public { color: red; }\n');
  fs.writeFileSync(path.join(root, 'public/js/menu.js'), "button.classList.toggle('is-open');\n");
  fs.writeFileSync(path.join(root, 'notes.css'), '.not-served { color: red; }\n');
  const harness = mainHarness(path.join(root, 'user'));
  context.after(() => {
    harness.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const classes: unknown = await harness.invoke('project:classes', root);
  assert.ok(Array.isArray(classes));
  for (const name of ['faq_description', 'from-public', 'is-open']) {
    assert.ok(classes.includes(name), `${name} in ${JSON.stringify(classes)}`);
  }
  assert.ok(!classes.includes('not-served'), 'only src/ and public/ are read');
});
