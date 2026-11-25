// Goal: a setup command is never a .cmd or .bat shim handed straight to the operating system (that is
// `spawn EINVAL` on current Node, CVE-2024-27980). On Windows a shim becomes the JavaScript entry it runs,
// under a real node.exe or Stacki's own binary; only when no entry exists does a quoted cmd.exe line run it,
// and that line is built from checked constants. Off Windows nothing changes.
// Methodology: the pure resolver from dist/ with an injected platform, environment and in-memory file
// system, so Windows behaviour is tested on any host. Paths are built with path.win32, never the host's path.
// The negative space is covered on purpose: npm missing, unsafe characters in a shim path, an entry that
// tries to leave node_modules, and arguments outside the safe alphabet.
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { test } from 'node:test';
import {
  describeAttempt,
  nodeMissingMessage,
  resolveWindowsCommand,
  runnableCliPath,
  type CommandFileSystem,
  type ResolveOptions,
} from '#dist/electron/handlers/ai/windowsCommand.js';

const win = path.win32;

function fakeFileSystem(files: Readonly<Record<string, string>>): CommandFileSystem {
  const lower = new Map(Object.entries(files).map(([file, text]) => [file.toLowerCase(), text]));
  return {
    fileExists: (file) => lower.has(file.toLowerCase()),
    readText: (file) => lower.get(file.toLowerCase()),
    listDirectory: (directory) => {
      const prefix = `${directory.toLowerCase()}\\`;
      const names = new Set<string>();
      for (const file of Object.keys(files)) {
        if (file.toLowerCase().startsWith(prefix)) {
          names.add(file.slice(prefix.length).split('\\')[0] ?? '');
        }
      }
      return [...names];
    },
  };
}

function windows(files: Readonly<Record<string, string>>, environment: Record<string, string> = {}, platform: NodeJS.Platform = 'win32'): ResolveOptions {
  return {
    platform,
    environment: { Path: 'C:\\Windows\\System32;C:\\Program Files\\nodejs', ...environment },
    home: 'C:\\Users\\Ada',
    execPath: 'C:\\Program Files\\Stacki\\Stacki.exe',
    fileSystem: fakeFileSystem(files),
  };
}

const NPM_ARGS = ['install', '--global', '@openai/codex'] as const;
const NODE_DIRECTORY = 'C:\\Program Files\\nodejs';
const NPM_FILES = {
  [win.join(NODE_DIRECTORY, 'npm.cmd')]: '@ECHO OFF',
  [win.join(NODE_DIRECTORY, 'node.exe')]: '',
  [win.join(NODE_DIRECTORY, 'node_modules', 'npm', 'bin', 'npm-cli.js')]: '',
};

test('npm.cmd on Windows runs npm-cli.js under the node.exe beside it, with no shim and no shell', () => {
  const result = resolveWindowsCommand({ command: 'npm.cmd', args: NPM_ARGS }, windows(NPM_FILES));
  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  assert.equal(result.value.command.command, win.join(NODE_DIRECTORY, 'node.exe'));
  assert.deepEqual(result.value.command.args, [win.join(NODE_DIRECTORY, 'node_modules', 'npm', 'bin', 'npm-cli.js'), ...NPM_ARGS]);
  assert.equal(result.value.command.argumentStyle, undefined);
  assert.deepEqual(result.value.environment, {});
  assert.doesNotMatch(result.value.command.command, /\.(cmd|bat)$/i);
});

