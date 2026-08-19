// Merging a branch and deleting one.
//
//   node test/git-branches.js
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
const { mergeBranch, deleteBranch, switchBranch, resolveMerge } = require('../electron/gitBranches.js');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
};

// The runner the module takes, without main.js's PATH repair — nothing here
// runs from a packaged app.
const git = (cwd, args) =>
  new Promise((resolve, reject) => {
    execFile('git', args, { cwd }, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
      } else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });

const sh = async (cwd, ...args) => (await git(cwd, args)).stdout.trim();

// A repository on `main` with one commit, and a `feature` branch off it.
async function repo(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `stacki-git-${name}-`));
  await sh(dir, 'init', '-q', '-b', 'main', '.');
  await sh(dir, 'config', 'user.email', 'test@example.com');
  await sh(dir, 'config', 'user.name', 'Test');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'base\n');
  await sh(dir, 'add', '-A');
  await sh(dir, 'commit', '-qm', 'first');
  return dir;
}

const commitOn = async (dir, branch, file, body) => {
  await sh(dir, 'checkout', '-q', branch);
  fs.writeFileSync(path.join(dir, file), body);
  await sh(dir, 'add', '-A');
  await sh(dir, 'commit', '-qm', `${file} on ${branch}`);
};

const caught = async (fn) => {
  try {
    return { value: await fn(), error: null };
  } catch (err) {
    return { value: null, error: String(err.message || err) };
  }
};

