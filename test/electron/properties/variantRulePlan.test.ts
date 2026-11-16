// Goal: a variant rule edit is one batch through the Properties panel's
// transaction: renaming an option renames the instances that pass it, in the
// same write and the same undo; removing an option or a prop an instance still
// passes is refused, naming the file; the panel's read carries the groups, and
// the wire parsers carry the edit.
// Method: a temporary project with the Lumos Button fixture and a page that
// places it, edited through updateComponentProperties with the real document
// actors, then undone through the inverse batch. Each refusal leaves every
// file's bytes as they were.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  inverseBatch,
  loadComponentProperties,
  PropertyUndoStore,
  revertComponentProperties,
  updateComponentProperties,
} from '#dist/electron/properties/componentProperties.js';
import type { FileChange } from '#dist/electron/properties/componentProperties.js';
import { documentHost } from '#dist/electron/documents/documentWrites.js';
import { parseComponentProperties, parsePropertyChange } from '#dist/shared/properties/propertyEditing.js';
import type { PropertyChange } from '#dist/shared/properties/propertyEditing.js';

// The gate runs every suite from the repository root.
const BUTTON = fs.readFileSync('test/fixtures/variantRules/Button.astro', 'utf8');
const PAGE = [
  '---',
  "import Button from '../components/Button.astro';",
  '---',
  '<Button variant="main">Go</Button>',
  '<Button variant="arrow" direction="back" />',
  '<Button>Plain</Button>',
  '',
].join('\n');

interface Project {
  readonly root: string;
  readonly component: string;
  readonly page: string;
}

function project(run: (files: Project) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-variant-rules-'));
  const component = path.join(root, 'src/components/Button.astro');
  const page = path.join(root, 'src/pages/index.astro');
  fs.mkdirSync(path.dirname(component), { recursive: true });
  fs.mkdirSync(path.dirname(page), { recursive: true });
  fs.writeFileSync(component, BUTTON);
  fs.writeFileSync(page, PAGE);
  try {
    run({ root, component: fs.realpathSync(component), page: fs.realpathSync(page) });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function edit(files: Project, change: PropertyChange, committed: FileChange[] = []) {
  return updateComponentProperties(
    { projectPath: files.root, file: files.component, source: fs.readFileSync(files.component, 'utf8'), change },
    { documents: documentHost().documents, noteWrite: () => undefined, onCommitted: (changes) => committed.push(...changes) },
  );
}

test('the panel read carries the groups, and they survive the wire', () => {
  project((files) => {
    const read = loadComponentProperties({ projectPath: files.root, file: files.component });
    assert.ok(read.ok);
    const groups = read.value.variantGroups ?? [];
    assert.deepEqual(
      groups.filter((group) => group.editing.kind !== 'candidate').map((group) => group.controller),
      ['element', 'variant'],
    );
    assert.deepEqual(parseComponentProperties(JSON.parse(JSON.stringify(read.value))).variantGroups, groups);
  });
});

test('the edit crosses the wire as a property change', () => {
  const change = { kind: 'variantRules', edit: { kind: 'setFallback', controller: 'variant', value: 'play' } };
  assert.deepEqual(parsePropertyChange(change), change);
  assert.throws(() => parsePropertyChange({ kind: 'variantRules', edit: { kind: 'setFallback', controller: 'variant' } }));
});

test('renaming an option renames its instances in the same batch, and one undo restores both', () => {
  project((files) => {
    const committed: FileChange[] = [];
    const result = edit(files, { kind: 'variantRules', edit: { kind: 'renameOption', controller: 'variant', from: 'main', to: 'primary' } }, committed);
    assert.ok(result.ok, result.ok ? '' : result.error.message);
    assert.equal(fs.readFileSync(files.page, 'utf8'), PAGE.replace('<Button variant="main">', '<Button variant="primary">'));
    assert.ok(fs.readFileSync(files.component, 'utf8').includes('variant?: "primary";'));
    assert.deepEqual(
      result.value.variantGroups?.find((group) => group.controller === 'variant')?.options.map((option) => option.value),
      ['primary', 'link', 'play', 'close', 'arrow'],
    );
    assert.equal(committed.length, 2);
    const store = new PropertyUndoStore();
    const token = store.record(inverseBatch(committed));
    const undone = revertComponentProperties(token, store, { documents: documentHost().documents, noteWrite: () => undefined });
    assert.ok(undone.ok);
    assert.equal(fs.readFileSync(files.page, 'utf8'), PAGE);
    assert.equal(fs.readFileSync(files.component, 'utf8'), BUTTON);
  });
});

test('a rule flip writes the component alone', () => {
  project((files) => {
    const committed: FileChange[] = [];
    const result = edit(
      files,
      { kind: 'variantRules', edit: { kind: 'setRule', controller: 'variant', option: 'close', prop: 'pressed', state: 'optional' } },
      committed,
    );
    assert.ok(result.ok);
    assert.deepEqual(
      committed.map((change) => change.file),
      [files.component],
    );
    assert.equal(fs.readFileSync(files.page, 'utf8'), PAGE);
  });
});

test('removing an option or a prop an instance passes is refused, and nothing is written', () => {
  project((files) => {
    const small = [
      '---',
      'type Props =',
      '  | { tone?: "calm"; icon?: never }',
      '  | { tone: "loud"; icon?: string }',
      '  | { tone: "quiet"; icon?: never };',
      'const { tone = "calm", icon } = Astro.props;',
      '---',
      '<i>{tone}</i>',
      '',
    ].join('\n');
    fs.writeFileSync(files.component, small);
    fs.writeFileSync(files.page, PAGE.replace('<Button variant="main">Go</Button>', '<Button tone="loud" icon="x" />'));
    const before = fs.readFileSync(files.page, 'utf8');
    const option = edit(files, { kind: 'variantRules', edit: { kind: 'removeOption', controller: 'tone', value: 'loud' } });
    assert.equal(option.ok, false);
    assert.equal(option.ok ? '' : option.error.code, 'in-use');
    assert.match(option.ok ? '' : option.error.message, /src\/pages\/index\.astro/);
    const prop = edit(files, { kind: 'variantRules', edit: { kind: 'removeProp', controller: 'tone', prop: 'icon' } });
    assert.equal(prop.ok, false);
    assert.equal(prop.ok ? '' : prop.error.code, 'in-use');
    assert.equal(fs.readFileSync(files.component, 'utf8'), small);
    assert.equal(fs.readFileSync(files.page, 'utf8'), before);
    const quiet = edit(files, { kind: 'variantRules', edit: { kind: 'removeOption', controller: 'tone', value: 'quiet' } });
    assert.ok(quiet.ok, quiet.ok ? '' : quiet.error.message);
  });
});
