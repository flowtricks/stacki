// Goal: pin the rewriting half of the layout restructure's move tool
// (scripts/move/moveSourcesPlan.mts): a move rewrites every module specifier and
// every repository path that names a moved file, leaves everything else byte
// for byte, and reports — never guesses — what it cannot rewrite safely.
// Method: small trees held in memory. Each case moves a file or a folder and
// compares the planned texts with the expected ones; the negative space is a
// reference to a file that does not move, an unresolvable specifier, a folder
// that moves only in part, and a regular expression over a moved folder.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applyEdits, planStep, resolvePath, type StepPlan } from '../../../scripts/move/moveSourcesPlan.mts';
import { nameProblem, parseManifest } from '../../../scripts/move/moveSources.mts';

function plan(texts: Readonly<Record<string, string>>, moves: Record<string, string>): StepPlan {
  const files = new Set(Object.keys(texts));
  return planStep({ files, texts: new Map(Object.entries(texts)) }, new Map(Object.entries(moves)));
}

describe('module specifiers', () => {
  it('follow a moved target and drop the extension in compiled roots', () => {
    const result = plan(
      {
        'src/App.tsx': "import { a } from './pageEdits.js';\nimport './styles.css';\n",
        'src/pageEdits.ts': 'export const a = 1;\n',
        'src/styles.css': '',
      },
      { 'src/pageEdits.ts': 'src/editor/pageEdits.ts' },
    );
    assert.deepEqual(result.reports, []);
    const text = "import { a } from './editor/pageEdits';\nimport './styles.css';\n";
    assert.deepEqual([...result.writes], [['src/App.tsx', text]]);
  });

  it('re-root the moved file’s own imports, including import() and import types', () => {
    const result = plan(
      {
        'src/panels/Props.tsx': "import x from '../ui/Icons';\nconst y = import('./Lazy');\n" + "type Z = import('../../shared/limits').Limits;\n",
        'src/ui/Icons.tsx': '',
        'src/panels/Lazy.tsx': '',
        'shared/limits.ts': '',
      },
      { 'src/panels/Props.tsx': 'src/features/props/Props.tsx' },
    );
    const text = "import x from '../../ui/Icons';\nconst y = import('../../panels/Lazy');\n" + "type Z = import('../../../shared/limits').Limits;\n";
    assert.deepEqual([...result.writes], [['src/features/props/Props.tsx', text]]);
  });

  it('keep the written extension where Node resolves it (scripts, CommonJS)', () => {
    const result = plan(
      {
        'scripts/policy/scan.mts': "import { a } from './assert.mts';\n",
        'scripts/policy/assert.mts': '',
        'test/x.js': "const a = require('./helper.js');\n",
        'test/helper.js': '',
      },
      {
        'scripts/policy/assert.mts': 'scripts/lib/assert.mts',
        'test/helper.js': 'test/helpers/helper.js',
      },
    );
    assert.equal(result.writes.get('scripts/policy/scan.mts'), "import { a } from '../lib/assert.mts';\n");
    assert.equal(result.writes.get('test/x.js'), "const a = require('./helpers/helper.js');\n");
  });

  it('leave a file that names nothing moved untouched, byte for byte', () => {
    const result = plan({ 'src/a.ts': "import b from './b';\n// src/b.ts\n", 'src/b.ts': '', 'src/c.ts': '' }, { 'src/c.ts': 'src/lib/c.ts' });
    assert.equal(result.writes.size, 0);
    assert.deepEqual(result.reports, []);
  });

  it('report a compiled-root specifier that resolves to nothing', () => {
    const result = plan({ 'src/a.ts': "import b from './gone';\n", 'src/c.ts': '' }, {});
    assert.deepEqual(result.reports, ["src/a.ts: './gone' resolves to no file"]);
  });

  it('ignore a test’s specifier into build output, which is not in the tree', () => {
    const result = plan({ 'test/a.js': "require('../dist/electron/main.js');\n" }, {});
    assert.deepEqual(result.reports, []);
  });
});

describe('repository paths written as text', () => {
  it('rewrite file paths, .js names (keeping .js) and #dist build paths', () => {
    const result = plan(
      {
        'test/a.js': "load('src/panels/Props.jsx');\nrequire('#dist/electron/astroParser.js');\n" + '// See src/panels/Props.tsx.\n',
        'src/panels/Props.tsx': '',
        'electron/astroParser.ts': '',
      },
      {
        'src/panels/Props.tsx': 'src/features/props/Props.tsx',
        'electron/astroParser.ts': 'electron/parse/astroParser.ts',
      },
    );
    const text = "load('src/features/props/Props.jsx');\nrequire('#dist/electron/parse/astroParser.js');\n" + '// See src/features/props/Props.tsx.\n';
    assert.equal(result.writes.get('test/a.js'), text);
  });

  it('rewrite a folder that moves as a whole, renames included', () => {
    const result = plan(
      {
        'docs/a.md': 'The model lives in `src/style-panel/lib/`.\n',
        'src/style-panel/lib/css-rule-view.ts': '',
        'src/style-panel/lib/css.ts': '',
      },
      {
        'src/style-panel/lib/css-rule-view.ts': 'src/features/style/model/cssRuleView.ts',
        'src/style-panel/lib/css.ts': 'src/features/style/model/css.ts',
      },
    );
    assert.equal(result.writes.get('docs/a.md'), 'The model lives in `src/features/style/model/`.\n');
  });

  it('report a folder that moves only in part, and leave it as written', () => {
    const result = plan(
      { 'test/a.js': "walk('src/panels');\n", 'src/panels/A.tsx': '', 'src/panels/B.tsx': '' },
      { 'src/panels/A.tsx': 'src/features/a/A.tsx' },
    );
    assert.equal(result.writes.size, 0);
    assert.deepEqual(result.reports, ['test/a.js:1: src/panels/ moves only in part']);
  });

  it('report a regular expression over a moved folder and a renamed file’s bare name', () => {
    const result = plan(
      {
        'test/a.js': 'const stub = /\\/src\\/panels\\/[^/]+$/;\n// tool-prefs.ts keeps state.\n',
        'src/panels/A.tsx': '',
        'src/tool-prefs.ts': '',
      },
      {
        'src/panels/A.tsx': 'src/features/a/A.tsx',
        'src/tool-prefs.ts': 'src/lib/toolPreferences.ts',
      },
    );
    assert.deepEqual(result.reports, ['test/a.js:1: a regular expression names moved folder src\\/panels', 'test/a.js:2: names renamed file tool-prefs.ts']);
  });

  it('leave paths inside fixture projects alone: they name no tracked file', () => {
    const result = plan({ 'test/a.js': "write('src/pages/index.astro');\n", 'src/pages.ts': '' }, { 'src/pages.ts': 'src/lib/pages.ts' });
    assert.equal(result.writes.size, 0);
  });
});

