// Reading CSS variables out of a stylesheet nobody wrote for an editor.
//
//   node test/electron/project/cssVars.test.js [projectDir]
//
// The panel has no schema to go on, so everything it shows is inferred: which
// rules are the same thing in different modes, where one comment stops
// describing the next few lines, and which names are the same property of
// different things. Each of those is a guess that can be wrong in a way that
// makes the panel useless rather than broken — a wall of 317 rows, or a table
// whose columns are `h1-margin` and `h1-trim`.
//
// So the checks are about shape: what the groups are, what the columns are, and
// that every declaration in the file ends up somewhere. The stylesheet used is
// a real one (lumos-framework), and a small synthetic one covers the setups it
// does not have.

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  readVariables,
  setVariable,
  addVariable,
  readDeclarations,
  groupRules,
  labelForRule,
} = require('#dist/electron/project/cssVars.js');

const { repoPath } = require('../../helpers/sources');
const DEFAULT = repoPath('test/fixtures/css-vars');
const source = path.resolve(process.argv[2] || process.env.STACKI_CSS_FIXTURE || DEFAULT);

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) {
    failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  }
};

const rowLabels = (block) => block.rows.map((row) => row.label);
const columnLabels = (block, group) =>
  (block.kind === 'matrix' ? block.columns : group.columns).map((column) => column.label);
const findBlock = (group, title) => group.blocks.find((block) => block.title === title);

// Every stylesheet under a project, for reading a declaration back out of the
// source the parse came from.
// A walk of a project's folders stops at this depth: real source trees are a few folders
// deep, so anything deeper is a loop or a runaway, not a project.
const WALK_LIMITS = { directoryDepthMax: 32 };
const cssFiles = (root) => {
  const out = [];
  const walk = (directory, depth = 0) => {
    assert.ok(depth <= WALK_LIMITS.directoryDepthMax, 'walk: directory depth limit');
    let entries = [];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) {
        continue;
      }
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else if (entry.name.endsWith('.css')) {
        out.push(full);
      }
    }
  };
  walk(path.join(root, 'src'));
  return out;
};

