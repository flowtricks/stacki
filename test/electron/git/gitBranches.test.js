// Merging a branch and deleting one.
//
//   node test/electron/git/gitBranches.test.js
//
// Against real repositories, because the whole of this code is a reading of
// what git says when it refuses, and git says it in places that are easy to
// guess wrong about. The conflict report goes to STDOUT — stderr is empty —
// so a handler reading only stderr sees a merge that failed for no stated
// reason and passes an empty string to the user. That is the bug this file
// exists to catch.
//
// The other half is what happens to the working tree. A conflicted merge
// leaves conflict markers in the files, and this editor parses those files as
// markup a moment later; the page would come back broken with nothing to say
// why. So a merge that cannot complete has to leave the branch exactly as it
// found it, and that is checked here as a property of the tree, not of the
// message.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { mergeBranch, deleteBranch, switchBranch, resolveMerge } = require('#dist/electron/git/gitBranches.js');
const { parkBranch, unparkBranch } = require('#dist/electron/git/gitParking.js');
const { setToolPathHome } = require('#dist/electron/lib/nodeTools.js');
setToolPathHome(os.homedir());

const parking = (projectPath) => ({
  park: (branch) => parkBranch(projectPath, branch),
  unpark: (branch) => unparkBranch(projectPath, branch),
});

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) {
    failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  }
};

// The runner the module takes, without main.js's PATH repair — nothing here
// runs from a packaged app.
const git = (cwd, args) =>
  new Promise((resolve, reject) => {
    execFile('git', args, { cwd }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      } else {
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      }
    });
  });

const sh = async (cwd, ...args) => (await git(cwd, args)).stdout.trim();

// A repository on `main` with one commit, and a `feature` branch off it.
async function repo(name) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `stacki-git-${name}-`));
  await sh(directory, 'init', '-q', '-b', 'main', '.');
  await sh(directory, 'config', 'core.autocrlf', 'false');
  await sh(directory, 'config', 'user.email', 'test@example.com');
  await sh(directory, 'config', 'user.name', 'Test');
  fs.writeFileSync(path.join(directory, 'a.txt'), 'base\n');
  await sh(directory, 'add', '-A');
  await sh(directory, 'commit', '-qm', 'first');
  return directory;
}

const commitOn = async (directory, branch, file, body) => {
  await sh(directory, 'checkout', '-q', branch);
  fs.writeFileSync(path.join(directory, file), body);
  await sh(directory, 'add', '-A');
  await sh(directory, 'commit', '-qm', `${file} on ${branch}`);
};

const caught = async (callback) => {
  try {
    return { value: await callback(), error: undefined };
  } catch (error) {
    return { value: undefined, error: String(error.message || error) };
  }
};