(async () => {
  const cleanup = [];

  // --- A merge that has somewhere to go ------------------------------------
  {
    const dir = await repo('ff');
    cleanup.push(dir);
    await sh(dir, 'checkout', '-qb', 'feature');
    await commitOn(dir, 'feature', 'b.txt', 'from feature\n');
    await sh(dir, 'checkout', '-q', 'main');

    const r = await mergeBranch(git, { projectPath: dir, branch: 'feature' });
    check('a merge that moves work reports it', r.changed === true, JSON.stringify(r));
    check('the merge names the branch merged into', r.into === 'main', r.into);
    check(
      'the merged file is on the branch afterwards',
      fs.existsSync(path.join(dir, 'b.txt'))
    );

    // Once merged, git's safe delete is willing.
    const d = await deleteBranch(git, { projectPath: dir, branch: 'feature' });
    check('a merged branch deletes without forcing', d.ok === true, JSON.stringify(d));
    const left = await sh(dir, 'branch', '--format=%(refname:short)');
    check('and is gone from the list', left === 'main', left);
  }

  // --- A merge with nothing to bring ---------------------------------------
  {
    const dir = await repo('noop');
    cleanup.push(dir);
    await sh(dir, 'branch', 'behind');
    const r = await mergeBranch(git, { projectPath: dir, branch: 'behind' });
    // "Merged" here would claim work arrived that was already present. The
    // caller says something different on the strength of this flag.
    check('a merge that moves nothing says so', r.changed === false, JSON.stringify(r));
  }

  // --- A merge that conflicts ----------------------------------------------
  {
    const dir = await repo('conflict');
    cleanup.push(dir);
    await sh(dir, 'checkout', '-qb', 'feature');
    await commitOn(dir, 'feature', 'a.txt', 'feature wins\n');
    await commitOn(dir, 'main', 'a.txt', 'main wins\n');

    const head = await sh(dir, 'rev-parse', 'HEAD');
    const r = await mergeBranch(git, { projectPath: dir, branch: 'feature' });

    // A question, not a failure. It used to throw an error naming a terminal
    // command, which in an app built so nobody needs a terminal was a refusal
    // wearing an explanation.
    check('a clash comes back as something to answer', r.ok === false, JSON.stringify(r));
    check('flagged as a clash', r.conflicted === true, JSON.stringify(r));
    check('naming the file', r.files?.[0]?.path === 'a.txt', JSON.stringify(r.files));
    check('and both branches', r.from === 'main' && r.branch === 'feature', JSON.stringify(r));
    // Both versions come back, because "yours or theirs" cannot be answered
    // from two labels — the person deciding has to see what is in them.
    check('with this branch’s version', r.files[0].ours.trim() === 'main wins', r.files[0].ours);
    check('and the incoming one', r.files[0].theirs.trim() === 'feature wins', r.files[0].theirs);

    // The tree, not the message: this is what keeps the editor from parsing
    // conflict markers as markup while the user is deciding.
    const status = await sh(dir, 'status', '--porcelain');
    check('nothing is left conflicted in the tree', status === '', status);
    check('the branch is where it was', (await sh(dir, 'rev-parse', 'HEAD')) === head);
    check(
      'no conflict markers were left in the file',
      !fs.readFileSync(path.join(dir, 'a.txt'), 'utf8').includes('<<<<<<<')
    );
    check(
      'and the file still says what the branch said',
      fs.readFileSync(path.join(dir, 'a.txt'), 'utf8').trim() === 'main wins'
    );
  }

  // --- Answering the clash, in the app -------------------------------------
  {
    const dir = await repo('resolve');
    cleanup.push(dir);
    fs.writeFileSync(path.join(dir, 'b.txt'), 'base\n');
    await sh(dir, 'add', '-A');
    await sh(dir, 'commit', '-qm', 'two files');
    await sh(dir, 'checkout', '-qb', 'feature');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'feature a\n');
    fs.writeFileSync(path.join(dir, 'b.txt'), 'feature b\n');
    await sh(dir, 'add', '-A');
    await sh(dir, 'commit', '-qm', 'feature both');
    await sh(dir, 'checkout', '-q', 'main');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'main a\n');
    fs.writeFileSync(path.join(dir, 'b.txt'), 'main b\n');
    await sh(dir, 'add', '-A');
    await sh(dir, 'commit', '-qm', 'main both');

    const clash = await mergeBranch(git, { projectPath: dir, branch: 'feature' });
    check('both clashing files come back', clash.files.length === 2, JSON.stringify(clash.files.map((f) => f.path)));

    // One decision per file — a merge taking the page from one branch and the
    // stylesheet from the other is completely ordinary.
    const done = await resolveMerge(git, {
      projectPath: dir,
      branch: 'feature',
      choices: { 'a.txt': 'ours', 'b.txt': 'theirs' },
    });
    check('the merge finishes', done.ok === true, JSON.stringify(done));
    check('keeping mine where I said', fs.readFileSync(path.join(dir, 'a.txt'), 'utf8').trim() === 'main a');
    check('and theirs where I said', fs.readFileSync(path.join(dir, 'b.txt'), 'utf8').trim() === 'feature b');
    // A real merge commit, so the branch counts as merged afterwards and the
    // safe delete will allow itself.
    check('it is a real merge commit', (await sh(dir, 'log', '-1', '--format=%P')).split(' ').length === 2);
    check('the tree is clean', (await sh(dir, 'status', '--porcelain')) === '');
    check(
      'and no markers survived',
      !fs.readFileSync(path.join(dir, 'a.txt'), 'utf8').includes('<<<<<<<') &&
        !fs.readFileSync(path.join(dir, 'b.txt'), 'utf8').includes('<<<<<<<')
    );
    const d = await deleteBranch(git, { projectPath: dir, branch: 'feature' });
    check('and the branch now deletes as merged', d.ok === true, JSON.stringify(d));
  }

  // --- Taking part of a file from each branch -------------------------------
  //
  // The whole reason conflicts are shown as separate differences rather than
  // one all-or-nothing switch: a page whose heading came from one branch and
  // whose footer came from the other is completely ordinary.
  {
    const dir = await repo('hunks');
    cleanup.push(dir);
    const page = (hero, footer) =>
      [hero, ...Array.from({ length: 6 }, (_, i) => `unchanged ${i}`), footer].join('\n') + '\n';
    fs.writeFileSync(path.join(dir, 'p.astro'), page('HERO', 'FOOTER'));
    await sh(dir, 'add', '-A');
    await sh(dir, 'commit', '-qm', 'page');
    await sh(dir, 'checkout', '-qb', 'feature');
    fs.writeFileSync(path.join(dir, 'p.astro'), page('HERO FEATURE', 'FOOTER FEATURE'));
    await sh(dir, 'add', '-A');
    await sh(dir, 'commit', '-qm', 'feature page');
    await sh(dir, 'checkout', '-q', 'main');
    fs.writeFileSync(path.join(dir, 'p.astro'), page('HERO MAIN', 'FOOTER MAIN'));
    await sh(dir, 'add', '-A');
    await sh(dir, 'commit', '-qm', 'main page');

    const clash = await mergeBranch(git, { projectPath: dir, branch: 'feature' });
    const file = clash.files.find((f) => f.path === 'p.astro');
    const clashes = (file.parts || []).filter((p) => p.kind === 'clash');
    // Two edits far enough apart that git reports them separately. If they
    // came back as one, there would be nothing to choose between per-part.
    check('the two edits come back separately', clashes.length === 2, JSON.stringify(clashes));
    check('the heading is one of them', clashes[0].ours.trim() === 'HERO MAIN', clashes[0].ours);
    check('and the footer the other', clashes[1].theirs.trim() === 'FOOTER FEATURE', clashes[1].theirs);

    // Heading from the incoming branch, footer from this one.
    const done = await resolveMerge(git, {
      projectPath: dir,
      branch: 'feature',
      choices: { 'p.astro': ['theirs', 'ours'] },
    });
    check('a mixed merge finishes', done.ok === true, JSON.stringify(done));
    const out = fs.readFileSync(path.join(dir, 'p.astro'), 'utf8');
    check('the heading came from the other branch', out.includes('HERO FEATURE'), out);
    check('the footer stayed on this one', out.includes('FOOTER MAIN'), out);
    check('and the versions not chosen are gone', !out.includes('HERO MAIN') && !out.includes('FOOTER FEATURE'), out);
    // The lines both branches agreed on are not part of the choice and must
    // survive untouched — losing one would be silent and permanent.
    check(
      'every agreed line survived',
      Array.from({ length: 6 }, (_, i) => `unchanged ${i}`).every((l) => out.includes(l)),
      out
    );
    check('no markers were left behind', !out.includes('<<<<<<<') && !out.includes('======='), out);
    check('the tree is clean', (await sh(dir, 'status', '--porcelain')) === '');
    check('and it is a real merge commit', (await sh(dir, 'log', '-1', '--format=%P')).split(' ').length === 2);
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
    const dir = await repo('adjacent');
    cleanup.push(dir);
    const page = (h, p2) => `<section>\n  <h2>${h}</h2>\n  <p>${p2}</p>\n</section>\n`;
    fs.writeFileSync(path.join(dir, 'index.astro'), page('Heading 2', 'original paragraph'));
    await sh(dir, 'add', '-A');
    await sh(dir, 'commit', '-qm', 'page');
    await sh(dir, 'checkout', '-qb', 'new-branch');
    // Only the heading here.
    fs.writeFileSync(path.join(dir, 'index.astro'), page('Heading 3', 'original paragraph'));
    await sh(dir, 'add', '-A');
    await sh(dir, 'commit', '-qm', 'new heading');
    await sh(dir, 'checkout', '-q', 'main');
    // Only the paragraph here.
    fs.writeFileSync(path.join(dir, 'index.astro'), page('Heading 2', 'rewritten paragraph'));
    await sh(dir, 'add', '-A');
    await sh(dir, 'commit', '-qm', 'new paragraph');

    const clash = await mergeBranch(git, { projectPath: dir, branch: 'new-branch' });
    const file = clash.files.find((f) => f.path === 'index.astro');
    const clashes = (file.parts || []).filter((p) => p.kind === 'clash');
    check('the one conflict is split into two decisions', clashes.length === 2, JSON.stringify(clashes));
    check('the heading credited to the branch that changed it', clashes[0].changedBy === 'theirs', JSON.stringify(clashes[0]));
    check('the paragraph to the other one', clashes[1].changedBy === 'ours', JSON.stringify(clashes[1]));
    // Neither is a real disagreement, so neither needs asking about.
    check('neither is contested', !clashes.some((c) => c.changedBy === 'both'), JSON.stringify(clashes));

    // What the dialog defaults to: whoever actually made each change.
    const picks = clashes.map((c) => (c.changedBy === 'theirs' ? 'theirs' : 'ours'));
    const done = await resolveMerge(git, {
      projectPath: dir,
      branch: 'new-branch',
      choices: { 'index.astro': picks },
    });
    check('the merge finishes', done.ok === true, JSON.stringify(done));

    const out = fs.readFileSync(path.join(dir, 'index.astro'), 'utf8');
    check('the new heading survived', out.includes('Heading 3'), out);
    check('and the rewritten paragraph', out.includes('rewritten paragraph'), out);
    check('the superseded heading is gone', !out.includes('Heading 2'), out);
    check('the superseded paragraph is gone', !out.includes('original paragraph'), out);
    // Nothing duplicated — the failure "both" would have produced.
    check('the heading appears once', (out.match(/<h2>/g) || []).length === 1, out);
    check('the paragraph appears once', (out.match(/<p>/g) || []).length === 1, out);
    check('the markup around them is intact', out.includes('<section>') && out.includes('</section>'), out);
    check('no markers were left', !out.includes('<<<<<<<') && !out.includes('|||||||'), out);
    check('the tree is clean', (await sh(dir, 'status', '--porcelain')) === '');
  }

  // --- A class added here, the words rewritten there ------------------------
  //
  // Both branches edited the SAME line, so git reports a genuine clash and any
  // line-level answer throws one of the two edits away. Inside the line they
  // are nowhere near each other, and both can be kept.
  {
    const dir = await repo('inline');
    cleanup.push(dir);
    fs.writeFileSync(path.join(dir, 'index.astro'), '<section>\n  <h2>Heading 2</h2>\n</section>\n');
    await sh(dir, 'add', '-A');
    await sh(dir, 'commit', '-qm', 'page');
    await sh(dir, 'checkout', '-qb', 'new-branch');
    fs.writeFileSync(path.join(dir, 'index.astro'), '<section>\n  <h2>Heading 3</h2>\n</section>\n');
    await sh(dir, 'add', '-A');
    await sh(dir, 'commit', '-qm', 'new words');
    await sh(dir, 'checkout', '-q', 'main');
    fs.writeFileSync(path.join(dir, 'index.astro'), '<section>\n  <h2 class="title">Heading 2</h2>\n</section>\n');
    await sh(dir, 'add', '-A');
    await sh(dir, 'commit', '-qm', 'a class');

    const clash = await mergeBranch(git, { projectPath: dir, branch: 'new-branch' });
    const c = (clash.files[0].parts || []).find((p) => p.kind === 'clash');
    check('the same line edited twice is still one clash', !!c, JSON.stringify(clash.files[0].parts));
    check('but a combined version is offered', c.merged != null, JSON.stringify(c));
    check('holding both edits', c.merged.includes('class="title"') && c.merged.includes('Heading 3'), c.merged);

    const done = await resolveMerge(git, {
      projectPath: dir,
      branch: 'new-branch',
      choices: { 'index.astro': ['merged'] },
    });
    check('the merge finishes', done.ok === true, JSON.stringify(done));
    const out = fs.readFileSync(path.join(dir, 'index.astro'), 'utf8');
    check('the class survived', out.includes('class="title"'), out);
    check('and the new words', out.includes('Heading 3'), out);
    check('the old words are gone', !out.includes('Heading 2'), out);
    check('the heading appears once', (out.match(/<h2/g) || []).length === 1, out);
    check('indentation is intact', /^  <h2/m.test(out), JSON.stringify(out));
    check('and the markup around it', out.includes('<section>') && out.includes('</section>'), out);
    check('no markers left', !out.includes('<<<<<<<') && !out.includes('|||||||'), out);
    check('the tree is clean', (await sh(dir, 'status', '--porcelain')) === '');
  }

  // --- A choice not given ---------------------------------------------------
  {
    const dir = await repo('resolvedefault');
    cleanup.push(dir);
    await sh(dir, 'checkout', '-qb', 'feature');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'theirs\n');
    await sh(dir, 'add', '-A');
    await sh(dir, 'commit', '-qm', 'theirs');
    await sh(dir, 'checkout', '-q', 'main');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'mine\n');
    await sh(dir, 'add', '-A');
    await sh(dir, 'commit', '-qm', 'mine');

    await mergeBranch(git, { projectPath: dir, branch: 'feature' });
    // No answer for this file. Between silently dropping your own work and
    // silently dropping work you asked to merge in, the first is worse: the
    // incoming version is still on its branch, yours may exist nowhere else.
    const done = await resolveMerge(git, { projectPath: dir, branch: 'feature', choices: {} });
    check('an unanswered file keeps your own version', done.ok === true, JSON.stringify(done));
    check(
      'rather than the incoming one',
      fs.readFileSync(path.join(dir, 'a.txt'), 'utf8').trim() === 'mine',
      fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')
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
    const dir = await repo('dirtyok');
    cleanup.push(dir);
    await sh(dir, 'checkout', '-qb', 'feature');
    await commitOn(dir, 'feature', 'b.txt', 'from feature\n');
    await sh(dir, 'checkout', '-q', 'main');
    // Unsaved work in a file the merge has no interest in.
    fs.writeFileSync(path.join(dir, 'a.txt'), 'work in progress\n');

    const r = await mergeBranch(git, { projectPath: dir, branch: 'feature' });
    check('the merge just happens', r.ok === true, JSON.stringify(r));
    check('the branch’s work arrives', fs.existsSync(path.join(dir, 'b.txt')));
    check(
      'and the unsaved work is untouched',
      fs.readFileSync(path.join(dir, 'a.txt'), 'utf8') === 'work in progress\n',
      fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')
    );
  }

  // --- A merge with unsaved work that IS in the way -------------------------
  {
    const dir = await repo('dirtyblocked');
    cleanup.push(dir);
    await sh(dir, 'checkout', '-qb', 'feature');
    await commitOn(dir, 'feature', 'a.txt', 'from feature\n');
    await sh(dir, 'checkout', '-q', 'main');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'unsaved edit\n');

    const r = await mergeBranch(git, { projectPath: dir, branch: 'feature' });
    // A question — park it or commit it — not an error, and shaped like the
    // same question a blocked branch switch asks.
    check('a merge that needs that file stops', r.ok === false, JSON.stringify(r));
    check('and is flagged as work being in the way', r.dirty === true, JSON.stringify(r));
    check('naming the file', (r.files || []).some((f) => f.includes('a.txt')), JSON.stringify(r.files));
    check(
      'the uncommitted work is untouched',
      fs.readFileSync(path.join(dir, 'a.txt'), 'utf8') === 'unsaved edit\n'
    );
    check('and nothing was merged', (await sh(dir, 'log', '-1', '--format=%s')) !== 'a.txt on feature');
  }

  // --- Merging the branch you are on ---------------------------------------
  {
    const dir = await repo('self');
    cleanup.push(dir);
    const { error } = await caught(() => mergeBranch(git, { projectPath: dir, branch: 'main' }));
    check('merging a branch into itself is refused', !!error, error);
  }

  // --- Deleting a branch holding commits of its own ------------------------
  {
    const dir = await repo('unmerged');
    cleanup.push(dir);
    await sh(dir, 'checkout', '-qb', 'feature');
    await commitOn(dir, 'feature', 'b.txt', 'only here\n');
    await sh(dir, 'checkout', '-q', 'main');

    const r = await deleteBranch(git, { projectPath: dir, branch: 'feature' });
    // A question, not an error — it comes back as a value so the caller can
    // ask it rather than showing porcelain about `-D`.
    check('an unmerged branch is not deleted', r.ok === false, JSON.stringify(r));
    check('and it is flagged as the question it is', r.unmerged === true, JSON.stringify(r));
    check(
      'the message says what is at stake',
      /commits/i.test(r.message || '') && /feature/.test(r.message || ''),
      r.message
    );
    check(
      'the branch is still there',
      (await sh(dir, 'branch', '--format=%(refname:short)')).includes('feature')
    );

    const forced = await deleteBranch(git, { projectPath: dir, branch: 'feature', force: true });
    check('forcing deletes it', forced.ok === true, JSON.stringify(forced));
    check(
      'and it is gone',
      !(await sh(dir, 'branch', '--format=%(refname:short)')).includes('feature')
    );
  }

  // --- Tidying up after a merge ---------------------------------------------
  //
  // Once a branch is folded in it is usually finished, so the app offers to
  // delete it as part of the merge. That only holds up if a just-merged branch
  // deletes by the SAFE route — forcing would be the app deciding, on the
  // user's behalf, that whatever git objected to did not matter.
  {
    const dir = await repo('tidy');
    cleanup.push(dir);
    await sh(dir, 'checkout', '-qb', 'feature');
    await commitOn(dir, 'feature', 'b.txt', 'work\n');
    await sh(dir, 'checkout', '-q', 'main');

    const merged = await mergeBranch(git, { projectPath: dir, branch: 'feature' });
    check('the merge lands', merged.ok === true, JSON.stringify(merged));
    // No force: git is satisfied because the work is now on main.
    const gone = await deleteBranch(git, { projectPath: dir, branch: 'feature' });
    check('the branch deletes without forcing', gone.ok === true, JSON.stringify(gone));
    check('and is gone', !(await sh(dir, 'branch', '--format=%(refname:short)')).includes('feature'));
    check('while its work stayed', fs.existsSync(path.join(dir, 'b.txt')));
  }

  // --- Tidying up a branch that had nothing to give -------------------------
  {
    const dir = await repo('tidynoop');
    cleanup.push(dir);
    await sh(dir, 'branch', 'stale');
    const r = await mergeBranch(git, { projectPath: dir, branch: 'stale' });
    check('a merge with nothing to bring still succeeds', r.ok === true, JSON.stringify(r));
    check('and reports that nothing moved', r.changed === false, JSON.stringify(r));
    // Nothing moved, but the branch is still redundant, so deleting is right
    // and git allows it.
    const gone = await deleteBranch(git, { projectPath: dir, branch: 'stale' });
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
    const dir = await repo('trunk');
    cleanup.push(dir);
    await sh(dir, 'checkout', '-qb', 'new-branch');
    await commitOn(dir, 'new-branch', 'b.txt', 'work\n');
    // Merged in, so git's own safety check would raise no objection at all.
    await sh(dir, 'checkout', '-q', 'main');
    await sh(dir, 'merge', '--no-edit', '-q', 'new-branch');
    await sh(dir, 'checkout', '-q', 'new-branch');

    const { error } = await caught(() => deleteBranch(git, { projectPath: dir, branch: 'main' }));
    check('the trunk is not deletable', !!error, error);
    check('and the refusal says why', /comes back to|main line/i.test(error || ''), error);
    check(
      'main is still there',
      (await sh(dir, 'branch', '--format=%(refname:short)')).includes('main')
    );

    // An ordinary branch in the same repository is unaffected — the guard is
    // about the trunk, not about caution in general.
    await sh(dir, 'branch', 'scratch');
    const ok = await deleteBranch(git, { projectPath: dir, branch: 'scratch' });
    check('other branches still delete', ok.ok === true, JSON.stringify(ok));

    // And it can still be done deliberately, for a caller that means it.
    const forced = await deleteBranch(git, { projectPath: dir, branch: 'main', allowTrunk: true });
    check('the trunk goes when explicitly allowed', forced.ok === true, JSON.stringify(forced));
  }

  // --- Deleting the branch you are on --------------------------------------
  {
    const dir = await repo('current');
    cleanup.push(dir);
    const { error } = await caught(() => deleteBranch(git, { projectPath: dir, branch: 'main' }));
    check('the current branch is not deletable', !!error, error);
    check('and the refusal says to switch first', /switch/i.test(error || ''), error);
  }

  // --- Deleting a branch checked out in another worktree --------------------
  {
    const dir = await repo('worktree');
    cleanup.push(dir);
    await sh(dir, 'branch', 'elsewhere');
    const wt = path.join(dir, '..', path.basename(dir) + '-wt');
    await sh(dir, 'worktree', 'add', '-q', wt, 'elsewhere');
    cleanup.push(wt);

    const { error } = await caught(() =>
      deleteBranch(git, { projectPath: dir, branch: 'elsewhere' })
    );
    check('a branch held by another worktree is refused', !!error, error);
    // Git leads with a path nobody asked about; this should lead with the name.
    check('and the refusal says which worktree', /worktree/i.test(error || ''), error);
  }

  // --- Switching with work in progress -------------------------------------
  //
  // What every other editor does, and what this used to get wrong: it asked
  // what to do with uncommitted changes BEFORE trying, so the ordinary case —
  // a file that is the same on both branches — became a dialog about a problem
  // that was never going to happen.
  {
    const dir = await repo('switch');
    cleanup.push(dir);
    fs.writeFileSync(path.join(dir, 'shared.txt'), 'same on both\n');
    await sh(dir, 'add', '-A');
    await sh(dir, 'commit', '-qm', 'shared');
    await sh(dir, 'branch', 'feature');

    fs.writeFileSync(path.join(dir, 'shared.txt'), 'work in progress\n');
    const r = await switchBranch(git, { projectPath: dir, branch: 'feature' });
    check('a switch with unsaved work just happens', r.ok === true, JSON.stringify(r));
    check('landing on the branch', (await sh(dir, 'rev-parse', '--abbrev-ref', 'HEAD')) === 'feature');
    check(
      'with the work carried across',
      fs.readFileSync(path.join(dir, 'shared.txt'), 'utf8') === 'work in progress\n',
      fs.readFileSync(path.join(dir, 'shared.txt'), 'utf8')
    );
    check('nothing was parked', r.parked === false, JSON.stringify(r));
    check('and nothing was committed', (await sh(dir, 'log', '-1', '--format=%s')) === 'shared');
  }

  // --- Switching when the work genuinely cannot come ------------------------
  {
    const dir = await repo('switchblocked');
    cleanup.push(dir);
    await sh(dir, 'checkout', '-qb', 'feature');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'feature version\n');
    await sh(dir, 'add', '-A');
    await sh(dir, 'commit', '-qm', 'feature edit');
    await sh(dir, 'checkout', '-q', 'main');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'unsaved work\n');

    const r = await switchBranch(git, { projectPath: dir, branch: 'feature' });
    // A question, not an error — returned with the files git named so the UI
    // can ask about those rather than about "uncommitted changes" in general.
    check('a switch that would destroy work is refused', r.ok === false, JSON.stringify(r));
    check('and flagged as the question it is', r.blocked === true, JSON.stringify(r));
    check('naming the file in the way', (r.files || []).includes('a.txt'), JSON.stringify(r.files));
    // HEAD must not move: an editor that believes it switched when it did not
    // writes every later edit onto the wrong branch.
    check('you are still where you were', (await sh(dir, 'rev-parse', '--abbrev-ref', 'HEAD')) === 'main');
    check(
      'and the work is untouched',
      fs.readFileSync(path.join(dir, 'a.txt'), 'utf8') === 'unsaved work\n'
    );
  }

  // --- Making a branch takes the work with it -------------------------------
  {
    const dir = await repo('switchcreate');
    cleanup.push(dir);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'started something\n');

    const r = await switchBranch(git, { projectPath: dir, branch: 'idea', create: true });
    check('a new branch is made', r.ok === true, JSON.stringify(r));
    check('and checked out', (await sh(dir, 'rev-parse', '--abbrev-ref', 'HEAD')) === 'idea');
    // Starting a branch from what is in front of you means taking it with you.
    check(
      'with the work in progress on it',
      fs.readFileSync(path.join(dir, 'a.txt'), 'utf8') === 'started something\n'
    );
  }

  for (const dir of cleanup) fs.rmSync(dir, { recursive: true, force: true });

  if (failures.length) {
    console.error(`git-branches: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`git-branches: ${checked} passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