describe('files that hold paths as data', () => {
  it('follow a move in their imports, never in their path text', () => {
    const texts = {
      'test/meta.test.js': "require('./helpers/sources.js');\nconst sample = 'src/a.ts';\n",
      'test/helpers/sources.js': '',
      'src/a.ts': '',
    };
    const result = planStep(
      {
        files: new Set(Object.keys(texts)),
        texts: new Map(Object.entries(texts)),
        pathData: new Set(['test/meta.test.js']),
      },
      new Map([
        ['test/meta.test.js', 'test/gate/meta.test.js'],
        ['src/a.ts', 'src/lib/a.ts'],
      ]),
    );
    const text = "require('../helpers/sources.js');\nconst sample = 'src/a.ts';\n";
    assert.equal(result.writes.get('test/gate/meta.test.js'), text);
  });
});

describe('esbuild stdin specifiers resolved from the root', () => {
  it('follow their file, keeping the extension they were written with', () => {
    const before = ["export { x } from './src/ui/Dropdown.jsx';", "export { y } from './src/ui/Icons';"].join('\n');
    const after = ["export { x } from './src/ui/menus/Dropdown.jsx';", "export { y } from './src/lib/Icons';"].join('\n');
    const result = plan(
      { 'test/a.js': before, 'src/ui/Dropdown.tsx': '', 'src/ui/Icons.tsx': '' },
      {
        'src/ui/Dropdown.tsx': 'src/ui/menus/Dropdown.tsx',
        'src/ui/Icons.tsx': 'src/lib/Icons.tsx',
      },
    );
    assert.equal(result.writes.get('test/a.js'), after);
  });
});

describe('the tool’s own boundaries', () => {
  it('resolves stale and bare names to the real file', () => {
    const files = new Set(['src/a.tsx', 'src/b/index.ts']);
    assert.deepEqual(resolvePath(files, 'src/a.jsx'), {
      target: 'src/a.tsx',
      form: { kind: 'alias', extension: '.jsx' },
    });
    assert.deepEqual(resolvePath(files, 'src/a'), { target: 'src/a.tsx', form: { kind: 'bare' } });
    assert.deepEqual(resolvePath(files, 'src/b'), {
      target: 'src/b/index.ts',
      form: { kind: 'directory' },
    });
    assert.equal(resolvePath(files, 'src/c'), undefined);
  });

  it('applies edits in order and refuses overlapping ones', () => {
    assert.equal(
      applyEdits('abcdef', [
        { start: 4, end: 5, text: 'E' },
        { start: 0, end: 1, text: 'A' },
      ]),
      'AbcdEf',
    );
    assert.throws(
      () =>
        applyEdits('abcdef', [
          { start: 0, end: 3, text: '' },
          { start: 2, end: 4, text: '' },
        ]),
      /Assertion failed: applyEdits: edits overlap/,
    );
  });

  it('holds the naming rule on targets', () => {
    assert.equal(nameProblem('src/features/style/model/cssRuleView.ts'), undefined);
    assert.equal(nameProblem('src/features/props/PropsPanel.tsx'), undefined);
    assert.equal(nameProblem('test/renderer/props/listField.test.js'), undefined);
    assert.equal(
      nameProblem('src/features/style/model/css-rule-view.ts'),
      "src/features/style/model/css-rule-view.ts: 'css-rule-view.ts' is neither a camelCase " + 'module nor a PascalCase component',
    );
    assert.equal(nameProblem('src/style-panel/Gap.tsx'), "src/style-panel/Gap.tsx: folder 'style-panel' is not camelCase");
  });

  it('parses the manifest and rejects a malformed move', () => {
    const steps = parseManifest({
      steps: [{ step: 'lib', moves: [['src/a.ts', 'src/lib/a.ts']] }],
    });
    assert.deepEqual(steps, [{ step: 'lib', moves: [{ from: 'src/a.ts', to: 'src/lib/a.ts' }] }]);
    assert.throws(() => parseManifest({ steps: [{ step: 'lib', moves: [['src/a.ts']] }] }), /Assertion failed: lib: a move is a \[from, to\] pair/);
    assert.throws(() => parseManifest({ steps: 'lib' }), /steps must be an array/);
  });
});
