// Renaming a variable, and everything that reads it.
//
//   node test/electron/project/cssVarsRename.test.js
//
// A custom property's name lives nowhere but in the text: the declaration that
// sets it, and every `var(--…)` that reads it, across however many stylesheets
// and components a project has. Rename the declaration alone and the site keeps
// working — silently, on the fallbacks — which is the worst way for this to go
// wrong, because nothing reports it and the panel still looks right.
//
// Groups are not stored anywhere either: the panel works them out from shared
// name prefixes, so renaming the group `max-width` is renaming every member of
// it at once. Both come through the same call, and these check the parts that
// are easy to get wrong: which text counts as the name (and which merely
// contains it), that a whole batch lands or none of it does, and that a name
// already in use is refused rather than merged into.

const fs = require('fs');
const os = require('os');
const path = require('path');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) {
    failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  }
};

const { renameVariables, setSectionTitle, removeSection, addSection, moveHeading, readVariables } = require('#dist/electron/project/cssVars.js');

// A project of the shape the screenshots came from: a group of sizes, a couple
// of modes declaring the same names, references from another stylesheet and
// from a component's own <style> block.
const FILES = {
  'src/styles/base.css': `:root {
  --max-width-small: 50rem;
  --max-width-main: calc(var(--site-viewport-max) * 1rem);
  --max-width-full: 100%;
  --max-width: 60rem;
  --radius-main: 1rem;
}
.theme-dark {
  --max-width-main: 70rem;
}
`,
  'src/styles/layout.css': `.container {
  max-width: var(--max-width-main);
  width: min(var(--max-width-main), 100%);
  padding: var(--max-width-small, 40rem);
}
.wide { max-width: var(--max-width-full); }
/* --max-width-main is the one the container uses */
`,
  'src/components/Card.astro': `<div class="card" style="--max-width-main: 30rem">card</div>
<style>
  .card { max-width: var(--max-width-main); border-radius: var(--radius-main); }
</style>
`,
  // Places a reference lives that are not the project's stylesheet folders: a
  // config at the root, a helper module, a page's frontmatter, and a file under
  // a directory nobody would have thought to list.
  'tailwind.config.js': `export default { theme: { maxWidth: { ` + `main: 'var(--max-width-main)' } } }\n`,
  'src/lib/theme.ts': `export const wide = { maxWidth: 'var(--max-width-main)' }\n`,
  'app/legacy/old.css': `.legacy { max-width: var(--max-width-main); }\n`,
  'node_modules/some-dep/dep.css': `.dep { max-width: var(--max-width-main); }\n`,
  'dist/build.css': `.built { max-width: var(--max-width-main); }\n`,
};

const write = (directory, files) => {
  for (const [rel, text] of Object.entries(files)) {
    const abs = path.join(directory, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  }
};
const project = (files = FILES) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-rename-'));
  write(directory, files);
  return directory;
};
const read = (directory, rel) => fs.readFileSync(path.join(directory, rel), 'utf8');

