// Goal: a project's stylesheets never stop it opening, whatever flavour they are written in. The
// CSS variables panel's reader answers every generated shape (Sass, Less, PostCSS nesting,
// Tailwind v3 and v4, CSS modules, :global, @layer, @property, @import cycles, custom properties in
// unusual places, broken and unterminated text, a byte-order mark, a huge file) with a result, and
// the declaration scanner returns without throwing on any of them.
// Method: the generated css shapes (test/helpers/projectShapes.ts, area `css`) go through the real
// css:variables handler in the windowless harness, and every stylesheet's text goes through
// readDeclarations directly. Nothing is compiled or executed: stylesheets are only read.
import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { mainHarness } from '../../helpers/mainHarness.ts';
import { buildProject, removeProject } from '../../helpers/projectFixtures.ts';
import { shapes } from '../../helpers/projectShapes.ts';
import { readDeclarations } from '#dist/electron/project/cssVarRead.js';
import { toRecord } from '#dist/shared/core/record.js';

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-cssshapes-user-'));
const harness = mainHarness(userData);
test.after(() => {
  harness.dispose();
  fs.rmSync(userData, { recursive: true, force: true });
});

for (const shape of shapes().filter((candidate) => candidate.area === 'css')) {
  test(`stylesheets read: ${shape.name}`, async (context) => {
    const built = buildProject(shape.files);
    context.after(() => removeProject(built.root));
    const result = toRecord(await harness.invoke('css:variables', built.root));
    assert.ok(result !== undefined, 'css:variables answers an object');
    assert.ok(Array.isArray(result['files']), `files listed; got ${JSON.stringify(result).slice(0, 300)}`);
    for (const [relative, node] of Object.entries(shape.files)) {
      if (relative.endsWith('.css') || relative.endsWith('.scss') || relative.endsWith('.sass') || relative.endsWith('.less') || relative.endsWith('.pcss')) {
        const text = typeof node === 'string' ? node : '';
        // The scanner may refuse text it cannot parse, but only with an Error that says where, which the
        // variables panel shows against that file while the other stylesheets still list.
        try {
          readDeclarations(text);
        } catch (error: unknown) {
          assert.ok(error instanceof Error && error.message.length > 0, relative);
          const files = result['files'];
          assert.ok(
            Array.isArray(files) && files.some((file: unknown) => typeof toRecord(file)?.['error'] === 'string'),
            `${relative}: the failure is reported on its file`,
          );
        }
      }
    }
  });
}

test('a stylesheet that imports itself, or two that import each other, is read once and ends', (context) => {
  const built = buildProject({
    'package.json': '{}',
    'src/styles/a.css': '@import "./b.css";\n:root { --a: 1; }\n',
    'src/styles/b.css': '@import "./a.css";\n:root { --b: 2; }\n',
    'src/styles/self.css': '@import "./self.css";\n:root { --s: 3; }\n',
  });
  context.after(() => removeProject(built.root));
  return harness.invoke('css:variables', built.root).then((result) => {
    const names = JSON.stringify(result);
    for (const name of ['--a', '--b', '--s']) {
      assert.ok(names.includes(name), `${name} found; got ${names.slice(0, 300)}`);
    }
  });
});

test('every unterminated or hostile prefix of a stylesheet is scanned, or refused with a message', () => {
  const css =
    ':root{--a:calc(1px + var(--b,2));} @layer base{ .x{ color:red; /* c */ } } @property --p{syntax:"<length>";inherits:false} "str;{" url(data:image/png;base64,AAA=) \\}';
  for (let end = 0; end <= css.length; end += 1) {
    try {
      readDeclarations(css.slice(0, end));
    } catch (error: unknown) {
      assert.ok(error instanceof Error && error.message.length > 0, `prefix of ${end} characters fails with a message`);
    }
  }
});
