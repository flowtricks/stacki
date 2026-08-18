const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// Starting a site from a starter.
//
// The framework publishes its own scaffolder, so the app runs that rather than
// copying files itself: `npm create lumos@latest my-site`. It is the command
// the framework's own documentation gives, which means a site started here is
// the same site as one started in a terminal — and when the starter changes
// what a new site needs, the change arrives without this app being rebuilt.
//
// What it leaves behind is files: no history, and no remote pointing at a
// repository the user cannot push to. So the first commit is made here, of the
// starter as it stands, which is what they are actually starting from.

const isWin = process.platform === 'win32';

const STARTERS = {
  lumos: {
    label: 'Lumos',
    // Pinned to `@latest` rather than a version: the scaffolder is downloaded
    // per run, and a site started today should be started from today's.
    create: 'lumos@latest',
  },
};

// A folder name has to be a folder name; the site can be renamed later, but not
// out of a directory that already exists.
const NAME_RE = /^[A-Za-z0-9._-]+$/;

const run = (cmd, args, cwd, onLog) =>
  new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawn(cmd, args, {
        cwd,
        // npm is a .cmd shim on Windows, which needs a shell to be found.
        shell: isWin && /^npm/.test(cmd),
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
          FORCE_COLOR: '0',
          NO_COLOR: '1',
          CI: '1', // npm asks before downloading a scaffolder; nobody is here to answer
        },
      });
    } catch (err) {
      reject(new Error(`Could not run ${cmd}: ${err.message}`));
      return;
    }
    let tail = '';
    const onOut = (d) => {
      // Progress spinners are drawn with cursor moves and line clears; strip
      // them so the log pane reads as the plain text it renders.
      const text = d
        .toString()
        .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
        .replace(/\r/g, '\n');
      tail = (tail + text).slice(-4000);
      onLog?.(text);
    };
    proc.stdout.on('data', onOut);
    proc.stderr.on('data', onOut);
    proc.on('error', (err) =>
      reject(
        new Error(
          err.code === 'ENOENT'
            ? path.basename(cmd).startsWith('npm')
              ? 'npm could not be found. Install Node.js (which includes npm) and try again.'
              : `${cmd} could not be found. Install it and try again.`
            : `Could not run ${cmd}: ${err.message}`
        )
      )
    );
    proc.on('exit', (code) =>
      code === 0 ? resolve(tail) : reject(new Error(`${cmd} ${args[0]} exited with code ${code}.\n\n${tail}`))
    );
  });

/**
 * Runs a starter's scaffolder in `parentPath` to make `parentPath/name`, then
 * gives the site a history of its own. Installing what it needs is the
 * caller's — this is the part that has to be right before anything is
 * installed into it.
 *
 * `npm` is the command to run, so a test can hand it one that does not need the
 * network.
 */
async function createStarter({ starter = 'lumos', parentPath, name, npm, onLog } = {}) {
  const template = STARTERS[starter];
  if (!template) throw new Error(`${starter} is not a starter this app knows.`);
  if (!parentPath || !fs.existsSync(parentPath)) {
    throw new Error('Choose where the site should go first.');
  }

  const folder = String(name || '').trim();
  if (!folder) throw new Error('Give the site a name.');
  if (!NAME_RE.test(folder)) {
    throw new Error('Use letters, numbers, dashes, dots or underscores for the folder name.');
  }
  const dir = path.join(parentPath, folder);
  if (fs.existsSync(dir)) throw new Error(`${folder} already exists in that folder.`);

  // `--no-install`: the app installs afterwards, where a failure is an error
  // the wizard can show rather than a line in a log that scrolled past.
  const args = ['create', template.create, folder, '--yes', '--', '--no-install'];
  onLog?.(`> npm create ${template.create} ${folder}\n\n`);
  await run(npm || (isWin ? 'npm.cmd' : 'npm'), args, parentPath, onLog);

  if (!fs.existsSync(path.join(dir, 'package.json'))) {
    throw new Error('The starter finished but there is no package.json in it.');
  }

  // The package is the site, so it takes the site's name. The scaffolder does
  // this too; doing it here is what makes it a promise this app keeps rather
  // than one it hopes for.
  try {
    const file = path.join(dir, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
    pkg.name = folder.toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
    fs.writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
  } catch {
    /* an unusual package.json is not worth failing the site over */
  }

  // A scaffolder that started a history of its own has already done this, and
  // its first commit is the one to keep.
  if (!fs.existsSync(path.join(dir, '.git'))) {
    onLog?.('\n> starting a history for this site\n');
    try {
      await run('git', ['init', '-b', 'main'], dir);
      await run('git', ['add', '-A'], dir);
      await run('git', ['commit', '-m', `Start ${folder} from ${template.label}`], dir);
    } catch (err) {
      // A site with no git still runs; say so rather than throwing it away.
      onLog?.(`\n(could not start a git history: ${err.message})\n`);
    }
  }

  return { ok: true, projectPath: dir };
}

module.exports = { createStarter, STARTERS };