(async () => {
  // --- one variable ---------------------------------------------------------
  {
    const directory = project();
    const out = renameVariables(directory, {
      renames: [{ from: '--max-width-main', to: '--max-width-wide' }],
    });
    check('the rename reports success', out.ok === true, JSON.stringify(out));
    // 2 declarations, 3 in layout.css (two references and the comment naming it),
    // 2 in the component (its <style> and a style attribute), and one each in the
    // config, the helper module and the stray stylesheet outside src/.
    check('and says how much it touched', out.files === 6 && out.occurrences === 10, JSON.stringify(out));

    const base = read(directory, 'src/styles/base.css');
    check('the declaration is renamed', base.includes('--max-width-wide: calc('), base);
    check('and so is the one in the other mode', /\.theme-dark \{\n  --max-width-wide: 70rem;/.test(base), base);
    check('its siblings are left alone', base.includes('--max-width-small: 50rem') && base.includes('--max-width-full: 100%'), base);

    const layout = read(directory, 'src/styles/layout.css');
    check('every reference follows it', !layout.includes('--max-width-main'), layout);
    check('including one inside a function', layout.includes('min(var(--max-width-wide), 100%)'), layout);
    check('a reference with a fallback keeps the fallback', layout.includes('var(--max-width-small, 40rem)'), layout);
    check('a comment that names it is renamed too', layout.includes('/* --max-width-wide is the one'), layout);

    const card = read(directory, 'src/components/Card.astro');
    check("a component's own <style> follows too", card.includes('var(--max-width-wide)'), card);
    check('and so does a style attribute in its markup', card.includes('style="--max-width-wide: 30rem"'), card);
  }

  // --- everywhere else it is written ----------------------------------------
  //
  // The panel reads variables from the project's stylesheet folders; references
  // are wherever someone wrote them. A rename that only covered the folders the
  // panel reads would leave those pointing at a name that no longer exists —
  // and CSS says nothing when that happens, it just falls back.
  {
    const directory = project();
    renameVariables(directory, { renames: [{ from: '--max-width-main', to: '--max-width-wide' }] });
    check(
      'a config at the project root follows',
      read(directory, 'tailwind.config.js').includes('var(--max-width-wide)'),
      read(directory, 'tailwind.config.js'),
    );
    check('so does a TypeScript module', read(directory, 'src/lib/theme.ts').includes('var(--max-width-wide)'), read(directory, 'src/lib/theme.ts'));
    check(
      'and a stylesheet in a folder of its own',
      read(directory, 'app/legacy/old.css').includes('var(--max-width-wide)'),
      read(directory, 'app/legacy/old.css'),
    );
    // Not the project's text: renaming into a dependency or a build would be
    // undone by the next install or build, and is not ours to edit.
    check('a dependency is left alone', read(directory, 'node_modules/some-dep/dep.css').includes('var(--max-width-main)'));
    check('and so is build output', read(directory, 'dist/build.css').includes('var(--max-width-main)'));
  }

  // --- the name, and things that merely contain it --------------------------
  {
    // `--max-width` is a name AND the start of four other names. Renaming it must
    // move exactly one declaration and leave its longer namesakes alone — this is
    // the mistake a plain string replacement makes.
    const directory = project();
    const out = renameVariables(directory, { renames: [{ from: '--max-width', to: '--measure' }] });
    const base = read(directory, 'src/styles/base.css');
    check('a shorter name does not eat the longer ones', out.ok && base.includes('--measure: 60rem'), base);
    check('which keep their own names', base.includes('--max-width-small') && base.includes('--max-width-main'), base);
    check('and their references', read(directory, 'src/styles/layout.css').includes('var(--max-width-main)'));
  }

  // --- a whole group --------------------------------------------------------
  {
    // What renaming the group heading does: every member at once, in one pass.
    const directory = project();
    const out = renameVariables(directory, {
      renames: [
        { from: '--max-width-small', to: '--container-small' },
        { from: '--max-width-main', to: '--container-main' },
        { from: '--max-width-full', to: '--container-full' },
      ],
    });
    const base = read(directory, 'src/styles/base.css');
    const layout = read(directory, 'src/styles/layout.css');
    check('the group renames as one', out.ok === true, JSON.stringify(out));
    check('each member takes the new prefix', /--container-small:/.test(base) && /--container-main:/.test(base) && /--container-full:/.test(base), base);
    check('the name that only looked like a member stays', base.includes('--max-width: 60rem'), base);
    check('and the references moved with them', layout.includes('var(--container-main)') && layout.includes('var(--container-full)'), layout);
  }

  // --- a swap ---------------------------------------------------------------
  {
    // Two names trading places in one batch. Applied one after another this
    // collapses into a single name; applied in one pass it is a swap.
    const directory = project();
    const out = renameVariables(directory, {
      renames: [
        { from: '--max-width-small', to: '--max-width-full' },
        { from: '--max-width-full', to: '--max-width-small' },
      ],
    });
    const base = read(directory, 'src/styles/base.css');
    check('a swap is allowed', out.ok === true, JSON.stringify(out));
    check('and both names survive it', base.includes('--max-width-full: 50rem') && base.includes('--max-width-small: 100%'), base);
  }

  // --- what is refused ------------------------------------------------------
  {
    const directory = project();
    const taken = renameVariables(directory, {
      renames: [{ from: '--max-width-small', to: '--radius-main' }],
    });
    check('a name already in use is refused', taken.ok === false && /already exists/.test(taken.error), JSON.stringify(taken));
    check('and nothing is written', read(directory, 'src/styles/base.css').includes('--max-width-small: 50rem'));

    const empty = renameVariables(directory, {
      renames: [{ from: '--max-width-small', to: '--' }],
    });
    check('a name that is not a name is refused', empty.ok === false, JSON.stringify(empty));
    const spaced = renameVariables(directory, {
      renames: [{ from: '--max-width-small', to: '--two words' }],
    });
    check('and so is one with a space in it', spaced.ok === false, JSON.stringify(spaced));
    check('the error says what was wrong with it', /cannot be a variable name/.test(spaced.error || ''), spaced.error);

    const clash = renameVariables(directory, {
      renames: [
        { from: '--max-width-small', to: '--size' },
        { from: '--max-width-main', to: '--size' },
      ],
    });
    check('two renames onto one name are refused', clash.ok === false && /both be called/.test(clash.error), JSON.stringify(clash));
    check('and that batch writes nothing either', read(directory, 'src/styles/base.css').includes('--max-width-main: calc('));
  }

  // --- a heading that is a comment ------------------------------------------
  //
  // A file with one rule takes its headings from the comments in it, so that
  // kind of heading is not a name anything shares — it is those words, and
  // renaming it is writing them. Nothing else refers to them, which is why this
  // is a one-file edit and a variable's name is not.
  {
    const directory = project({
      'src/styles/tokens.css': `:root {
  /* Swatches */
  --light-100: #ffffff;
  --dark-900: #1f1d1e;

  /* Radius */
  --radius-small: 0.5rem;
  --radius-main: 1rem;
}
`,
    });
    const blockFor = (title) => readVariables(directory).files[0].groups[0].blocks.find((block) => block.title === title);

    const swatches = blockFor('Swatches');
    check('the heading knows where it is written', typeof swatches.titleStart === 'number', JSON.stringify(swatches.titleStart));

    const out = setSectionTitle(directory, {
      file: 'src/styles/tokens.css',
      start: swatches.titleStart,
      end: swatches.titleEnd,
      expect: 'Swatches',
      title: 'Palette',
    });
    const css = read(directory, 'src/styles/tokens.css');
    check('renaming it rewrites the comment', out.ok && css.includes('/* Palette */'), css);
    check('and leaves the comment a comment', css.includes('/* Palette */\n  --light-100'), css);
    check('the variables under it are untouched', css.includes('--light-100: #ffffff'), css);
    check('and the other heading is left alone', css.includes('/* Radius */'), css);
    check(
      'the panel reads the new heading back',
      !!blockFor('Palette'),
      readVariables(directory)
        .files[0].groups[0].blocks.map((block) => block.title)
        .join('|'),
    );

    // `*/` would close the comment early and swallow the rest of the rule.
    const radius = blockFor('Radius');
    const broken = setSectionTitle(directory, {
      file: 'src/styles/tokens.css',
      start: radius.titleStart,
      end: radius.titleEnd,
      expect: 'Radius',
      title: 'Radius */ .evil {',
    });
    check('a heading that would close the comment is refused', broken.ok === false, JSON.stringify(broken));
    check(
      'an empty heading is refused too',
      setSectionTitle(directory, {
        file: 'src/styles/tokens.css',
        start: radius.titleStart,
        end: radius.titleEnd,
        expect: 'Radius',
        title: '   ',
      }).ok === false,
    );
    check('and the file still says Radius', read(directory, 'src/styles/tokens.css').includes('/* Radius */'));

    // The offsets are only meaningful against the text they were read from.
    const stale = setSectionTitle(directory, {
      file: 'src/styles/tokens.css',
      start: radius.titleStart,
      end: radius.titleEnd,
      expect: 'Something else',
      title: 'Corners',
    });
    check('a heading that moved under us is refused', stale.ok === false && stale.stale === true, JSON.stringify(stale));
  }

  // --- a heading is a line between runs --------------------------------------
  //
  // Which is all a comment heading is: the variables above it are one group and
  // the ones below are another. So removing it joins them, and writing another
  // one splits them — the two things the heading's menu does besides renaming.
  {
    const SHEET = `:root {
  /* Swatches */
  --light-100: #ffffff;
  --dark-900: #1f1d1e;

  /* Radius */
  --radius-small: 0.5rem;
  --radius-main: 1rem;
  --radius-round: 100vw;
}
`;
    const titles = (directory) => readVariables(directory).files[0].groups[0].blocks.map((block) => block.title);
    const blockFor = (directory, title) => readVariables(directory).files[0].groups[0].blocks.find((block) => block.title === title);

    {
      const directory = project({ 'src/styles/tokens.css': SHEET });
      const radius = blockFor(directory, 'Radius');
      const out = removeSection(directory, {
        file: 'src/styles/tokens.css',
        start: radius.titleStart,
        end: radius.titleEnd,
        expect: 'Radius',
      });
      const css = read(directory, 'src/styles/tokens.css');
      check('deleting a heading takes the comment', out.ok && !css.includes('/* Radius */'), css);
      // The whole line goes, not just the words: an indent left on a line of its
      // own is whitespace nobody typed.
      check('and the line it was on', !/^[ \t]+$/m.test(css), JSON.stringify(css));
      check('its variables stay where they were', css.includes('--radius-small: 0.5rem') && css.includes('--radius-round: 100vw'), css);
      check('and join the group above', titles(directory).join('|') === 'Swatches', titles(directory).join('|'));
      check('the other heading is untouched', css.includes('/* Swatches */'), css);
    }

    {
      // Removing the FIRST heading leaves its names with no heading at all,
      // which the sheet shows as the group's own untitled list.
      const directory = project({ 'src/styles/tokens.css': SHEET });
      const swatches = blockFor(directory, 'Swatches');
      removeSection(directory, {
        file: 'src/styles/tokens.css',
        start: swatches.titleStart,
        end: swatches.titleEnd,
        expect: 'Swatches',
      });
      // Its names now head the group with no title of their own, which is how
      // the sheet shows variables declared before any comment.
      const after = titles(directory);
      check('the first heading can go too', after[0] === undefined && after[1] === 'Radius', JSON.stringify(after));
      check('and nothing else moves', read(directory, 'src/styles/tokens.css').includes('--light-100: #ffffff'), read(directory, 'src/styles/tokens.css'));
    }

    {
      // What Duplicate does: another heading, above the last variable of the run
      // — so the new group has something under it and can be seen.
      const directory = project({ 'src/styles/tokens.css': SHEET });
      const out = addSection(directory, {
        file: 'src/styles/tokens.css',
        selector: ':root',
        title: 'Radius copy',
        before: '--radius-round',
      });
      const css = read(directory, 'src/styles/tokens.css');
      check('duplicating writes a second heading', out.ok && css.includes('/* Radius copy */'), css);
      check('above the variable it was given', /\/\* Radius copy \*\/\n\s*--radius-round/.test(css), css);
      check(
        'indented like the line under it',
        /\n  \/\* Radius copy \*\//.test(css),
        JSON.stringify(css.slice(css.indexOf('Radius copy') - 8, css.indexOf('Radius copy') + 4)),
      );
      check('and the sheet reads it as a group of its own', titles(directory).join('|') === 'Swatches|Radius|Radius copy', titles(directory).join('|'));
      check(
        'with the variable under it',
        blockFor(directory, 'Radius copy')
          .rows.map((row) => row.name)
          .join() === '--radius-round',
        JSON.stringify(blockFor(directory, 'Radius copy').rows.map((row) => row.name)),
      );
      check(
        'and the rest left in the first',
        blockFor(directory, 'Radius')
          .rows.map((row) => row.name)
          .join() === '--radius-small,--radius-main',
        JSON.stringify(blockFor(directory, 'Radius').rows.map((row) => row.name)),
      );
    }

    {
      // What Duplicate does: an empty heading directly above an existing one, so
      // the new group starts with nothing in it and the old one keeps all of its
      // variables. A group with no variables is still a group — it is the one
      // you are about to fill.
      const directory = project({ 'src/styles/tokens.css': SHEET });
      const radius = blockFor(directory, 'Radius');
      const out = addSection(directory, {
        file: 'src/styles/tokens.css',
        selector: ':root',
        title: 'Radius copy',
        at: radius.titleStart,
      });
      const css = read(directory, 'src/styles/tokens.css');
      check('an empty heading can be written above another', out.ok === true, JSON.stringify(out));
      check('and lands on the line above it', /\/\* Radius copy \*\/\n\s*\/\* Radius \*\//.test(css), css);
      check('indented to match', /\n  \/\* Radius copy \*\//.test(css), JSON.stringify(css));

      const after = readVariables(directory).files[0].groups[0].blocks;
      check(
        'the sheet shows it in order',
        after.map((block) => block.title).join('|') === 'Swatches|Radius copy|Radius',
        after.map((block) => block.title).join('|'),
      );
      // A group with nothing in it is still a group — dropped, it would be a
      // heading you wrote and then could not find.
      const made = after.find((block) => block.title === 'Radius copy');
      check('with nothing in it', made?.rows.length === 0, made ? JSON.stringify(made.rows.length) : 'no such group');
      check(
        'and the group it came from keeps all of its own',
        after.find((block) => block.title === 'Radius')?.rows.length === 3,
        JSON.stringify(after.find((block) => block.title === 'Radius')?.rows.map((row) => row.name)),
      );
    }

    {
      // Dragging a heading moves the heading. The variables stay exactly where
      // they are — and that is the whole point: the ones that end up below it
      // are now the ones it heads.
      const directory = project({ 'src/styles/tokens.css': SHEET });
      const radius = blockFor(directory, 'Radius');
      const out = moveHeading(directory, {
        file: 'src/styles/tokens.css',
        selector: ':root',
        start: radius.titleStart,
        end: radius.titleEnd,
        expect: 'Radius',
        before: '--dark-900',
      });
      const css = read(directory, 'src/styles/tokens.css');
      check('a heading can be moved on its own', out.ok === true, JSON.stringify(out));
      check('to sit above the variable it was dropped on', /\/\* Radius \*\/\n\s*--dark-900/.test(css), css);
      check('and every variable stays where it was', /--light-100:[^\n]*\n\s*--dark-900/.test(css.replace(/\/\* Radius \*\/\n\s*/, '')), css);
      check(
        'so the ones below it are now its own',
        blockFor(directory, 'Radius')
          .rows.map((row) => row.name)
          .join() === '--dark-900,--radius-small,--radius-main,--radius-round',
        JSON.stringify(blockFor(directory, 'Radius').rows.map((row) => row.name)),
      );
      check(
        'and the group above it keeps the rest',
        blockFor(directory, 'Swatches')
          .rows.map((row) => row.name)
          .join() === '--light-100',
        JSON.stringify(blockFor(directory, 'Swatches').rows.map((row) => row.name)),
      );
      check('the comment itself is unchanged', (css.match(/\/\* Radius \*\//g) || []).length === 1, css);
    }

    {
      // Dropped past everything: it heads nothing yet, and heads whatever is
      // added next.
      const directory = project({ 'src/styles/tokens.css': SHEET });
      const swatches = blockFor(directory, 'Swatches');
      const out = moveHeading(directory, {
        file: 'src/styles/tokens.css',
        selector: ':root',
        start: swatches.titleStart,
        end: swatches.titleEnd,
        expect: 'Swatches',
        before: undefined,
      });
      const css = read(directory, 'src/styles/tokens.css');
      check('a heading can be moved to the end', out.ok === true, JSON.stringify(out));
      check('landing after the last variable', /--radius-round: 100vw;\n\s*\/\* Swatches \*\//.test(css), css);
      check('where it heads nothing', blockFor(directory, 'Swatches').rows.length === 0, JSON.stringify(blockFor(directory, 'Swatches').rows.length));
      check(
        'and what it used to head is now the untitled run',
        readVariables(directory).files[0].groups[0].blocks[0].title === undefined,
        JSON.stringify(readVariables(directory).files[0].groups[0].blocks.map((block) => block.title)),
      );

      const stale = moveHeading(directory, {
        file: 'src/styles/tokens.css',
        selector: ':root',
        start: swatches.titleStart,
        end: swatches.titleEnd,
        expect: 'Swatches',
        before: '--radius-main',
      });
      check('a heading that moved under us is refused', stale.ok === false && stale.stale === true, JSON.stringify(stale));
    }

    {
      const directory = project({ 'src/styles/tokens.css': SHEET });
      check(
        'a heading that would close its own comment is refused',
        addSection(directory, {
          file: 'src/styles/tokens.css',
          selector: ':root',
          title: 'a */ b',
          before: '--radius-main',
        }).ok === false,
      );
      check(
        'an empty one is refused',
        addSection(directory, {
          file: 'src/styles/tokens.css',
          selector: ':root',
          title: '  ',
          before: '--radius-main',
        }).ok === false,
      );
      check(
        'and a rule that is not there is refused',
        addSection(directory, {
          file: 'src/styles/tokens.css',
          selector: '.gone',
          title: 'x',
          before: undefined,
        }).ok === false,
      );
      const radius = blockFor(directory, 'Radius');
      const stale = removeSection(directory, {
        file: 'src/styles/tokens.css',
        start: radius.titleStart,
        end: radius.titleEnd,
        expect: 'Something else',
      });
      check('deleting a heading that moved under us is refused', stale.ok === false && stale.stale === true, JSON.stringify(stale));
      check('and the file is whole', read(directory, 'src/styles/tokens.css') === SHEET, read(directory, 'src/styles/tokens.css'));
    }
  }

  // --- nothing to do --------------------------------------------------------
  {
    const directory = project();
    const same = renameVariables(directory, {
      renames: [{ from: '--max-width-main', to: '--max-width-main' }],
    });
    check('renaming a name to itself does nothing', same.ok === true && same.files === 0, JSON.stringify(same));
    const none = renameVariables(directory, { renames: [] });
    check('and an empty batch is not an error', none.ok === true, JSON.stringify(none));
    const missing = renameVariables(directory, {
      renames: [{ from: '--not-here', to: '--nor-here' }],
    });
    check('a name nothing declares touches nothing', missing.ok === true && missing.occurrences === 0, JSON.stringify(missing));
  }

  if (failures.length) {
    console.error(`css-vars-rename: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`css-vars-rename: ${checked} passed  [names, groups, headings: rename, split, join]`);
})();
