// Goal: Stacki opens every Astro project however it is structured. Whatever the shape, the
// project scan and the class scan return a result (never throw), the result passes the
// renderer's boundary parser, every page the project really has is listed, and a project
// whose dependencies are missing says so as a structured warning.
// Method: build each generated shape from test/helpers/projectShapes.ts in a temporary
// folder and call the real main-process handlers through the windowless harness, as the app
// does when a project is opened. Nothing in a fixture is executed or installed.
import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { mainHarness } from '../../helpers/mainHarness.ts';
import { buildProject, removeProject, permissionsEnforced } from '../../helpers/projectFixtures.ts';
import { shapes } from '../../helpers/projectShapes.ts';
import { parseScanResult } from '#dist/shared/properties/projectScan.js';
import { isAstroProject } from '#dist/electron/project/projectFiles.js';

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-shapes-user-'));
const harness = mainHarness(userData);
test.after(() => {
  harness.dispose();
  fs.rmSync(userData, { recursive: true, force: true });
});

// What a shape's scan must say or leave unsaid beyond listing its pages: warning codes, by shape name.
const WARNS: Readonly<Record<string, readonly string[]>> = {
  'config defineConfig async arrow': ['config-folder-custom'],
  'config srcDir literal other folder': ['config-folder-custom'],
  'config spread and env': ['config-computed'],
  'config opaque call': ['config-computed'],
  'unreadable folders': ['folder-unreadable'],
  'symlink cycle in pages': ['link-cycle'],
  'dangling symlinks': ['link-broken'],
  'node_modules missing': ['dependencies-missing'],
  'no package.json at all': ['dependencies-missing'],
};
const QUIET: Readonly<Record<string, readonly string[]>> = {
  'node_modules hoisted to workspace root': ['dependencies-missing'],
  'config srcDir commented out': ['config-computed', 'config-folder-custom'],
  'config srcDir inside vite block': ['config-computed', 'config-folder-custom'],
};
// Page files a shape holds that Astro does not serve, so the scan must not list them.
const UNLISTED: Readonly<Record<string, readonly string[]>> = {
  'underscore partials ignored': ['_partial.astro', '_private/inner.astro', 'blog/_draft.md'],
  'endpoints and non-pages in pages': ['api/data.json.ts', 'logo.png', 'style.css', 'types.d.ts', 'notes.txt'],
};

for (const shape of shapes()) {
  test(`opens: ${shape.name}`, async (context) => {
    if (!permissionsEnforced() && /unreadable|read-only/.test(shape.name)) {
      context.skip('permission bits are not enforced for this user');
      return;
    }
    const built = buildProject(shape.files);
    context.after(() => removeProject(built.root));
    const projectPath = shape.directory === undefined ? built.root : path.join(built.root, ...shape.directory.split('/'));
    const scan = parseScanResult(await harness.invoke('project:scan', projectPath));
    for (const page of shape.pages ?? []) {
      assert.ok(
        scan.pages.some((entry) => entry.name === page),
        `${shape.name}: page ${page} listed; got ${JSON.stringify(scan.pages.map((entry) => entry.name))}`,
      );
    }
    for (const page of UNLISTED[shape.name] ?? []) {
      assert.ok(!scan.pages.some((entry) => entry.name === page), `${shape.name}: ${page} is not a route`);
    }
    const codes: readonly string[] = (scan.warnings ?? []).map((warning) => warning.code);
    for (const code of WARNS[shape.name] ?? []) {
      assert.ok(codes.includes(code), `${shape.name}: warns ${code}; got ${JSON.stringify(scan.warnings)}`);
    }
    for (const code of QUIET[shape.name] ?? []) {
      assert.ok(!codes.includes(code), `${shape.name}: no ${code} warning; got ${JSON.stringify(scan.warnings)}`);
    }
    const classes = await harness.invoke('project:classes', projectPath);
    assert.ok(Array.isArray(classes), `${shape.name}: classes is a list`);
    assert.equal(typeof isAstroProject(projectPath), 'boolean');
  });
}