// --- a stylesheet written by hand, with the shapes the real one lacks -------
{
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-css-'));
  fs.mkdirSync(path.join(directory, 'src', 'styles'), { recursive: true });
  const file = path.join(directory, 'src', 'styles', 'tokens.css');
  fs.writeFileSync(
    file,
    `/* tokens */
:root {
  /* Brand */
  --blue: #0af;
  --ink: var(--blue);

  /* Scale */
  --gap-1: 4px;
  --gap-1-min: 4;
  --gap-2: 8px;
  --gap-2-min: 8;
  --gap-3: 12px;
  --gap-3-min: 12;
  --lonely: 1px;
}

@media (min-width: 40rem) {
  :root {
    --gap-1: 6px;
    --gap-2: 10px;
    --gap-3: 14px;
  }
}
`,
  );

  const { files } = readVariables(directory);
  check(
    'a stylesheet with variables is found',
    files.length === 1,
    JSON.stringify(files.map((file) => file.rel)),
  );
  const groups = files[0].groups;
  check('every declaration is counted', files[0].count === 12, `${files[0].count}`);
  check(
    'a rule inside @media is its own group',
    groups.length === 2,
    groups
      .map(
        (group) =>
          `${group.label}[${group.columns.map((column) => column.context.join('|')).join()}]`,
      )
      .join(' '),
  );
  const root = groups[0];
  check('comments are section headings', findBlock(root, 'Brand') && findBlock(root, 'Scale'));
  check(
    'a comment section keeps its variables',
    rowLabels(findBlock(root, 'Brand')).join() === 'blue,ink',
  );
  const scale = root.blocks.find((block) => block.kind === 'matrix');
  check(
    'a numbered scale becomes columns',
    !!scale && columnLabels(scale, root).join() === 'gap-1,gap-2,gap-3',
    JSON.stringify(scale && columnLabels(scale, root)),
  );
  check(
    'with a row for the value and one for each part',
    !!scale && rowLabels(scale).join() === 'value,min',
  );
  check(
    'a name with nothing in common stays a row',
    root.blocks.some((block) => block.kind === 'rows' && rowLabels(block).includes('lonely')),
  );
  const cell = findBlock(root, 'Brand').rows[1].cells[0];
  check('a value that is only a reference says which', cell.ref === '--blue', JSON.stringify(cell));
  check('and resolves through it', cell.color === '#0af', JSON.stringify(cell));

  // Writing one value back.
  const before = fs.readFileSync(file, 'utf8');
  const target = findBlock(root, 'Brand').rows[0].cells[0];
  const written = setVariable(directory, {
    file: target.file,
    valueStart: target.valueStart,
    valueEnd: target.valueEnd,
    expect: target.value,
    value: '#f0a',
  });
  check('a value can be written back', written.ok === true, JSON.stringify(written));
  const after = fs.readFileSync(file, 'utf8');
  check('only that value changed', after === before.replace('#0af;', '#f0a;'), after.slice(0, 200));
  check(
    'and only one line differs',
    before.split('\n').filter((line, i) => line !== after.split('\n')[i]).length === 1,
  );
  const stale = setVariable(directory, {
    file: target.file,
    valueStart: target.valueStart,
    valueEnd: target.valueEnd,
    expect: '#0af',
    value: '#000',
  });
  check('a value someone else changed is refused', stale.ok === false && stale.stale === true);

  // Two rules that declare the same names are one thing in two modes.
  fs.writeFileSync(
    path.join(directory, 'src', 'styles', 'theme.css'),
    `.light { --bg: white; --fg: black; }\n.dark { --bg: black; --fg: white; }\n`,
  );
  const themed = readVariables(directory).files.find((file) => file.rel.endsWith('theme.css'));
  check(
    'rules with the same names become modes',
    themed.groups.length === 1 && themed.groups[0].kind === 'modes',
  );
  check(
    'with a column each',
    themed.groups[0].columns.map((column) => column.label).join() === 'Light,Dark',
  );
  check('and a row per name', rowLabels(themed.groups[0].blocks[0]).join() === 'bg,fg');

  // Each theme's swatch resolves its references with that theme's own values
  // (issue #69): one project-wide map let the last theme answer for every column.
  fs.writeFileSync(
    path.join(directory, 'src', 'styles', 'surfaces.css'),
    [
      ':root { --white: #ffffff; --black: #000000; --light-surface: #eeeeee; }',
      '.theme-light { --surface: var(--paper); --paper: var(--white); }',
      '.theme-dark { --surface: var(--paper); --paper: var(--black); }',
      '@media (prefers-color-scheme: dark) { :root { --light-surface: #111111; } }',
      '',
    ].join('\n'),
  );
  const surfaces = readVariables(directory).files.find((file) => file.rel.endsWith('surfaces.css'));
  const surfaceCells = surfaces.groups
    .flatMap((group) => group.blocks.flatMap((block) => block.rows))
    .filter((row) => row.name === '--surface')
    .flatMap((row) => row.cells)
    .filter(Boolean);
  check(
    'each theme column resolves through its own values',
    surfaceCells.map((cell) => cell.color).join() === '#ffffff,#000000',
    JSON.stringify(surfaceCells),
  );
  const lightSurface = surfaces.groups
    .flatMap((group) => group.blocks.flatMap((block) => block.rows))
    .filter((row) => row.name === '--light-surface')
    .flatMap((row) => row.cells)
    .filter(Boolean);
  check(
    'a media-query override does not repaint the base value',
    lightSurface[0]?.color === '#eeeeee',
    JSON.stringify(lightSurface),
  );

  // A stylesheet with no variables is not a tab.
  fs.writeFileSync(path.join(directory, 'src', 'styles', 'plain.css'), 'body { color: red; }\n');
  check(
    'a stylesheet with no variables is left out',
    !readVariables(directory).files.some((file) => file.rel.endsWith('plain.css')),
  );

  // Nested rules (CSS nesting) still report their own selector.
  fs.writeFileSync(
    path.join(directory, 'src', 'styles', 'nested.css'),
    `.card {\n  color: red;\n  &:hover { --lift: 2px; --shadow: 0 2px 4px; }\n}\n`,
  );
  const nested = readVariables(directory).files.find((file) => file.rel.endsWith('nested.css'));
  check(
    'a nested rule is found',
    !!nested && nested.count === 2,
    JSON.stringify(nested && nested.count),
  );
  check(
    'and remembers what it is nested in',
    nested?.groups[0]?.columns[0]?.context?.includes('.card'),
    JSON.stringify(nested?.groups[0]?.columns[0]?.context),
  );

  // Empty custom properties are valid CSS. PostCSS retains their whitespace;
  // the editor must not mistake the following punctuation for their value.
  for (const emptyCss of [
    ':root { --blank: ; --next: red; }',
    ':root { --blank:; --next: red; }',
    ':root { --blank:;--next:red}',
    ':root {\n  --blank: \n\t;\n  --next: red;\n}',
    ':root { --blank:             ;--next: red; }',
    ':root { --blank: }',
  ]) {
    fs.writeFileSync(file, emptyCss);
    const entries = readDeclarations(emptyCss)[0].entries;
    const declaration = entries.find((entry) => entry.name === '--blank');
    check(
      'an existing empty CSS value stays empty',
      declaration.value === '',
      JSON.stringify(declaration),
    );
    check(
      'an empty value has a zero-width editable span',
      declaration.valueStart === declaration.valueEnd,
    );
    if (emptyCss.includes('--next')) {
      check(
        'a neighboring value excludes its terminator',
        entries.find((entry) => entry.name === '--next')?.value === 'red',
      );
    }
    const result = setVariable(directory, {
      file: 'src/styles/tokens.css',
      valueStart: declaration.valueStart,
      valueEnd: declaration.valueEnd,
      expect: '',
      value: 'unset',
    });
    check('an empty value can be updated', result.ok === true, JSON.stringify(result));
    check(
      'editing an empty value preserves delimiters and adjacent declarations',
      fs.readFileSync(file, 'utf8') === emptyCss.replace(/(--blank:\s*)/, '$1unset'),
      fs.readFileSync(file, 'utf8'),
    );
  }

  fs.writeFileSync(file, ':root {\n  --existing: 1px;\n}\n');
  const added = addVariable(directory, {
    file: 'src/styles/tokens.css',
    selector: ':root',
    name: '--new',
  });
  check(
    'a newly added variable defaults to unset',
    added.ok && fs.readFileSync(file, 'utf8').includes('--new: unset;'),
  );
  const explicitEmpty = addVariable(directory, {
    file: 'src/styles/tokens.css',
    selector: ':root',
    name: '--explicit-empty',
    value: '',
  });
  check(
    'an explicit empty value is preserved when adding a declaration',
    explicitEmpty.ok &&
      readDeclarations(fs.readFileSync(file, 'utf8'))[0].entries.find(
        (entry) => entry.name === '--explicit-empty',
      )?.value === '',
  );

  fs.rmSync(directory, { recursive: true, force: true });
}

