// Starting a site from a starter.
//
//   node test/starter.js
//
// The files come from the framework's own scaffolder — `npm create
// lumos@latest my-site` — so what is checked here is the command it is run
// with, and what is true of the folder afterwards: the site's name on the
// package, and a history that is the user's rather than the framework's.
// Keeping the starter's history would put somebody else's commits under their
// first one and leave a remote pointing at a repository they cannot push to,
// which is the remote "publish to GitHub" would then find and refuse.
//
// npm here is a script rather than npm: this is about the command and the
// folder, and a test that downloads a scaffolder is a test that fails when
// somebody else's server does.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { createStarter, STARTERS } = require('../electron/starter.js');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
};

const git = (cwd, args) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });

// A stand-in for `npm`: writes down the arguments it was given, then scaffolds
// what the real one would leave behind — under the starter's own name, since
// naming the site after its folder is the app's promise to keep.
const fakeNpm = (root, name, body) => {
  const file = path.join(root, name);
  fs.writeFileSync(
    file,
    `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
fs.appendFileSync(${JSON.stringify(path.join(root, 'calls.txt'))}, process.argv.slice(2).join(' ') + '\\n');
const dir = path.join(process.cwd(), process.argv[4]);
${body}
`,
    { mode: 0o755 }
  );
  return file;
};

