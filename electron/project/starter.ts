import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';

import { toRecord } from '../../shared/core/record';
import { commandNeedsShell } from '../lib/platform';

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

interface Starter {
  readonly label: string;
  readonly create: string;
}

const STARTERS: Record<string, Starter> = {
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

type OnLog = (text: string) => void;

const run = (cmd: string, args: readonly string[], cwd: string, onLog?: OnLog): Promise<string> =>
  new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawn(cmd, [...args], {
        cwd,
        // On Windows npm is a .cmd shim, which needs a shell to be found.
        shell: commandNeedsShell(cmd),
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
          FORCE_COLOR: '0',
          NO_COLOR: '1',
          CI: '1', // npm asks before downloading a scaffolder; nobody is here to answer
        },
      });
    } catch (error: unknown) {
      reject(
        new Error(
          `Could not run ${cmd}: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
      return;
    }
    let tail = '';
    const onOut = (chunk: { toString(): string }): void => {
      // Progress spinners are drawn with cursor moves and line clears; strip
      // them so the log pane reads as the plain text it renders.
      const text = chunk
        .toString()
        .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
        .replace(/\r/g, '\n');
      tail = (tail + text).slice(-4000);
      onLog?.(text);
    };
    proc.stdout.on('data', onOut);
    proc.stderr.on('data', onOut);
    proc.on('error', (error: Error) => {
      const code = toRecord(error)?.['code'];
      reject(
        new Error(
          code === 'ENOENT'
            ? path.basename(cmd).startsWith('npm')
              ? 'npm could not be found. Install Node.js (which includes npm) and try again.'
              : `${cmd} could not be found. Install it and try again.`
            : `Could not run ${cmd}: ${error.message}`,
        ),
      );
    });
    proc.on('exit', (code) =>
      code === 0
        ? resolve(tail)
        : reject(new Error(`${cmd} ${args[0] ?? ''} exited with code ${code}.\n\n${tail}`)),
    );
  });

interface CreateStarterOptions {
  readonly starter?: string;
  readonly parentPath?: string;
  readonly name?: string;
  /** The npm command to run, so a test can hand it one that needs no network. */
  readonly npm?: string;
  readonly onLog?: OnLog;
}

/**
 * Runs a starter's scaffolder in `parentPath` to make `parentPath/name`, then
 * gives the site a history of its own. Installing what it needs is the
 * caller's — this is the part that has to be right before anything is
 * installed into it.
 */
async function createStarter({
  starter = 'lumos',
  parentPath,
  name,
  npm,
  onLog,
}: CreateStarterOptions = {}): Promise<{ ok: boolean; projectPath: string }> {
  const template = STARTERS[starter];
  if (!template) {
    throw new Error(`${starter} is not a starter this app knows.`);
  }
  const directory = newSiteDirectory(parentPath, name);
  const folder = path.basename(directory);

  // `--no-install`: the app installs afterwards, where a failure is an error
  // the wizard can show rather than a line in a log that scrolled past.
  const args = ['create', template.create, folder, '--yes', '--', '--no-install'];
  onLog?.(`> npm create ${template.create} ${folder}\n\n`);
  await run(npm || (isWin ? 'npm.cmd' : 'npm'), args, path.dirname(directory), onLog);

  if (!fs.existsSync(path.join(directory, 'package.json'))) {
    throw new Error('The starter finished but there is no package.json in it.');
  }

  // The package is the site, so it takes the site's name. The scaffolder does
  // this too; doing it here is what makes it a promise this app keeps rather
  // than one it hopes for.
  try {
    const file = path.join(directory, 'package.json');
    const raw: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    const pkg = toRecord(raw);
    if (pkg) {
      pkg['name'] = folder.toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
      fs.writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
    }
  } catch {
    /* an unusual package.json is not worth failing the site over */
  }

  // A scaffolder that started a history of its own has already done this, and
  // its first commit is the one to keep.
  if (!fs.existsSync(path.join(directory, '.git'))) {
    onLog?.('\n> starting a history for this site\n');
    try {
      await run('git', ['init', '-b', 'main'], directory);
      await run('git', ['add', '-A'], directory);
      // A first-time Git installation has no author configured yet. Give only
      // this generated commit a neutral identity; do not change the user's
      // repository or global configuration behind their back.
      await run(
        'git',
        [
          '-c',
          'user.name=Stacki',
          '-c',
          'user.email=stacki@local.invalid',
          'commit',
          '-m',
          `Start ${folder} from ${template.label}`,
        ],
        directory,
      );
    } catch (error: unknown) {
      // A site with no git still runs; say so rather than throwing it away.
      const reason = error instanceof Error ? error.message : String(error);
      onLog?.(`\n(could not start a git history: ${reason})\n`);
    }
  }

  return { ok: true, projectPath: directory };
}

/**
 * The folder a new site gets, `parentPath/name`, which must not exist yet. The
 * starter and the Astro wizard both use it, so the name rules and their
 * messages are the same in either flow.
 */
function newSiteDirectory(parentPath: string | undefined, name: string | undefined): string {
  if (!parentPath || !fs.existsSync(parentPath)) {
    throw new Error('Choose where the site should go first.');
  }
  const folder = String(name || '').trim();
  if (!folder) {
    throw new Error('Give the site a name.');
  }
  if (!NAME_RE.test(folder)) {
    throw new Error('Use letters, numbers, dashes, dots or underscores for the folder name.');
  }
  const directory = path.join(parentPath, folder);
  if (fs.existsSync(directory)) {
    throw new Error(`${folder} already exists in that folder.`);
  }
  return directory;
}

export { createStarter, newSiteDirectory, STARTERS };