// --- the real stylesheet ----------------------------------------------------
if (!fs.existsSync(path.join(source, 'src', 'styles'))) {
  console.log(`css-vars: ${checked} passed (synthetic only — no project at ${source})`);
} else {
  const { files } = readVariables(source);
  const base = files.find((file) => file.rel.endsWith('base.css'));
  check('the token stylesheet is found', !!base);

  const root = base.groups.find((group) => group.label === ':root');
  check(':root is its own group', !!root && root.kind === 'single');

  // The heading scale: one column per heading, one row per property. Found by
  // shape rather than by the comment above it — the heading is the author's
  // text and they are free to rename it, or to put the headings and the text
  // styles under one.
  const headings = root.blocks.find(
    (block) => block.kind === 'matrix' && block.columns.some((column) => column.label === 'h1'),
  );
  check('headings become a table', !!headings);
  check(
    'with a column per heading',
    ['display', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'].every((heading) =>
      columnLabels(headings, root).includes(heading),
    ),
    JSON.stringify(headings && columnLabels(headings, root)),
  );
  check(
    'and every property as a row',
    ['value', 'min', 'max', 'line-height', 'margin-top', 'trim-bottom', 'text-wrap'].every(
      (label) => rowLabels(headings).includes(label),
    ),
    rowLabels(headings).join(),
  );
  check(
    'including the ones a shallower reading would steal',
    rowLabels(headings).includes('margin-top') && rowLabels(headings).includes('trim-top'),
    'margin-top/trim-top were taken by a `top` family instead',
  );

  // The text styles share every one of those properties, so they belong to the
  // same table when they sit under the same comment and their own when they do
  // not — either way they are columns, not thirteen more rows.
  const textStyles = root.blocks.find(
    (block) =>
      block.kind === 'matrix' && block.columns.some((column) => column.label === 'text-main'),
  );
  check(
    'text styles are columns too',
    !!textStyles,
    JSON.stringify(root.blocks.map((block) => block.title)),
  );
  check(
    'with the same properties down the side',
    textStyles &&
      ['value', 'line-height', 'font-weight'].every((label) =>
        rowLabels(textStyles).includes(label),
      ),
    textStyles && rowLabels(textStyles).join(),
  );

  const spacing = root.blocks.find(
    (block) =>
      block.kind === 'matrix' && block.columns.some((column) => column.label === 'space-1'),
  );
  check('the spacing scale is a table', !!spacing && columnLabels(spacing, root).length >= 8);
  check('with the fluid pair as rows', !!spacing && rowLabels(spacing).join() === 'value,min,max');

  // The themes: three rules, one table.
  const theme = base.groups.find((group) => group.kind === 'modes' && group.label === 'Theme');
  check('the themes are one group', !!theme);
  check(
    'with a column per theme',
    theme &&
      theme.columns.map((column) => column.label).join() === 'Theme light,Theme dark,Theme brand',
    JSON.stringify(theme && theme.columns.map((column) => column.label)),
  );
  check(
    'the light column is named after its class, not :root',
    theme?.columns[0]?.selector?.startsWith(':root'),
    theme?.columns[0]?.selector,
  );
  check(
    'shared names are one row across the modes',
    theme &&
      theme.blocks[0].rows.every((row) => row.cells.length === 3 && row.cells.every(Boolean)),
    JSON.stringify(theme && theme.blocks[0].rows.map((row) => row.cells.map((cell) => !!cell))),
  );
  check(
    'a family of names inside becomes a section',
    theme &&
      ['selection', 'button', 'button-2', 'link'].every((title) =>
        theme.blocks.some((block) => block.title === title),
      ),
    JSON.stringify(theme && theme.blocks.map((block) => block.title)),
  );
  check(
    'and button-2 is not six more rows of button',
    theme && findBlock(theme, 'button').rows.length === 6,
    JSON.stringify(theme && rowLabels(findBlock(theme, 'button'))),
  );
  check(
    'a background is not a section of one',
    theme && rowLabels(theme.blocks[0]).includes('background-2'),
    JSON.stringify(theme && rowLabels(theme.blocks[0])),
  );

  // Colours resolve through the chain; the ones that cannot say so.
  const themeRows = theme.blocks[0].rows;
  const background = themeRows.find((row) => row.label === 'background');
  // Against the stylesheet itself rather than against a colour written down
  // here: this fixture is a real project someone is working in, and its palette
  // is theirs to change. What is being checked is that the swatch followed the
  // reference — `--background: var(--light-300)` shows what --light-300 IS —
  // and the hex it lands on is the project's business.
  const declaredColor = (name) => {
    for (const file of cssFiles(source)) {
      const text = fs.readFileSync(file, 'utf8');
      const hits = [...text.matchAll(new RegExp(`${name}\\s*:\\s*([^;{}]+);`, 'g'))];
      const last = hits[hits.length - 1];
      if (last && /^#[0-9a-f]{3,8}$/i.test(last[1].trim())) {
        return last[1].trim().toLowerCase();
      }
    }
    return undefined;
  };
  const through = (cell) => {
    if (!cell?.ref) {
      return undefined;
    }
    const want = declaredColor(cell.ref);
    return want ? cell.color?.toLowerCase() === want : undefined;
  };
  check(
    'a swatch resolves through its reference',
    through(background.cells[0]) === true,
    JSON.stringify(background.cells[0]),
  );
  check(
    'per mode',
    through(background.cells[1]) === true && through(background.cells[2]) === true,
    JSON.stringify([background.cells[1], background.cells[2]]),
  );
  const border = themeRows.find((row) => row.label === 'border');
  check(
    'a colour nothing can compute says so',
    border.cells[0].unknownColor === true && !border.cells[0].color,
  );

  // The panel resolves values against this map as they are typed (see
  // src/features/variables/fluid.ts), so it has to carry everything a value can reference.
  const { values } = readVariables(source);
  check(
    'every variable is in the resolution map',
    Object.keys(values).length > 200,
    `${Object.keys(values).length}`,
  );
  check('with its raw value', values['--viewport-max'] === '1440', values['--viewport-max']);

  // Nothing is lost: every declaration in the file is in some block.
  const declared = readDeclarations(
    fs.readFileSync(path.join(source, 'src', 'styles', 'base.css'), 'utf8'),
  ).flatMap((rule) =>
    rule.entries.filter((entry) => entry.kind === 'var').map((entry) => entry.name),
  );
  const shown = new Set();
  for (const group of base.groups) {
    for (const block of group.blocks) {
      for (const row of block.rows) {
        for (const cell of row.cells) {
          if (cell) {
            shown.add(cell.name);
          }
        }
      }
    }
  }
  const missing = [...new Set(declared)].filter((name) => !shown.has(name));
  check(
    'every variable in the file is shown somewhere',
    missing.length === 0,
    missing.slice(0, 8).join(', '),
  );

  // The utility stylesheet: many rules, one variable each, all the same name.
  const utilities = files.find((file) => file.rel.endsWith('utilities.css'));
  if (utilities) {
    const gaps = utilities.groups.find((group) => group.columns.length > 3);
    check(
      'a scale spread over many rules becomes columns',
      !!gaps,
      JSON.stringify(utilities.groups.map((group) => group.columns.length)),
    );
    check('with one row', gaps && gaps.blocks[0].rows.length === 1);
  }

  console.log(`css-vars: ${checked - failures.length} passed  [${files.length} stylesheets]`);
}

if (failures.length) {
  console.error(`\ncss-vars: ${failures.length} failed, ${checked - failures.length} passed\n`);
  console.error(failures.join('\n') + '\n');
  process.exit(1);
}
