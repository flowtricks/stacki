// The name a new branch is given.
//
//   node test/branch-name.js
//
// `git checkout -b` refuses names it doesn't like, and the refusal arrived in
// the app as a red box quoting git at the user — "fatal: 'my branch' is not a
// valid branch name" — with the name they typed already gone from the field.
// The rules are fixed and short, so the field keeps to them instead: characters
// git refuses never land in it, and the problems that are about the whole name
// are said before Enter does anything.
//
// Capitals are NOT one of the rules. Git takes them, so stripping them would be
// this app inventing a rule rather than enforcing one — but two names differing
// only in case are one file in .git/refs on macOS and Windows, and that clash
// is caught as the clash it is.

const fs = require('fs');
const path = require('path');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
};

(async () => {
  const esbuild = require('esbuild');
  const buildDir = path.join(__dirname, '..', 'node_modules', '.stacki-test');
  fs.mkdirSync(buildDir, { recursive: true });
  const bundlePath = path.join(buildDir, 'branch-name.bundle.js');
  await esbuild.build({
    entryPoints: [path.join(__dirname, '..', 'src', 'branchName.js')],
    outfile: bundlePath,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    logLevel: 'silent',
  });
  const { sanitizeBranchName: clean, branchNameError: why, isValidBranchName: ok } =
    require(bundlePath);

  // --- what typing can produce ------------------------------------------------
  check('a space becomes the separator it was meant as', clean('my new branch') === 'my-new-branch', clean('my new branch'));
  check('a tab too', clean('a\tb') === 'a-b', clean('a\tb'));
  check('git\'s own syntax characters are refused', clean('a~b^c:d?e*f[g\\h') === 'abcdefgh', clean('a~b^c:d?e*f[g\\h'));
  check('control codes are refused', clean('a\x07b\x7fc') === 'abc', JSON.stringify(clean('a\x07b\x7fc')));
  check('`..` is a range, not a name', clean('a..b') === 'a.b', clean('a..b'));
  check('`@{` is the reflog', clean('main@{1}') === 'main1}', clean('main@{1}'));
  check('an empty path component closes up', clean('a//b') === 'a/b', clean('a//b'));
  check('a name can\'t open with a dash', clean('-x') === 'x', clean('-x'));
  check('nor with a dot or a slash', clean('./x') === 'x', clean('./x'));

  // --- what typing is left alone to do ---------------------------------------
  check('capitals are git\'s to accept, and it does', clean('Feature/Login') === 'Feature/Login', clean('Feature/Login'));
  check('a slash is how branches are grouped', clean('feat/login-form') === 'feat/login-form');
  check('dots inside a name are fine', clean('release/v1.2.x') === 'release/v1.2.x');
  check('so are digits and underscores', clean('fix_123') === 'fix_123');

  // --- the shape of the whole name -------------------------------------------
  check('nothing typed is not an error', why('') === null && why('   ') === null);
  check('a plain name is not an error', why('feature/login') === null, why('feature/login'));
  check('`@` is git\'s own name for HEAD', !!why('@'));
  check('a trailing slash has no name after it', !!why('a/'));
  check('a trailing dot is refused by git', !!why('a.'));
  check('`.lock` is reserved', !!why('feature/login.lock'), why('feature/login.lock'));
  check('in any component of the name', !!why('a.lock/b'), why('a.lock/b'));

  // --- names already taken ----------------------------------------------------
  const existing = ['main', 'feature/login'];
  check('an existing name says so', /already exists/.test(why('main', existing) || ''), why('main', existing));
  check(
    'and one that differs only in case says why that counts',
    /same branch here/.test(why('Main', existing) || ''),
    why('Main', existing)
  );
  check('a free name is free', why('feature/logout', existing) === null);

  // --- the answer the field acts on -------------------------------------------
  check('valid is the absence of a reason', ok('feature/logout', existing) && !ok('main', existing));
  check('and an empty field is never valid', !ok('', existing) && !ok('   ', existing));

  // --- the field really asks ---------------------------------------------------
  const chip = fs.readFileSync(path.join(__dirname, '..', 'src', 'panels', 'GitChip.jsx'), 'utf8');
  check('the field cleans what is typed', /onChange=\{\(e\) => setNewBranch\(sanitizeBranchName\(/.test(chip));
  check('and Enter waits for a name that works', /e\.key === 'Enter' && newBranch\.trim\(\) && !branchError/.test(chip));
  check('with the reason shown while it waits', /branchError && <div className="git-hint">/.test(chip));
  check(
    'checked against the branches that exist',
    /branchNameError\(newBranch, info\.branches \|\| \[\]\)/.test(chip)
  );

  if (failures.length) {
    console.error(`\nbranch-name: ${failures.length} failed, ${checked - failures.length} passed\n`);
    console.error(failures.join('\n') + '\n');
    process.exit(1);
  }
  console.log(`branch-name: ${checked} passed`);
})();