test('a bare npm is found on PATH through PATHEXT, whatever the case of Path and PATHEXT', () => {
  const result = resolveWindowsCommand({ command: 'npm', args: NPM_ARGS }, windows(NPM_FILES, { PATHEXT: '.EXE;.CMD' }));
  assert.equal(result.ok && result.value.command.args[0], win.join(NODE_DIRECTORY, 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  const lowerCase = resolveWindowsCommand(
    { command: 'npm', args: NPM_ARGS },
    { ...windows(NPM_FILES), environment: { PATH: NODE_DIRECTORY, pathext: '.cmd' } },
  );
  assert.equal(lowerCase.ok, true);
});

test('npm in a user folder with spaces and non-ASCII characters stays whole arguments', () => {
  const folder = 'C:\\Users\\Zoë Müller\\Node Tools';
  const files = {
    [win.join(folder, 'npm.cmd')]: '',
    [win.join(folder, 'node.exe')]: '',
    [win.join(folder, 'node_modules', 'npm', 'bin', 'npm-cli.js')]: '',
  };
  const result = resolveWindowsCommand({ command: 'npm.cmd', args: NPM_ARGS }, windows(files, { Path: `"${folder}"` }));
  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  assert.equal(result.value.command.command, win.join(folder, 'node.exe'));
  assert.equal(result.value.command.args[0], win.join(folder, 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  assert.match(result.value.description, /^"C:\\Users\\Zoë Müller\\Node Tools\\node\.exe" "/);
});

test('npm that is not on PATH is still found in Node’s install folder and in the user’s npm prefix', () => {
  const result = resolveWindowsCommand({ command: 'npm.cmd', args: NPM_ARGS }, windows(NPM_FILES, { Path: 'C:\\Windows\\System32' }));
  assert.equal(result.ok, true);
  const prefix = 'C:\\Users\\Ada\\AppData\\Roaming\\npm';
  const codex = resolveWindowsCommand(
    { command: 'codex.cmd', args: ['login', 'status'] },
    windows(
      {
        [win.join(prefix, 'codex.cmd')]: '"%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
        [win.join(prefix, 'node_modules', '@openai', 'codex', 'bin', 'codex.js')]: '',
        [win.join(NODE_DIRECTORY, 'node.exe')]: '',
      },
      { Path: 'C:\\Windows\\System32' },
    ),
  );
  assert.equal(codex.ok && codex.value.command.command, win.join(NODE_DIRECTORY, 'node.exe'));
  assert.equal(codex.ok && codex.value.command.args[0], win.join(prefix, 'node_modules', '@openai', 'codex', 'bin', 'codex.js'));
});

test('a codex.cmd shim runs the entry its own text names, and an absolute shim path works too', () => {
  const prefix = 'C:\\Users\\Ada\\AppData\\Roaming\\npm';
  const shim = win.join(prefix, 'codex.cmd');
  const entry = win.join(prefix, 'node_modules', '@openai', 'codex', 'bin', 'custom.js');
  const files = { [shim]: '"%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\custom.js" %*', [entry]: '', [win.join(NODE_DIRECTORY, 'node.exe')]: '' };
  const result = resolveWindowsCommand({ command: shim, args: ['login'] }, windows(files));
  assert.deepEqual(result.ok && result.value.command.args, [entry, 'login']);
});

test('with no node.exe anywhere, Stacki’s own binary runs the entry as Node', () => {
  const files = { [win.join(NODE_DIRECTORY, 'npm.cmd')]: '', [win.join(NODE_DIRECTORY, 'node_modules', 'npm', 'bin', 'npm-cli.js')]: '' };
  const result = resolveWindowsCommand({ command: 'npm.cmd', args: NPM_ARGS }, windows(files));
  assert.equal(result.ok && result.value.command.command, 'C:\\Program Files\\Stacki\\Stacki.exe');
  assert.deepEqual(result.ok && result.value.environment, { ELECTRON_RUN_AS_NODE: '1' });
  assert.match(result.ok ? result.value.description : '', /^ELECTRON_RUN_AS_NODE=1 /);
});

test('a real .exe is started as it is, and powershell.exe is left alone', () => {
  const exe = resolveWindowsCommand({ command: 'C:\\Users\\Ada\\.local\\bin\\claude.exe', args: ['auth', 'status'] }, windows({}));
  assert.deepEqual(exe.ok && exe.value.command, { command: 'C:\\Users\\Ada\\.local\\bin\\claude.exe', args: ['auth', 'status'] });
  const shell = resolveWindowsCommand({ command: 'powershell.exe', args: ['-NoProfile'] }, windows({}));
  assert.equal(shell.ok && shell.value.command.command, 'powershell.exe');
  const onPath = resolveWindowsCommand({ command: 'codex', args: ['login'] }, windows({ 'C:\\Program Files\\nodejs\\codex.exe': '' }));
  assert.equal(onPath.ok && onPath.value.command.command, 'C:\\Program Files\\nodejs\\codex.exe');
});

test('missing npm is a sentence with the Node.js download, and nothing is started', () => {
  const result = resolveWindowsCommand({ command: 'npm.cmd', args: NPM_ARGS }, windows({}));
  assert.deepEqual(result, { ok: false, error: nodeMissingMessage('npm') });
  assert.match(nodeMissingMessage('npm'), /https:\/\/nodejs\.org/);
  const other = resolveWindowsCommand({ command: 'codex.cmd', args: ['login'] }, windows({}));
  assert.equal(other.ok, false);
  const absent = resolveWindowsCommand({ command: 'C:\\gone\\npm.cmd', args: NPM_ARGS }, windows(NPM_FILES));
  assert.equal(absent.ok, false);
});

test('with no entry to run, the shim goes through cmd.exe /d /s /c with one verbatim, quoted line', () => {
  const folder = 'C:\\Users\\Ada Lovelace\\bin';
  const shim = win.join(folder, 'codex.cmd');
  const result = resolveWindowsCommand(
    { command: shim, args: ['login', 'status'] },
    windows({ [shim]: 'unreadable shim' }, { ComSpec: 'C:\\Windows\\System32\\cmd.exe' }),
  );
  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  assert.equal(result.value.command.command, 'C:\\Windows\\System32\\cmd.exe');
  assert.equal(result.value.command.argumentStyle, 'verbatim');
  assert.deepEqual(result.value.command.args, ['/d', '/s', '/c', '""C:\\Users\\Ada Lovelace\\bin\\codex.cmd" login status"']);
});

test('the cmd.exe fallback finds the system cmd.exe without ComSpec, and ignores a ComSpec that is not a drive path', () => {
  const shim = 'C:\\tools\\codex.cmd';
  const withRoot = resolveWindowsCommand({ command: shim, args: ['login'] }, windows({ [shim]: '' }, { SystemRoot: 'C:\\Windows' }));
  assert.equal(withRoot.ok && withRoot.value.command.command, 'C:\\Windows\\System32\\cmd.exe');
  const hostile = resolveWindowsCommand({ command: shim, args: ['login'] }, windows({ [shim]: '' }, { ComSpec: 'cmd.exe & calc' }));
  assert.equal(hostile.ok && hostile.value.command.command, 'cmd.exe');
});

test('the cmd.exe fallback refuses a shim path cmd.exe would read as syntax', () => {
  for (const unsafe of ['C:\\100%\\codex.cmd', 'C:\\a"b\\codex.cmd', 'C:\\hello!\\codex.cmd']) {
    const result = resolveWindowsCommand({ command: unsafe, args: ['login'] }, windows({ [unsafe]: '' }));
    assert.equal(result.ok, false, unsafe);
  }
  const quoted = resolveWindowsCommand({ command: 'C:\\R&D ^team\\codex.cmd', args: ['login'] }, windows({ 'C:\\R&D ^team\\codex.cmd': '' }));
  assert.equal(quoted.ok, true, 'ampersand and caret are literal inside quotes');
});

test('the cmd.exe fallback asserts that arguments are safe constants', () => {
  const shim = 'C:\\tools\\codex.cmd';
  assert.throws(() => resolveWindowsCommand({ command: shim, args: ['login & calc'] }, windows({ [shim]: '' })), /safe constant argument/);
  assert.throws(() => resolveWindowsCommand({ command: shim, args: ['"'] }, windows({ [shim]: '' })), /safe constant argument/);
});

test('an entry named by a shim cannot leave the shim’s node_modules', () => {
  const shim = 'C:\\tools\\codex.cmd';
  const files = { [shim]: '"%dp0%\\..\\evil\\run.js"', 'C:\\evil\\run.js': '', 'C:\\tools\\evil\\run.js': '' };
  const result = resolveWindowsCommand({ command: shim, args: ['login'] }, windows(files));
  assert.equal(result.ok && result.value.command.argumentStyle, 'verbatim');
  const sibling = { [shim]: '"%dp0%\\bin\\run.js"', 'C:\\tools\\bin\\run.js': '' };
  const second = resolveWindowsCommand({ command: shim, args: ['login'] }, windows(sibling));
  assert.equal(second.ok && second.value.command.argumentStyle, 'verbatim');
});

test('off Windows nothing changes: npm, the CLI path and the arguments pass through', () => {
  for (const platform of ['darwin', 'linux'] as const) {
    const command = { command: 'npm', args: ['install', '--global', '--prefix', '/Users/ada/.local', '@openai/codex'] };
    const result = resolveWindowsCommand(command, windows({}, {}, platform));
    assert.deepEqual(result.ok && result.value.command, command);
    assert.deepEqual(result.ok && result.value.environment, {});
    assert.equal(runnableCliPath('/usr/local/bin/codex', windows({}, {}, platform)), '/usr/local/bin/codex');
    assert.equal(runnableCliPath('C:\\x\\codex.cmd', windows({}, {}, platform)), 'C:\\x\\codex.cmd');
  }
});

test('runnableCliPath prefers the native codex.exe inside the package, else keeps the shim or the .exe', () => {
  const prefix = 'C:\\Users\\Ada\\AppData\\Roaming\\npm';
  const shim = win.join(prefix, 'codex.cmd');
  const native = win.join(
    prefix,
    'node_modules',
    '@openai',
    'codex',
    'node_modules',
    '@openai',
    'codex-win32-x64',
    'vendor',
    'x86_64-pc-windows-msvc',
    'codex',
    'codex.exe',
  );
  assert.equal(runnableCliPath(shim, windows({ [native]: '' })), native);
  assert.equal(runnableCliPath(shim, windows({})), shim);
  assert.equal(runnableCliPath('C:\\bin\\codex.exe', windows({ [native]: '' })), 'C:\\bin\\codex.exe');
});

test('describeAttempt names the platform and the command for Details', () => {
  assert.equal(describeAttempt('win32', 'x64', 'node.exe npm-cli.js install'), 'Platform: win32 x64\nTried: node.exe npm-cli.js install');
  assert.throws(() => describeAttempt('win32', 'x64', ''), /a command was tried/);
});