const SCAFFOLD = `
fs.mkdirSync(path.join(dir, 'src', 'pages'), { recursive: true });
fs.writeFileSync(
  path.join(dir, 'package.json'),
  JSON.stringify({ name: 'lumos-for-astro', version: '0.0.1', dependencies: { astro: '^7.1.4' } }, null, 2)
);
fs.writeFileSync(path.join(dir, 'src', 'pages', 'index.astro'), '<h1>Hi</h1>\\n');
fs.writeFileSync(path.join(dir, 'astro.config.mjs'), 'export default {}\\n');
console.log('Ready.');
`;

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-starter-'));
  const npm = fakeNpm(root, 'npm-ok', SCAFFOLD);
  const calls = () => fs.readFileSync(path.join(root, 'calls.txt'), 'utf8').trim().split('\n');

  const parent = path.join(root, 'sites');
  fs.mkdirSync(parent);

  // --- the starter this app ships with ---------------------------------------
  check('Lumos is a starter', !!STARTERS.lumos);
  check(
    'started with the framework\'s own scaffolder',
    STARTERS.lumos.create === 'lumos@latest',
    STARTERS.lumos.create
  );

  // --- a site ----------------------------------------------------------------
  const log = [];
  const result = await createStarter({
    npm,
    parentPath: parent,
    name: 'my-site',
    onLog: (text) => log.push(text),
  });
  const dir = path.join(parent, 'my-site');
  check('the site lands in the folder it was named for', result.projectPath === dir, result.projectPath);
  check('with the starter in it', fs.existsSync(path.join(dir, 'src', 'pages', 'index.astro')));
  check('and its config', fs.existsSync(path.join(dir, 'astro.config.mjs')));

  // The command, as the framework documents it.
  check(
    'it runs npm create lumos@latest, in the chosen folder, under the chosen name',
    calls()[0] === 'create lumos@latest my-site --yes -- --no-install',
    calls()[0]
  );
  check('the log says what it ran', log.join('').includes('> npm create lumos@latest my-site'), log.join(''));
  check('and shows what it said', log.join('').includes('Ready.'), log.join(''));

  // The package is the site now.
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  check('the package takes the site name', pkg.name === 'my-site', pkg.name);
  check('and keeps everything else', pkg.dependencies?.astro === '^7.1.4');

  // The history is theirs.
  check('it is a git repository', fs.existsSync(path.join(dir, '.git')));
  const commits = git(dir, ['rev-list', '--count', 'HEAD']).trim();
  check('starting at one commit', commits === '1', `${commits} commits`);
  check(
    'named after what it started from',
    /Start my-site from Lumos/.test(git(dir, ['log', '-1', '--pretty=%s'])),
    git(dir, ['log', '-1', '--pretty=%s']).trim()
  );
  let remotes = '';
  try {
    remotes = git(dir, ['remote']).trim();
  } catch {
    remotes = '';
  }
  check('and no remote pointing at the starter', remotes === '', remotes);

  // --- what it refuses -------------------------------------------------------
  const refuses = async (options) => {
    try {
      await createStarter({ npm, parentPath: parent, ...options });
      return '';
    } catch (err) {
      return err.message;
    }
  };
  check('a folder that exists is refused', !!(await refuses({ name: 'my-site' })));
  check(
    'and says so plainly',
    /already exists/.test(await refuses({ name: 'my-site' })),
    await refuses({ name: 'my-site' })
  );
  check('an empty name is refused', /Give the site a name/.test(await refuses({ name: '  ' })));
  check(
    'a name that is not a folder name is refused',
    /letters, numbers/.test(await refuses({ name: 'my site/../etc' })),
    await refuses({ name: 'my site/../etc' })
  );
  check(
    'a starter nobody has heard of is refused',
    /not a starter/.test(await refuses({ starter: 'nope', name: 'x' }))
  );
  check(
    'and so is a folder that is not there',
    /Choose where/.test(await refuses({ parentPath: path.join(root, 'nowhere'), name: 'x' }))
  );
  check(
    'a refused name never reaches the command line',
    calls().length === 1,
    calls().join(' | ')
  );

  // A scaffolder that fails is a site that was not made, said out loud.
  {
    const broken = fakeNpm(root, 'npm-fails', `console.error('E404 not found'); process.exit(1);`);
    let message = '';
    try {
      await createStarter({ npm: broken, parentPath: parent, name: 'doomed' });
    } catch (err) {
      message = err.message;
    }
    check('a scaffolder that fails fails the site', !!message, 'it returned as though it worked');
    check('with what it printed', /E404 not found/.test(message), message);
  }

  // A scaffolder with no npm behind it says so in the terms the user can act on.
  {
    let message = '';
    try {
      await createStarter({ npm: path.join(root, 'nowhere', 'npm'), parentPath: parent, name: 'nonpm' });
    } catch (err) {
      message = err.message;
    }
    check(
      'a missing npm is said in terms of what to install',
      /npm could not be found\. Install Node\.js/.test(message),
      message
    );
  }

  // A scaffolder that starts a history of its own keeps it: its first commit is
  // already the site's, and a second one over the top says nothing.
  {
    const withGit = fakeNpm(
      root,
      'npm-git',
      `${SCAFFOLD}
const { execFileSync } = require('child_process');
const g = (...a) => execFileSync('git', a, { cwd: dir });
g('init', '-b', 'main');
g('add', '-A');
g('-c', 'user.email=t@t', '-c', 'user.name=T', 'commit', '-m', 'Initial commit from the scaffolder');
`
    );
    const own = await createStarter({ npm: withGit, parentPath: parent, name: 'has-history' });
    check(
      "the scaffolder's own first commit is left alone",
      /Initial commit from the scaffolder/.test(git(own.projectPath, ['log', '-1', '--pretty=%s'])),
      git(own.projectPath, ['log', '-1', '--pretty=%s']).trim()
    );
    check(
      'and is still the only one',
      git(own.projectPath, ['rev-list', '--count', 'HEAD']).trim() === '1'
    );
  }

  // A second site from the same starter is a second site, not a conflict.
  const second = await createStarter({ npm, parentPath: parent, name: 'another-site' });
  check('a second site is made alongside the first', fs.existsSync(second.projectPath));
  check(
    'with its own name',
    JSON.parse(fs.readFileSync(path.join(second.projectPath, 'package.json'), 'utf8')).name === 'another-site'
  );

  fs.rmSync(root, { recursive: true, force: true });

  if (failures.length) {
    console.error(`\nstarter: ${failures.length} failed, ${checked - failures.length} passed\n`);
    console.error(failures.join('\n') + '\n');
    process.exit(1);
  }
  console.log(`starter: ${checked} passed`);
})();
