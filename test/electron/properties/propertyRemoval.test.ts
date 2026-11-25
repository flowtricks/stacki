// Goal: deleting a component prop removes it everywhere in one undoable batch:
// its declarations (every variant of a discriminated union included) and its
// destructure, and the value every instance on the site passes, in every
// attribute form; a spread Stacki cannot see
// into is listed for review and left alone; code that still reads it keeps
// working through a constant holding its default, and a read no constant can
// stand in for refuses the deletion with its lines; untouched bytes stay as
// they were.
// Method: a temporary project with a component and pages that place it,
// planned through previewComponentPropertyRemoval and applied through
// updateComponentProperties with the real document actors, then undone
// through the inverse batch and compared byte for byte. The wire parser is
// tested with known-good and each known-bad shape.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  inverseBatch,
  previewComponentPropertyRemoval,
  PropertyUndoStore,
  revertComponentProperties,
  updateComponentProperties,
} from '#dist/electron/properties/componentProperties.js';
import type { FileChange } from '#dist/electron/properties/componentProperties.js';
import { documentHost } from '#dist/electron/documents/documentWrites.js';
import { propertyReadLines } from '#dist/electron/properties/propertyReads.js';
import { parsePropertyRemovalPreview, removalBlocked, removalUsageCount } from '#dist/shared/properties/propertyRemoval.js';

const CARD = [
  '---',
  'interface Props {',
  '  title: string;',
  '  /** Arrow direction. */',
  "  direction?: 'forward' | 'back';",
  '}',
  "const { title, direction = 'forward' } = Astro.props;",
  '---',
  '<div class="card">{title}</div>',
  '<style>.card { flex-direction: column; }</style>',
  '',
].join('\n');

const HOME = [
  '---',
  "import Card from '../components/Card.astro';",
  "const dir = 'back';",
  '---',
  '<Card title="One" direction="back" />',
  '<Card title="Two" direction={dir} />',
  '<Card',
  '  title="Three"',
  '  direction',
  '/>',
  '<p>Pick a direction: direction="back" stays text.</p>',
  '',
].join('\n');

const ABOUT = [
  '---',
  "import Card from '../components/Card.astro';",
  "const direction = 'back';",
  'const rest = { title: "Spread" };',
  '---',
  '<Card title="Four" {direction} />',
  '<Card title="Five" direction={`${direction}`} />',
  "<Card {...{ title: 'Six', direction: 'back' }} />",
  '<Card title="Seven" {...{ direction: \'back\' }} />',
  '<Card {...rest} />',
  '',
].join('\n');

const UNTOUCHED = ['---', "import Other from '../components/Other.astro';", '---', '<Other direction="back" />', ''].join('\n');

interface Project {
  readonly root: string;
  readonly component: string;
  readonly home: string;
  readonly about: string;
  readonly untouched: string;
}