(async () => {
  const cleanup = [];

  // --- A merge that has somewhere to go ------------------------------------
  {
    const directory = await repo('ff');
    cleanup.push(directory);
    await sh(directory, 'checkout', '-qb', 'feature');
    await commitOn(directory, 'feature', 'b.txt', 'from feature\n');
    await sh(directory, 'checkout', '-q', 'main');

    const result = await mergeBranch(git, { projectPath: directory, branch: 'feature' });
    check('a merge that moves work reports it', result.changed === true, JSON.stringify(result));
    check('the merge names the branch merged into', result.into === 'main', result.into);
    check('the merged file is on the branch afterwards', fs.existsSync(path.join(directory, 'b.txt')));

    // Once merged, git's safe delete is willing.
    const deleted = await deleteBranch(git, { projectPath: directory, branch: 'feature' });
    check('a merged branch deletes without forcing', deleted.ok === true, JSON.stringify(deleted));
    const left = await sh(directory, 'branch', '--format=%(refname:short)');
    check('and is gone from the list', left === 'main', left);
  }

  // --- A merge with nothing to bring ---------------------------------------
  {
    const directory = await repo('noop');
    cleanup.push(directory);
    await sh(directory, 'branch', 'behind');
    const result = await mergeBranch(git, { projectPath: directory, branch: 'behind' });
    // "Merged" here would claim work arrived that was already present. The
    // caller says something different on the strength of this flag.
    check('a merge that moves nothing says so', result.changed === false, JSON.stringify(result));
  }

  // --- A merge that conflicts ----------------------------------------------
  {
    const directory = await repo('conflict');
    cleanup.push(directory);
    await sh(directory, 'checkout', '-qb', 'feature');
    await commitOn(directory, 'feature', 'a.txt', 'feature wins\n');
    await commitOn(directory, 'main', 'a.txt', 'main wins\n');

    const head = await sh(directory, 'rev-parse', 'HEAD');
    const result = await mergeBranch(git, { projectPath: directory, branch: 'feature' });

    // A question, not a failure. It used to throw an error naming a terminal
    // command, which in an app built so nobody needs a terminal was a refusal
    // wearing an explanation.
    check('a clash comes back as something to answer', result.ok === false, JSON.stringify(result));
    check('flagged as a clash', result.conflicted === true, JSON.stringify(result));
    check('naming the file', result.files?.[0]?.path === 'a.txt', JSON.stringify(result.files));
    check('and both branches', result.from === 'main' && result.branch === 'feature', JSON.stringify(result));
    // Both versions come back, because "yours or theirs" cannot be answered
    // from two labels — the person deciding has to see what is in them.
    check('with this branch’s version', result.files[0].ours.trim() === 'main wins', result.files[0].ours);
    check('and the incoming one', result.files[0].theirs.trim() === 'feature wins', result.files[0].theirs);

    // The tree, not the message: this is what keeps the editor from parsing
    // conflict markers as markup while the user is deciding.
    const status = await sh(directory, 'status', '--porcelain');
    check('nothing is left conflicted in the tree', status === '', status);
    check('the branch is where it was', (await sh(directory, 'rev-parse', 'HEAD')) === head);
    check('no conflict markers were left in the file', !fs.readFileSync(path.join(directory, 'a.txt'), 'utf8').includes('<<<<<<<'));
    check('and the file still says what the branch said', fs.readFileSync(path.join(directory, 'a.txt'), 'utf8').trim() === 'main wins');
  }

  // --- Answering the clash, in the app -------------------------------------
  {
    const directory = await repo('resolve');
    cleanup.push(directory);
    fs.writeFileSync(path.join(directory, 'b.txt'), 'base\n');
    await sh(directory, 'add', '-A');
    await sh(directory, 'commit', '-qm', 'two files');
    await sh(directory, 'checkout', '-qb', 'feature');
    fs.writeFileSync(path.join(directory, 'a.txt'), 'feature a\n');
    fs.writeFileSync(path.join(directory, 'b.txt'), 'feature b\n');
    await sh(directory, 'add', '-A');
    await sh(directory, 'commit', '-qm', 'feature both');
    await sh(directory, 'checkout', '-q', 'main');
    fs.writeFileSync(path.join(directory, 'a.txt'), 'main a\n');
    fs.writeFileSync(path.join(directory, 'b.txt'), 'main b\n');
    await sh(directory, 'add', '-A');
    await sh(directory, 'commit', '-qm', 'main both');

    const clash = await mergeBranch(git, { projectPath: directory, branch: 'feature' });
    check('both clashing files come back', clash.files.length === 2, JSON.stringify(clash.files.map((file) => file.path)));

    // One decision per file — a merge taking the page from one branch and the
    // stylesheet from the other is completely ordinary.
    const done = await resolveMerge(git, {
      projectPath: directory,
      branch: 'feature',
      choices: { 'a.txt': 'ours', 'b.txt': 'theirs' },
    });
    check('the merge finishes', done.ok === true, JSON.stringify(done));
    check('keeping mine where I said', fs.readFileSync(path.join(directory, 'a.txt'), 'utf8').trim() === 'main a');
    check('and theirs where I said', fs.readFileSync(path.join(directory, 'b.txt'), 'utf8').trim() === 'feature b');
    // A real merge commit, so the branch counts as merged afterwards and the
    // safe delete will allow itself.
    check('it is a real merge commit', (await sh(directory, 'log', '-1', '--format=%P')).split(' ').length === 2);
    check('the tree is clean', (await sh(directory, 'status', '--porcelain')) === '');
    check(
      'and no markers survived',
      !fs.readFileSync(path.join(directory, 'a.txt'), 'utf8').includes('<<<<<<<') &&
        !fs.readFileSync(path.join(directory, 'b.txt'), 'utf8').includes('<<<<<<<'),
    );
    const deleted = await deleteBranch(git, { projectPath: directory, branch: 'feature' });
    check('and the branch now deletes as merged', deleted.ok === true, JSON.stringify(deleted));
  }

  // --- Taking part of a file from each branch -------------------------------
  //
  // The whole reason conflicts are shown as separate differences rather than
  // one all-or-nothing switch: a page whose heading came from one branch and
  // whose footer came from the other is completely ordinary.
  {
    const directory = await repo('hunks');
    cleanup.push(directory);
    const page = (hero, footer) => [hero, ...Array.from({ length: 6 }, (_, i) => `unchanged ${i}`), footer].join('\n') + '\n';
    fs.writeFileSync(path.join(directory, 'p.astro'), page('HERO', 'FOOTER'));
    await sh(directory, 'add', '-A');
    await sh(directory, 'commit', '-qm', 'page');
    await sh(directory, 'checkout', '-qb', 'feature');
    fs.writeFileSync(path.join(directory, 'p.astro'), page('HERO FEATURE', 'FOOTER FEATURE'));
    await sh(directory, 'add', '-A');
    await sh(directory, 'commit', '-qm', 'feature page');
    await sh(directory, 'checkout', '-q', 'main');
    fs.writeFileSync(path.join(directory, 'p.astro'), page('HERO MAIN', 'FOOTER MAIN'));
    await sh(directory, 'add', '-A');
    await sh(directory, 'commit', '-qm', 'main page');

    const clash = await mergeBranch(git, { projectPath: directory, branch: 'feature' });
    const file = clash.files.find((file) => file.path === 'p.astro');
    const clashes = (file.parts || []).filter((part) => part.kind === 'clash');
    // Two edits far enough apart that git reports them separately. If they
    // came back as one, there would be nothing to choose between per-part.
    check('the two edits come back separately', clashes.length === 2, JSON.stringify(clashes));
    check('the heading is one of them', clashes[0].ours.trim() === 'HERO MAIN', clashes[0].ours);
    check('and the footer the other', clashes[1].theirs.trim() === 'FOOTER FEATURE', clashes[1].theirs);

    // Heading from the incoming branch, footer from this one.
    const done = await resolveMerge(git, {
      projectPath: directory,
      branch: 'feature',
      choices: { 'p.astro': ['theirs', 'ours'] },
    });
    check('a mixed merge finishes', done.ok === true, JSON.stringify(done));
    const out = fs.readFileSync(path.join(directory, 'p.astro'), 'utf8');
    check('the heading came from the other branch', out.includes('HERO FEATURE'), out);
    check('the footer stayed on this one', out.includes('FOOTER MAIN'), out);
    check('and the versions not chosen are gone', !out.includes('HERO MAIN') && !out.includes('FOOTER FEATURE'), out);
    // The lines both branches agreed on are not part of the choice and must
    // survive untouched — losing one would be silent and permanent.
    check(
      'every agreed line survived',
      Array.from({ length: 6 }, (_, i) => `unchanged ${i}`).every((line) => out.includes(line)),
      out,
    );
    check('no markers were left behind', !out.includes('<<<<<<<') && !out.includes('======='), out);
    check('the tree is clean', (await sh(directory, 'status', '--porcelain')) === '');
    check('and it is a real merge commit', (await sh(directory, 'log', '-1', '--format=%P')).split(' ').length === 2);
  }

  // --- The real case: one edit each, right next to each other ---------------
  //
  // Make a branch. Change the heading on one side and the paragraph directly
  // under it on the other. Git reports that as a single conflict, because the
  // two edits are adjacent — and every answer to it is wrong: either side
  // loses an edit, and "both" duplicates the heading and the paragraph.
  //
  // Nobody disagrees about anything here. Each branch changed a different
  // thing, and the merge everyone wants is both changes.
  {
    const directory = await repo('adjacent');
    cleanup.push(directory);
    const page = (heading, paragraph) => `<section>\n  <h2>${heading}</h2>\n  <p>${paragraph}</p>\n</section>\n`;
    fs.writeFileSync(path.join(directory, 'index.astro'), page('Heading 2', 'original paragraph'));
    await sh(directory, 'add', '-A');
    await sh(directory, 'commit', '-qm', 'page');
    await sh(directory, 'checkout', '-qb', 'new-branch');
    // Only the heading here.
    fs.writeFileSync(path.join(directory, 'index.astro'), page('Heading 3', 'original paragraph'));
    await sh(directory, 'add', '-A');
    await sh(directory, 'commit', '-qm', 'new heading');
    await sh(directory, 'checkout', '-q', 'main');
    // Only the paragraph here.
    fs.writeFileSync(path.join(directory, 'index.astro'), page('Heading 2', 'rewritten paragraph'));
    await sh(directory, 'add', '-A');
    await sh(directory, 'commit', '-qm', 'new paragraph');

    const clash = await mergeBranch(git, { projectPath: directory, branch: 'new-branch' });
    const file = clash.files.find((file) => file.path === 'index.astro');
    const clashes = (file.parts || []).filter((part) => part.kind === 'clash');
    check('the one conflict is split into two decisions', clashes.length === 2, JSON.stringify(clashes));
    check('the heading credited to the branch that changed it', clashes[0].changedBy === 'theirs', JSON.stringify(clashes[0]));
    check('the paragraph to the other one', clashes[1].changedBy === 'ours', JSON.stringify(clashes[1]));
    // Neither is a real disagreement, so neither needs asking about.
    check('neither is contested', !clashes.some((clash) => clash.changedBy === 'both'), JSON.stringify(clashes));

    // What the dialog defaults to: whoever actually made each change.
    const picks = clashes.map((clash) => (clash.changedBy === 'theirs' ? 'theirs' : 'ours'));
    const done = await resolveMerge(git, {
      projectPath: directory,
      branch: 'new-branch',
      choices: { 'index.astro': picks },
    });
    check('the merge finishes', done.ok === true, JSON.stringify(done));

    const out = fs.readFileSync(path.join(directory, 'index.astro'), 'utf8');
    check('the new heading survived', out.includes('Heading 3'), out);
    check('and the rewritten paragraph', out.includes('rewritten paragraph'), out);
    check('the superseded heading is gone', !out.includes('Heading 2'), out);
    check('the superseded paragraph is gone', !out.includes('original paragraph'), out);
    // Nothing duplicated — the failure "both" would have produced.
    check('the heading appears once', (out.match(/<h2>/g) || []).length === 1, out);
    check('the paragraph appears once', (out.match(/<p>/g) || []).length === 1, out);
    check('the markup around them is intact', out.includes('<section>') && out.includes('</section>'), out);
    check('no markers were left', !out.includes('<<<<<<<') && !out.includes('|||||||'), out);
    check('the tree is clean', (await sh(directory, 'status', '--porcelain')) === '');
  }

  // --- A class added here, the words rewritten there ------------------------
  //
  // Both branches edited the SAME line, so git reports a genuine clash and any
  // line-level answer throws one of the two edits away. Inside the line they
  // are nowhere near each other, and both can be kept.
  {
    const directory = await repo('inline');
    cleanup.push(directory);
    fs.writeFileSync(path.join(directory, 'index.astro'), '<section>\n  <h2>Heading 2</h2>\n</section>\n');
    await sh(directory, 'add', '-A');
    await sh(directory, 'commit', '-qm', 'page');
    await sh(directory, 'checkout', '-qb', 'new-branch');
    fs.writeFileSync(path.join(directory, 'index.astro'), '<section>\n  <h2>Heading 3</h2>\n</section>\n');
    await sh(directory, 'add', '-A');
    await sh(directory, 'commit', '-qm', 'new words');
    await sh(directory, 'checkout', '-q', 'main');
    fs.writeFileSync(path.join(directory, 'index.astro'), '<section>\n  <h2 class="title">Heading 2</h2>\n</section>\n');
    await sh(directory, 'add', '-A');
    await sh(directory, 'commit', '-qm', 'a class');

    const clash = await mergeBranch(git, { projectPath: directory, branch: 'new-branch' });
    const clashPart = (clash.files[0].parts || []).find((part) => part.kind === 'clash');
    check('the same line edited twice is still one clash', !!clashPart, JSON.stringify(clash.files[0].parts));
    check('but a combined version is offered', clashPart.merged !== undefined, JSON.stringify(clashPart));
    check('holding both edits', clashPart.merged.includes('class="title"') && clashPart.merged.includes('Heading 3'), clashPart.merged);

    const done = await resolveMerge(git, {
      projectPath: directory,
      branch: 'new-branch',
      choices: { 'index.astro': ['merged'] },
    });
    check('the merge finishes', done.ok === true, JSON.stringify(done));
    const out = fs.readFileSync(path.join(directory, 'index.astro'), 'utf8');
    check('the class survived', out.includes('class="title"'), out);
    check('and the new words', out.includes('Heading 3'), out);
    check('the old words are gone', !out.includes('Heading 2'), out);
    check('the heading appears once', (out.match(/<h2/g) || []).length === 1, out);
    check('indentation is intact', /^  <h2/m.test(out), JSON.stringify(out));
    check('and the markup around it', out.includes('<section>') && out.includes('</section>'), out);
    check('no markers left', !out.includes('<<<<<<<') && !out.includes('|||||||'), out);
    check('the tree is clean', (await sh(directory, 'status', '--porcelain')) === '');
  }

  // --- A choice not given ---------------------------------------------------
  {
    const directory = await repo('resolvedefault');
    cleanup.push(directory);
    await sh(directory, 'checkout', '-qb', 'feature');
    fs.writeFileSync(path.join(directory, 'a.txt'), 'theirs\n');
    await sh(directory, 'add', '-A');
    await sh(directory, 'commit', '-qm', 'theirs');
    await sh(directory, 'checkout', '-q', 'main');
    fs.writeFileSync(path.join(directory, 'a.txt'), 'mine\n');
    await sh(directory, 'add', '-A');
    await sh(directory, 'commit', '-qm', 'mine');

    await mergeBranch(git, { projectPath: directory, branch: 'feature' });
    // No answer for this file. Between silently dropping your own work and
    // silently dropping work you asked to merge in, the first is worse: the
    // incoming version is still on its branch, yours may exist nowhere else.
    const done = await resolveMerge(git, {
      projectPath: directory,
      branch: 'feature',
      choices: {},
    });
    check('an unanswered file keeps your own version', done.ok === true, JSON.stringify(done));
    check(
      'rather than the incoming one',
      fs.readFileSync(path.join(directory, 'a.txt'), 'utf8').trim() === 'mine',
      fs.readFileSync(path.join(directory, 'a.txt'), 'utf8'),
    );
  }

  // --- A merge with unsaved work that is NOT in the way ---------------------
  //
  // This used to be refused. The app checked for any uncommitted change at all
  // and told you to commit first — but a merge only clashes with unsaved work
  // when it needs to write the SAME file, and most of the time it does not.
  // Being made to commit an unrelated page before merging is the same false
  // obstacle that used to sit in front of switching branches.
  {
    const directory = await repo('dirtyok');
    cleanup.push(directory);
    await sh(directory, 'checkout', '-qb', 'feature');
    await commitOn(directory, 'feature', 'b.txt', 'from feature\n');
    await sh(directory, 'checkout', '-q', 'main');
    // Unsaved work in a file the merge has no interest in.
    fs.writeFileSync(path.join(directory, 'a.txt'), 'work in progress\n');

    const result = await mergeBranch(git, { projectPath: directory, branch: 'feature' });
    check('the merge just happens', result.ok === true, JSON.stringify(result));
    check('the branch’s work arrives', fs.existsSync(path.join(directory, 'b.txt')));
    check(
      'and the unsaved work is untouched',
      fs.readFileSync(path.join(directory, 'a.txt'), 'utf8') === 'work in progress\n',
      fs.readFileSync(path.join(directory, 'a.txt'), 'utf8'),
    );
  }

  // --- A merge with unsaved work that IS in the way -------------------------
  {
    const directory = await repo('dirtyblocked');
    cleanup.push(directory);
    await sh(directory, 'checkout', '-qb', 'feature');
    await commitOn(directory, 'feature', 'a.txt', 'from feature\n');
    await sh(directory, 'checkout', '-q', 'main');
    fs.writeFileSync(path.join(directory, 'a.txt'), 'unsaved edit\n');

    const result = await mergeBranch(git, { projectPath: directory, branch: 'feature' });
    // A question — park it or commit it — not an error, and shaped like the
    // same question a blocked branch switch asks.
    check('a merge that needs that file stops', result.ok === false, JSON.stringify(result));
    check('and is flagged as work being in the way', result.dirty === true, JSON.stringify(result));
    check(
      'naming the file',
      (result.files || []).some((file) => file.includes('a.txt')),
      JSON.stringify(result.files),
    );
    check('the uncommitted work is untouched', fs.readFileSync(path.join(directory, 'a.txt'), 'utf8') === 'unsaved edit\n');
    check('and nothing was merged', (await sh(directory, 'log', '-1', '--format=%s')) !== 'a.txt on feature');
  }

  // --- Merging the branch you are on ---------------------------------------
  {
    const directory = await repo('self');
    cleanup.push(directory);
    const { error } = await caught(() => mergeBranch(git, { projectPath: directory, branch: 'main' }));
    check('merging a branch into itself is refused', !!error, error);
  }

  // --- Deleting a branch holding commits of its own ------------------------
  {
    const directory = await repo('unmerged');
    cleanup.push(directory);
    await sh(directory, 'checkout', '-qb', 'feature');
    await commitOn(directory, 'feature', 'b.txt', 'only here\n');
    await sh(directory, 'checkout', '-q', 'main');

    const result = await deleteBranch(git, { projectPath: directory, branch: 'feature' });
    // A question, not an error — it comes back as a value so the caller can
    // ask it rather than showing porcelain about `-D`.
    check('an unmerged branch is not deleted', result.ok === false, JSON.stringify(result));
    check('and it is flagged as the question it is', result.unmerged === true, JSON.stringify(result));
    check('the message says what is at stake', /commits/i.test(result.message || '') && /feature/.test(result.message || ''), result.message);
    check('the branch is still there', (await sh(directory, 'branch', '--format=%(refname:short)')).includes('feature'));

    const forced = await deleteBranch(git, {
      projectPath: directory,
      branch: 'feature',
      force: true,
    });
    check('forcing deletes it', forced.ok === true, JSON.stringify(forced));
    check('and it is gone', !(await sh(directory, 'branch', '--format=%(refname:short)')).includes('feature'));
  }

  // --- Tidying up after a merge ---------------------------------------------
  //
  // Once a branch is folded in it is usually finished, so the app offers to
  // delete it as part of the merge. That only holds up if a just-merged branch
  // deletes by the SAFE route — forcing would be the app deciding, on the
  // user's behalf, that whatever git objected to did not matter.
  {
    const directory = await repo('tidy');
    cleanup.push(directory);
    await sh(directory, 'checkout', '-qb', 'feature');
    await commitOn(directory, 'feature', 'b.txt', 'work\n');
    await sh(directory, 'checkout', '-q', 'main');

    const merged = await mergeBranch(git, { projectPath: directory, branch: 'feature' });
    check('the merge lands', merged.ok === true, JSON.stringify(merged));
    // No force: git is satisfied because the work is now on main.
    const gone = await deleteBranch(git, { projectPath: directory, branch: 'feature' });
    check('the branch deletes without forcing', gone.ok === true, JSON.stringify(gone));
    check('and is gone', !(await sh(directory, 'branch', '--format=%(refname:short)')).includes('feature'));
    check('while its work stayed', fs.existsSync(path.join(directory, 'b.txt')));
  }

  // --- Tidying up a branch that had nothing to give -------------------------
  {
    const directory = await repo('tidynoop');
    cleanup.push(directory);
    await sh(directory, 'branch', 'stale');
    const result = await mergeBranch(git, { projectPath: directory, branch: 'stale' });
    check('a merge with nothing to bring still succeeds', result.ok === true, JSON.stringify(result));
    check('and reports that nothing moved', result.changed === false, JSON.stringify(result));
    // Nothing moved, but the branch is still redundant, so deleting is right
    // and git allows it.
    const gone = await deleteBranch(git, { projectPath: directory, branch: 'stale' });
    check('the redundant branch still deletes cleanly', gone.ok === true, JSON.stringify(gone));
  }

  // --- Deleting the trunk ---------------------------------------------------
  //
  // Git will do this. `git branch -d main` succeeds the moment main is merged
  // into wherever you are standing — which, after any ordinary merge, it is.
  // Nothing warns you, and what is lost is the branch everything comes back
  // to. The button for it is hidden in the UI; this is the other half, so a
  // caller that forgets cannot do it either.
  {
    const directory = await repo('trunk');
    cleanup.push(directory);
    await sh(directory, 'checkout', '-qb', 'new-branch');
    await commitOn(directory, 'new-branch', 'b.txt', 'work\n');
    // Merged in, so git's own safety check would raise no objection at all.
    await sh(directory, 'checkout', '-q', 'main');
    await sh(directory, 'merge', '--no-edit', '-q', 'new-branch');
    await sh(directory, 'checkout', '-q', 'new-branch');

    const { error } = await caught(() => deleteBranch(git, { projectPath: directory, branch: 'main' }));
    check('the trunk is not deletable', !!error, error);
    check('and the refusal says why', /comes back to|main line/i.test(error || ''), error);
    check('main is still there', (await sh(directory, 'branch', '--format=%(refname:short)')).includes('main'));

    // An ordinary branch in the same repository is unaffected — the guard is
    // about the trunk, not about caution in general.
    await sh(directory, 'branch', 'scratch');
    const ok = await deleteBranch(git, { projectPath: directory, branch: 'scratch' });
    check('other branches still delete', ok.ok === true, JSON.stringify(ok));

    // And it can still be done deliberately, for a caller that means it.
    const forced = await deleteBranch(git, {
      projectPath: directory,
      branch: 'main',
      allowTrunk: true,
    });
    check('the trunk goes when explicitly allowed', forced.ok === true, JSON.stringify(forced));
  }

  // --- Deleting the branch you are on --------------------------------------
  {
    const directory = await repo('current');
    cleanup.push(directory);
    const { error } = await caught(() => deleteBranch(git, { projectPath: directory, branch: 'main' }));
    check('the current branch is not deletable', !!error, error);
    check('and the refusal says to switch first', /switch/i.test(error || ''), error);
  }

  // --- Deleting a branch checked out in another worktree --------------------
  {
    const directory = await repo('worktree');
    cleanup.push(directory);
    await sh(directory, 'branch', 'elsewhere');
    const wt = path.join(directory, '..', path.basename(directory) + '-wt');
    await sh(directory, 'worktree', 'add', '-q', wt, 'elsewhere');
    cleanup.push(wt);

    const { error } = await caught(() => deleteBranch(git, { projectPath: directory, branch: 'elsewhere' }));
    check('a branch held by another worktree is refused', !!error, error);
    // Git leads with a path nobody asked about; this should lead with the name.
    check('and the refusal says which worktree', /worktree/i.test(error || ''), error);
  }

  // --- Switching with work in progress -------------------------------------
  //
  // Even compatible edits belong to the original branch, so previews show
  // the destination's files rather than a mixture of two branches.
  {
    const directory = await repo('switch');
    cleanup.push(directory);
    fs.writeFileSync(path.join(directory, 'shared.txt'), 'same on both\n');
    await sh(directory, 'add', '-A');
    await sh(directory, 'commit', '-qm', 'shared');
    await sh(directory, 'branch', 'feature');

    fs.writeFileSync(path.join(directory, 'shared.txt'), 'work in progress\n');
    const result = await switchBranch(git, {
      projectPath: directory,
      branch: 'feature',
      ...parking(directory),
    });
    check('a switch with unsaved work just happens', result.ok === true, JSON.stringify(result));
    check('landing on the branch', (await sh(directory, 'rev-parse', '--abbrev-ref', 'HEAD')) === 'feature');
    check(
      'with only the destination version visible',
      fs.readFileSync(path.join(directory, 'shared.txt'), 'utf8') === 'same on both\n',
      fs.readFileSync(path.join(directory, 'shared.txt'), 'utf8'),
    );
    check('the edits were parked', result.parked === true, JSON.stringify(result));
    check('and nothing was committed', (await sh(directory, 'log', '-1', '--format=%s')) === 'shared');
  }

  // --- Switching when the work genuinely cannot come ------------------------
  {
    const directory = await repo('switchblocked');
    cleanup.push(directory);
    await sh(directory, 'checkout', '-qb', 'feature');
    fs.writeFileSync(path.join(directory, 'a.txt'), 'feature version\n');
    await sh(directory, 'add', '-A');
    await sh(directory, 'commit', '-qm', 'feature edit');
    await sh(directory, 'checkout', '-q', 'main');
    fs.writeFileSync(path.join(directory, 'a.txt'), 'unsaved work\n');

    const result = await switchBranch(git, {
      projectPath: directory,
      branch: 'feature',
      ...parking(directory),
    });
    check('overlapping edits are parked without requiring a commit', result.ok === true, JSON.stringify(result));
    check('the source edits were parked', result.parked === true, JSON.stringify(result));
    check('the destination is clean', (await sh(directory, 'status', '--porcelain')) === '');
    check('the branch switched', (await sh(directory, 'rev-parse', '--abbrev-ref', 'HEAD')) === 'feature');
    check('the destination content is visible', fs.readFileSync(path.join(directory, 'a.txt'), 'utf8') === 'feature version\n');
  }

  // --- Making a branch takes the work with it -------------------------------
  {
    const directory = await repo('switchcreate');
    cleanup.push(directory);
    fs.writeFileSync(path.join(directory, 'a.txt'), 'started something\n');

    const result = await switchBranch(git, {
      projectPath: directory,
      branch: 'idea',
      create: true,
      ...parking(directory),
    });
    check('a new branch is made', result.ok === true, JSON.stringify(result));
    check('and checked out', (await sh(directory, 'rev-parse', '--abbrev-ref', 'HEAD')) === 'idea');
    // Starting a branch from what is in front of you means taking it with you.
    check('with the work in progress on it', fs.readFileSync(path.join(directory, 'a.txt'), 'utf8') === 'started something\n');
  }

  for (const directory of cleanup) {
    fs.rmSync(directory, { recursive: true, force: true });
  }

  if (failures.length) {
    console.error(`git-branches: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`git-branches: ${checked} passed`);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