function project(component: string, run: (files: Project) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-prop-removal-'));
  const write = (relative: string, text: string): string => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    return fs.realpathSync(file);
  };
  try {
    run({
      root: fs.realpathSync(root),
      component: write('src/components/Card.astro', component),
      home: write('src/pages/index.astro', HOME),
      about: write('src/pages/about.astro', ABOUT),
      untouched: write('src/pages/other.astro', UNTOUCHED),
    });
    write('src/components/Other.astro', '<slot />\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function remove(files: Project, name: string, committed: FileChange[] = []) {
  return updateComponentProperties(
    { projectPath: files.root, file: files.component, source: fs.readFileSync(files.component, 'utf8'), change: { kind: 'remove', name } },
    { documents: documentHost().documents, noteWrite: () => undefined, onCommitted: (changes) => committed.push(...changes) },
  );
}

function read(file: string): string {
  return fs.readFileSync(file, 'utf8');
}

test('the preview counts every instance value, file by file, and lists the spread it cannot see into', () => {
  project(CARD, (files) => {
    const preview = previewComponentPropertyRemoval({ projectPath: files.root, file: files.component }, 'direction');
    assert.ok(preview.ok, preview.ok ? '' : preview.error.message);
    assert.equal(preview.value.component, 'src/components/Card.astro');
    assert.deepEqual(
      [...preview.value.usages].sort((first, second) => first.path.localeCompare(second.path)),
      [
        { path: 'src/pages/about.astro', count: 4 },
        { path: 'src/pages/index.astro', count: 3 },
      ],
    );
    assert.equal(removalUsageCount(preview.value), 7);
    assert.deepEqual(preview.value.reviews, [{ kind: 'spread', path: 'src/pages/about.astro', line: 10 }]);
    assert.equal(removalBlocked(preview.value), false);
    // The preview writes nothing.
    assert.equal(read(files.component), CARD);
    assert.equal(read(files.home), HOME);
    assert.equal(read(files.about), ABOUT);
  });
});

test('deleting removes the declaration, the destructure and every instance value, and one undo restores every byte', () => {
  project(CARD, (files) => {
    const committed: FileChange[] = [];
    const result = remove(files, 'direction', committed);
    assert.ok(result.ok, result.ok ? '' : result.error.message);
    assert.equal(
      read(files.component),
      [
        '---',
        'interface Props {',
        '  title: string;',
        '}',
        'const { title } = Astro.props;',
        '---',
        '<div class="card">{title}</div>',
        '<style>.card { flex-direction: column; }</style>',
        '',
      ].join('\n'),
    );
    assert.equal(
      read(files.home),
      [
        '---',
        "import Card from '../components/Card.astro';",
        "const dir = 'back';",
        '---',
        '<Card title="One" />',
        '<Card title="Two" />',
        '<Card',
        '  title="Three"',
        '/>',
        '<p>Pick a direction: direction="back" stays text.</p>',
        '',
      ].join('\n'),
    );
    assert.equal(
      read(files.about),
      [
        '---',
        "import Card from '../components/Card.astro';",
        "const direction = 'back';",
        'const rest = { title: "Spread" };',
        '---',
        '<Card title="Four" />',
        '<Card title="Five" />',
        "<Card {...{ title: 'Six' }} />",
        '<Card title="Seven" />',
        '<Card {...rest} />',
        '',
      ].join('\n'),
    );
    assert.equal(read(files.untouched), UNTOUCHED, 'another component’s attribute of the same name is not touched');
    assert.equal(committed.length, 3);
    const store = new PropertyUndoStore();
    const token = store.record(inverseBatch(committed));
    const undone = revertComponentProperties(token, store, { documents: documentHost().documents, noteWrite: () => undefined });
    assert.ok(undone.ok);
    assert.equal(read(files.component), CARD);
    assert.equal(read(files.home), HOME);
    assert.equal(read(files.about), ABOUT);
  });
});

test('an unreferenced prop goes from the component alone', () => {
  project(CARD, (files) => {
    const committed: FileChange[] = [];
    fs.writeFileSync(files.home, '<p>No cards</p>\n');
    fs.writeFileSync(files.about, '<p>None here</p>\n');
    const preview = previewComponentPropertyRemoval({ projectPath: files.root, file: files.component }, 'direction');
    assert.ok(preview.ok);
    assert.deepEqual(preview.value.usages, []);
    assert.deepEqual(preview.value.reviews, []);
    const result = remove(files, 'direction', committed);
    assert.ok(result.ok, result.ok ? '' : result.error.message);
    assert.deepEqual(
      committed.map((change) => change.file),
      [files.component],
    );
    assert.equal(read(files.home), '<p>No cards</p>\n');
  });
});

test('a read in the component’s own code is kept working by a constant holding the default, and one undo restores it', () => {
  const reading = CARD.replace(
    '<div class="card">{title}</div>',
    '<div class="card" data-direction={direction}>\n  {direction === "back" && <span>{title}</span>}\n</div>',
  );
  project(reading, (files) => {
    const preview = previewComponentPropertyRemoval({ projectPath: files.root, file: files.component }, 'direction');
    assert.ok(preview.ok);
    assert.equal(removalBlocked(preview.value), false);
    assert.deepEqual(preview.value.kept, { value: "'forward'", source: 'default', lines: [9, 10] });
    const committed: FileChange[] = [];
    const result = remove(files, 'direction', committed);
    assert.ok(result.ok, result.ok ? '' : result.error.message);
    const after = read(files.component);
    // The `as` keeps the prop's type, so `direction === "back"` still type-checks.
    assert.match(after, /const \{ title \} = Astro\.props;\nconst direction = 'forward' as 'forward' \| 'back';\n---/);
    assert.doesNotMatch(after, /direction\?:/);
    assert.match(after, /data-direction=\{direction\}/, 'the reads are left as written');
    assert.match(read(files.home), /<Card title="One" \/>/);
    const store = new PropertyUndoStore();
    const undone = revertComponentProperties(store.record(inverseBatch(committed)), store, { documents: documentHost().documents, noteWrite: () => undefined });
    assert.ok(undone.ok);
    assert.equal(read(files.component), reading);
    assert.equal(read(files.home), HOME);
    assert.equal(read(files.about), ABOUT);
  });
});

test('a prop with no default keeps undefined when optional and its zero value when required', () => {
  const optional = [
    '---',
    'interface Props { title: string; direction?: string }',
    'const { title, direction } = Astro.props;',
    '---',
    '<p>{title}{direction}</p>',
    '',
  ].join('\n');
  project(optional, (files) => {
    const preview = previewComponentPropertyRemoval({ projectPath: files.root, file: files.component }, 'direction');
    assert.ok(preview.ok);
    assert.deepEqual(preview.value.kept, { value: 'undefined', source: 'undefined', lines: [5] });
    assert.ok(remove(files, 'direction').ok);
    assert.match(read(files.component), /const \{ title \} = Astro\.props;\nconst direction = undefined as string \| undefined;/);
  });
  const required = [
    '---',
    'interface Props { title: string; count: number }',
    'const { title, count } = Astro.props;',
    '---',
    '<p>{title}{count + 1}</p>',
    '',
  ].join('\n');
  project(required, (files) => {
    assert.ok(remove(files, 'count').ok);
    assert.match(read(files.component), /const count = 0 as number;/);
  });
});

test('a read no constant can stand in for refuses the deletion, lists its lines, and writes nothing', () => {
  const through = CARD.replace('<div class="card">{title}</div>', '<div class="card">{title}</div>\n<p>{Astro.props.direction}</p>');
  const selfDefault = CARD.replace("direction = 'forward'", 'direction = direction').replace(
    '<div class="card">{title}</div>',
    '<div class="card">{direction}</div>',
  );
  const shapeless = [
    '---',
    'interface Props { title: string; theme: { dark: boolean } }',
    'const { title, theme } = Astro.props;',
    '---',
    '<p>{title}{theme.dark}</p>',
    '',
  ].join('\n');
  for (const [source, line] of [
    [through, 10],
    [selfDefault, 9],
    [shapeless, 5],
  ] as const) {
    project(source, (files) => {
      const name = source === shapeless ? 'theme' : 'direction';
      const preview = previewComponentPropertyRemoval({ projectPath: files.root, file: files.component }, name);
      assert.ok(preview.ok);
      assert.equal(removalBlocked(preview.value), true);
      assert.equal(preview.value.kept, undefined);
      assert.deepEqual(
        preview.value.reviews.filter((review) => review.kind === 'reads'),
        [{ kind: 'reads', path: 'src/components/Card.astro', line }],
      );
      const result = remove(files, name);
      assert.equal(result.ok, false);
      assert.equal(result.ok ? '' : result.error.code, 'in-use');
      assert.match(result.ok ? '' : result.error.message, new RegExp(`still reads ${name} \\(line ${String(line)}\\)`));
      assert.equal(read(files.component), source);
      assert.equal(read(files.home), HOME);
      assert.equal(read(files.about), ABOUT);
    });
  }
});

test('a discriminated union loses the prop from every branch', () => {
  const union = [
    '---',
    'type Props =',
    "  | { variant?: 'main'; direction?: never }",
    "  | { variant: 'arrow'; /** Arrow direction. */ direction?: 'forward' | 'back' };",
    'const { variant = "main" } = Astro.props;',
    '---',
    '<button class={variant}><slot /></button>',
    '',
  ].join('\n');
  project(union, (files) => {
    const result = remove(files, 'direction');
    assert.ok(result.ok, result.ok ? '' : result.error.message);
    const after = read(files.component);
    assert.doesNotMatch(after, /direction/);
    assert.match(after, /\| \{ variant\?: 'main'; \}/);
    assert.match(after, /\| \{ variant: 'arrow'; \};/);
    assert.match(read(files.home), /<Card title="One" \/>/);
  });
});

test('the read scan ignores keys, CSS, markup text and client scripts, and finds props reads', () => {
  const target = { local: 'direction', name: 'direction', holders: new Set(['props']) };
  const quiet = [
    '---',
    'const props = Astro.props;',
    'const options = { direction: 1 };',
    'const value = options.direction;',
    '---',
    '<p>direction</p>',
    '<style>.a { flex-direction: row; }</style>',
    '<script>const direction = 1;</script>',
    '',
  ].join('\n');
  const lines = propertyReadLines(quiet, target);
  assert.ok(lines.ok);
  assert.deepEqual(lines.value, []);
  const loud = [
    '---',
    'const props = Astro.props;',
    'const a = props.direction;',
    'const b = Astro.props["direction"];',
    '---',
    '<p {...{ direction }} />',
    '',
  ].join('\n');
  const found = propertyReadLines(loud, target);
  assert.ok(found.ok);
  assert.deepEqual(found.value, [3, 4, 6]);
});

test('the preview crosses the wire only in its own shape', () => {
  const good = {
    name: 'direction',
    component: 'src/components/Card.astro',
    usages: [{ path: 'src/pages/index.astro', count: 2 }],
    reviews: [{ kind: 'spread', path: 'src/pages/about.astro', line: 4 }],
    kept: { value: "'forward'", source: 'default', lines: [9, 10] },
  };
  assert.deepEqual(parsePropertyRemovalPreview(JSON.parse(JSON.stringify(good))), good);
  const bad: readonly unknown[] = [
    undefined,
    { ...good, name: 'not a name' },
    { ...good, component: 7 },
    { ...good, usages: [{ path: 'a.astro', count: 0 }] },
    { ...good, usages: [{ path: 'a.astro', count: 1.5 }] },
    { ...good, reviews: [{ kind: 'guess', path: 'a.astro', line: 1 }] },
    { ...good, reviews: [{ kind: 'reads', path: 'a.astro', line: 0 }] },
    { ...good, reviews: 'none' },
    { ...good, kept: { value: '', source: 'default', lines: [1] } },
    { ...good, kept: { value: '1', source: 'guess', lines: [1] } },
    { ...good, kept: { value: '1', source: 'zero', lines: [] } },
  ];
  for (const shape of bad) {
    assert.throws(() => parsePropertyRemovalPreview(shape));
  }
});
