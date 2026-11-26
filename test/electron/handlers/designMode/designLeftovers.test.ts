// Goal: after a crash, what still runs from a sandbox copy is stopped and the copy, with its `.env`, is deleted, on
// macOS, Windows and Linux; nothing else is ever stopped; and a copy that cannot go yet loses its secret files, holds
// back no other copy, and is deleted by a later sweep.
//
// Method: three layers. (1) The rule for what runs from a copy, on made-up process tables of all three systems: what
// is taken and, line by line, what is left alone. (2) The readers of PowerShell's and `ps`'s answers, good and bad.
// (3) Real processes, listed and stopped the way the app does it on this computer. A launcher starts a "dev server"
// from a copy (its folder name holds a space, brackets and a letter outside ASCII) and exits, so it is left over as
// after a crash; the server stands in the copy, holds a file of it open, ignores SIGTERM and starts a worker by a
// relative name. Beside it run processes that must survive: a Node program naming a neighbour of the copy, a program
// that is no JavaScript runtime naming a file in it, and the server of a copy the sweep is told to keep. A copy that
// cannot be deleted is made the way each system makes one: a program standing in it on Windows, a folder without
// write access elsewhere (not as root, whom no folder refuses). Every process started is ended again.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DESIGN_LEFTOVER_LIMITS,
  leftoverProcesses,
  listProcesses,
  parsePosixProcesses,
  parseWindowsProcesses,
  stopServersIn,
  type ListedProcess,
  type RunsFrom,
} from '#dist/electron/handlers/designMode/designLeftovers.js';
import { discardSandbox, removeSandboxAtQuit, sandboxesRoot, scrubSecrets, sweepSandboxes } from '#dist/electron/handlers/designMode/designSandbox.js';
import waits from '../../../helpers/waitFor.js';

const WAIT = { polls: 600, pollMs: 100 } as const;

type Told = Pick<ListedProcess, 'parentPid' | 'cwd' | 'startedMs'>;

const UNTOLD: Told = { parentPid: 1, cwd: undefined, startedMs: undefined };

function listed(pid: number, program: string, commandLine: string): ListedProcess {
  return { pid, program, commandLine, ...UNTOLD };
}

/** A process the system says more about: its parent, where it stands, when it started. */
function told(
  process_: ListedProcess,
  more: Pick<Told, 'cwd'> | Pick<Told, 'parentPid'> | Pick<Told, 'parentPid' | 'startedMs'> | Pick<Told, 'startedMs'>,
): ListedProcess {
  return { ...process_, ...more };
}

const found = (processes: readonly ListedProcess[], where: RunsFrom) =>
  leftoverProcesses(processes, where)
    .map((entry) => entry.pid)
    .sort((left, right) => left - right);

test('macOS and Linux: what runs from the copy is taken; what only names it, or a neighbour, is left alone', () => {
  const root = '/home/ada/.config/Stacki/design-sandboxes/1234';
  const live = `${root}/site/My Site`;
  const node = '/usr/local/bin/node';
  const where: RunsFrom = { roots: [root], platform: 'linux', ownPid: 10, ownProgram: '/opt/Stacki/stacki' };
  const taken = [
    listed(100, node, `${node} ${live}/node_modules/astro/astro.js dev --port 4321`),
    listed(101, `${live}/node_modules/@esbuild/linux-x64/bin/esbuild`, 'esbuild --service=0.27.0 --ping'),
    listed(102, '', `${live}/node_modules/.bin/astro dev`),
    // The app itself, run as Node for Studio.
    listed(103, '/opt/Stacki/stacki', `/opt/Stacki/stacki ${live}/node_modules/astro/bin/astro.mjs dev`),
    // A worker started by a relative name: Linux tells where it stands.
    told(listed(104, node, 'node worker.js'), { cwd: live }),
    // And where the system does not tell, its parent does.
    told(listed(105, node, 'node worker.js'), { parentPid: 100 }),
    told(listed(106, node, 'node deeper.js'), { parentPid: 105 }),
  ];
  const left = [
    listed(200, '/usr/bin/vim', `vim ${live}/src/pages/index.astro`),
    listed(201, '/usr/bin/tail', `tail -f ${live}/dev.log`),
    told(listed(202, '/bin/bash', 'bash'), { cwd: live }),
    listed(203, '/usr/bin/grep', `grep -r secret ${root}`),
    listed(204, node, `${node} ${root}-old/site/server.js`),
    listed(205, node, `${node} /home/ada/.config/Stacki/design-sandboxes/12345/site/server.js`),
    told(listed(206, node, `${node} /home/ada/work/site/node_modules/astro/astro.js dev`), { cwd: '/home/ada/work/site' }),
    // A browser the dev server opened is a child of it, and the person's own.
    told(listed(207, '/usr/lib/firefox/firefox', 'firefox http://localhost:4321/'), { parentPid: 100 }),
    listed(208, '/usr/bin/code', `code ${root}`),
    // This process and what started it, whatever their command lines say.
    told(listed(10, node, `${node} --test ${live}`), { parentPid: 9 }),
    listed(9, node, `${node} runner.js ${live}`),
    listed(1, node, `${node} ${live}/init.js`),
  ];
  assert.deepEqual(
    found([...taken, ...left], where),
    taken.map((entry) => entry.pid),
  );
  // macOS: `ps` gives the same command lines, spaces and all, and no working directory.
  const mac = '/Users/ada/Library/Application Support/Stacki/design-sandboxes/1234';
  const darwin: RunsFrom = { roots: [mac], platform: 'darwin', ownPid: 10, ownProgram: '/Applications/Stacki.app/Contents/MacOS/Stacki' };
  assert.deepEqual(
    found(
      [
        listed(300, '/opt/homebrew/bin/node', `/opt/homebrew/bin/node ${mac}/site/web/node_modules/astro/astro.js dev`),
        listed(301, 'node', `node ${mac}/site/web/node_modules/astro/astro.js dev`),
        listed(302, '/usr/bin/tail', `tail -f ${mac}/site/web/dev.log`),
        listed(303, '/opt/homebrew/bin/node', `/opt/homebrew/bin/node ${mac.toLowerCase()}/x.js`),
      ],
      darwin,
    ),
    [300, 301],
  );
});

test('Windows: either slash and any case name the copy; cmd.exe shims count; a reused parent id does not', () => {
  const root = 'C:\\Users\\Ada Lovelace\\AppData\\Roaming\\Stacki\\design-sandboxes\\1234';
  const live = `${root}\\site\\web`;
  const node = 'C:\\Program Files\\nodejs\\node.exe';
  const where: RunsFrom = { roots: [root], platform: 'win32', ownPid: 10, ownProgram: 'C:\\Programs\\Stacki\\Stacki.exe' };
  const processes = [
    told(listed(100, node, `"${node}" "${live}\\node_modules\\astro\\astro.js" dev`), { startedMs: 1_000 }),
    listed(101, node, `"${node}" ${live.toUpperCase().replaceAll('\\', '/')}/node_modules/vite/bin/vite.js`),
    listed(102, `${live}\\node_modules\\@esbuild\\win32-x64\\esbuild.exe`, 'esbuild --service=0.27.0'),
    listed(103, 'C:\\Windows\\System32\\cmd.exe', `cmd.exe /d /s /c ""${live}\\node_modules\\.bin\\astro.cmd" dev"`),
    listed(104, 'C:\\Programs\\Stacki\\Stacki.exe', `Stacki.exe "${live}\\node_modules\\astro\\bin\\astro.mjs" dev`),
    // Started by the server, named relatively.
    told(listed(105, 'node.exe', 'node worker.js'), { parentPid: 100, startedMs: 2_000 }),
    // Older than its "parent": the id it remembers has since been given to the server.
    told(listed(200, node, 'node mine.js'), { parentPid: 100, startedMs: 500 }),
    listed(201, 'C:\\Windows\\System32\\notepad.exe', `notepad.exe ${live}\\.env`),
    listed(202, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', `powershell -Command Get-Content ${live}\\log`),
    listed(203, node, `"${node}" "${root}9\\site\\server.js"`),
    listed(204, '', ''),
    // A command prompt the person opened in the copy runs no shim.
    listed(206, 'C:\\Windows\\System32\\cmd.exe', `cmd.exe /k cd /d "${live}"`),
    told(listed(205, 'C:\\Program Files\\Browser\\browser.exe', 'browser.exe http://localhost:4321'), { parentPid: 100, startedMs: 3_000 }),
    listed(4, 'System', ''),
  ];
  assert.deepEqual(found(processes, where), [100, 101, 102, 103, 104, 105]);
  assert.throws(() => leftoverProcesses(processes, { ...where, roots: ['C:\\'] }), /never a drive or a top folder/);
  assert.throws(() => leftoverProcesses(processes, { ...where, platform: 'linux', roots: ['/home'] }), /never a drive or a top folder/);
});

// Null as PowerShell writes it, parsed from JSON.
const jsonNull: unknown = JSON.parse('null');

test('process listings are read strictly: bad and empty answers are refused', () => {
  const row = { pid: 7, parent: 1, name: 'node.exe', program: 'C:\\node\\node.exe', command: 'node a.js', started: 5 };
  const hidden = { pid: 8, parent: 1, name: 'svchost.exe', program: jsonNull, command: jsonNull, started: 0 };
  const parsed = parseWindowsProcesses(`\uFEFF${JSON.stringify([row, hidden])}\r\n`);
  assert.deepEqual(parsed, [
    { pid: 7, parentPid: 1, program: 'C:\\node\\node.exe', commandLine: 'node a.js', cwd: undefined, startedMs: 5 },
    { pid: 8, parentPid: 1, program: 'svchost.exe', commandLine: '', cwd: undefined, startedMs: undefined },
  ]);
  assert.equal(parseWindowsProcesses(JSON.stringify(row)).length, 1, 'one process comes as an object, not a list');
  assert.throws(() => parseWindowsProcesses(''), SyntaxError);
  assert.throws(() => parseWindowsProcesses('Access denied'), SyntaxError);
  assert.throws(() => parseWindowsProcesses('[]'), /no process listed/);
  assert.throws(() => parseWindowsProcesses(JSON.stringify([{ pid: '7', parent: 1 }])), /without an id/);
  assert.throws(() => parseWindowsProcesses(JSON.stringify([{ pid: -1, parent: 1 }])), /without an id/);
  const commands = '    1     0 /sbin/launchd\n  42     1 /opt/home brew/node /a b/c.js --x\n';
  assert.deepEqual(parsePosixProcesses(commands, '    1 /sbin/launchd\n  42 /opt/home brew/node\n')[1], {
    pid: 42,
    parentPid: 1,
    program: '/opt/home brew/node',
    commandLine: '/opt/home brew/node /a b/c.js --x',
    cwd: undefined,
    startedMs: undefined,
  });
  assert.throws(() => parsePosixProcesses('', ''), /no process listed/);
});

test('this computer lists its processes, this one among them with its command line', async () => {
  const own = (await listProcesses()).find((entry) => entry.pid === process.pid);
  assert.ok(own !== undefined);
  assert.ok(own.program.toLowerCase().includes('node'), own.program);
  assert.ok(own.commandLine.includes('designLeftovers') || own.commandLine.includes('node'), own.commandLine);
});

test('stopping answers honestly: unread processes, and one that outlasts every round', async () => {
  const root = path.join(os.tmpdir(), 'stacki-leftover-none', 'copy');
  const unread = await stopServersIn(root, () => Promise.reject(new Error('no process table')));
  assert.ok(unread.kind === 'unlisted' && unread.detail.includes('no process table'));
  // An id no system gives out, so the signals reach nobody, listed again each time as if it would not end.
  const stubborn = listed(2_147_480_000, process.execPath, `${process.execPath} ${path.resolve(root)}/server.js`);
  let listings = 0;
  const outcome = await stopServersIn(root, () => {
    listings += 1;
    return Promise.resolve([stubborn]);
  });
  assert.deepEqual(outcome, { kind: 'running', pids: [stubborn.pid] });
  assert.equal(listings, DESIGN_LEFTOVER_LIMITS.roundsMax + 1, 'bounded: one listing a round and one to confirm');
  assert.deepEqual(await stopServersIn(root, () => Promise.resolve([listed(process.pid, 'node', 'node')])), { kind: 'stopped', signalled: 0 });
});

// --- Real processes and real folders ----------------------------------------

function scratchAppData(): string {
  // A home folder as people have them: a space, brackets, a plus and a letter outside ASCII.
  const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'stacki-left-'));
  const appData = path.join(root, 'Zoë (work) + play', 'Application Support');
  fs.mkdirSync(appData, { recursive: true });
  return appData;
}

function makeCopy(appData: string): { readonly root: string; readonly live: string } {
  const root = path.join(sandboxesRoot(appData), randomUUID());
  const live = path.join(root, 'site', 'My Site');
  fs.mkdirSync(path.join(live, 'node_modules', 'astro'), { recursive: true });
  fs.mkdirSync(path.join(live, 'src'));
  fs.writeFileSync(path.join(live, '.env'), 'SECRET=1\n');
  fs.writeFileSync(path.join(live, '.env.production'), 'SECRET=2\n');
  fs.writeFileSync(path.join(live, 'src', 'page.astro'), '<p>page</p>\n');
  return { root, live };
}

const SERVER = `
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
process.on('SIGTERM', () => {});
const held = fs.openSync(path.join(process.cwd(), 'held.log'), 'a');
setInterval(() => fs.writeSync(held, '.'), 100);
const worker = spawn(process.execPath, ['worker.js'], { cwd: process.cwd(), stdio: 'ignore', windowsHide: true });
worker.once('spawn', () => fs.writeFileSync(process.argv[2], JSON.stringify([process.pid, worker.pid])));
// Whatever goes wrong with the test, nothing is left running for long.
setTimeout(() => process.exit(0), 180000);
`;
const WORKER = `process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); setTimeout(() => process.exit(0), 180000);`;
// Starts the server in a process group of its own and goes, as the app goes in a crash.
const LAUNCHER = `
const { spawn } = require('node:child_process');
const [script, cwd, note] = process.argv.slice(1);
spawn(process.execPath, [script, note], { cwd, detached: true, stdio: 'ignore', windowsHide: true }).unref();
`;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(what: string, ready: () => boolean): Promise<void> {
  await waits.waitFor({ what, read: ready, until: (reached) => reached, pollCountMax: WAIT.polls, pollIntervalMs: WAIT.pollMs });
}

/** A dev server left over in `live`: its id and its worker's, both running, their starter gone. */
async function leaveServer(live: string, note: string): Promise<readonly number[]> {
  const script = path.join(live, 'node_modules', 'astro', 'astro.js');
  fs.writeFileSync(script, SERVER);
  fs.writeFileSync(path.join(live, 'worker.js'), WORKER);
  const launcher = spawn(process.execPath, ['-e', LAUNCHER, script, live, note], { stdio: 'ignore', windowsHide: true });
  await new Promise<void>((resolve, reject) => {
    launcher.once('error', reject);
    launcher.once('exit', () => resolve());
  });
  await until('the leftover server', () => fs.existsSync(note) && fs.readFileSync(note, 'utf8').endsWith(']'));
  const pids: unknown = JSON.parse(fs.readFileSync(note, 'utf8'));
  assert.ok(Array.isArray(pids) && pids.every((pid) => Number.isSafeInteger(pid)));
  return pids.map(Number);
}

function started(child: ChildProcess): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('spawn', () => resolve(child));
  });
}

/** A program that is no JavaScript runtime, naming a file in the copy: a log viewer, an editor. */
function viewer(file: string): ChildProcess {
  if (process.platform === 'win32') {
    return spawn('powershell.exe', ['-NoProfile', '-Command', `Start-Sleep -Seconds 120 # ${file}`], { stdio: 'ignore', windowsHide: true });
  }
  return spawn('tail', ['-f', file], { stdio: 'ignore' });
}

function endAll(children: readonly ChildProcess[], pids: readonly number[]): void {
  for (const child of children) {
    child.kill('SIGKILL');
  }
  for (const pid of pids) {
    if (isAlive(pid)) {
      process.kill(pid, 'SIGKILL');
    }
  }
}

test('a real leftover dev server and its worker are stopped, the copy goes, and nothing else is touched', async () => {
  const appData = scratchAppData();
  const crashed = makeCopy(appData);
  const kept = makeCopy(appData);
  const outside = path.dirname(appData);
  const pids: number[] = [];
  const bystanders: ChildProcess[] = [];
  try {
    pids.push(...(await leaveServer(crashed.live, path.join(outside, 'crashed.json'))));
    const keptPids = await leaveServer(kept.live, path.join(outside, 'kept.json'));
    pids.push(...keptPids);
    const idle = 'setInterval(() => {}, 1000); setTimeout(() => process.exit(0), 180000)';
    const neighbour = spawn(process.execPath, ['-e', idle, `${crashed.root}-neighbour/server.js`], { cwd: outside, stdio: 'ignore', windowsHide: true });
    bystanders.push(await started(neighbour), await started(viewer(path.join(crashed.live, '.env'))));
    assert.ok(pids.every(isAlive), 'the leftovers run before the sweep');

    // As at startup, but for the second copy, which stands for one a session is using.
    assert.equal(await sweepSandboxes(appData, kept.root), 1);

    const crashedPids = pids.filter((pid) => !keptPids.includes(pid));
    assert.equal(crashedPids.length, 2);
    await until('the leftovers to end', () => !crashedPids.some(isAlive));
    assert.ok(!fs.existsSync(crashed.root), 'the copy and its .env are gone');
    assert.ok(keptPids.every(isAlive), 'the kept copy’s server runs on');
    assert.ok(fs.existsSync(path.join(kept.live, '.env')));
    for (const bystander of bystanders) {
      assert.ok(bystander.pid !== undefined && isAlive(bystander.pid), `left alone: ${bystander.spawnargs.join(' ')}`);
      assert.equal(bystander.exitCode ?? bystander.signalCode ?? 'running', 'running');
    }
    endAll(bystanders, []);
    // A later start, with no session, takes the other too.
    assert.equal(await sweepSandboxes(appData), 1);
    await until('the second server to end', () => !keptPids.some(isAlive));
    assert.deepEqual(fs.readdirSync(sandboxesRoot(appData)), []);
  } finally {
    endAll(bystanders, pids);
    fs.rmSync(outside, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

/** Makes `copy` refuse to be deleted, the way this system refuses; the result lets go again. */
async function lock(copy: { readonly live: string }): Promise<() => Promise<void>> {
  const folder = path.join(copy.live, 'locked');
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, 'file.txt'), 'x');
  if (process.platform !== 'win32') {
    fs.chmodSync(folder, 0o500);
    return () => Promise.resolve(fs.chmodSync(folder, 0o700));
  }
  // Windows keeps a folder a program stands in. Not a program the sweep may stop, and one that says when it stands.
  const holder = await started(
    spawn('powershell.exe', ['-NoProfile', '-Command', "[Console]::Out.WriteLine('standing'); Start-Sleep -Seconds 120"], {
      cwd: folder,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    }),
  );
  await new Promise<void>((resolve) => holder.stdout?.once('data', () => resolve()));
  return () =>
    new Promise<void>((resolve) => {
      holder.once('exit', () => resolve());
      holder.kill('SIGKILL');
    });
}

const ROOT_IGNORES_MODES = process.getuid?.() === 0 ? { skip: 'root deletes from a folder whatever its mode' } : {};

test('a copy that will not go loses its secrets, holds no other back, and goes at a later start', ROOT_IGNORES_MODES, async () => {
  const appData = scratchAppData();
  const stuck = makeCopy(appData);
  const others = [makeCopy(appData), makeCopy(appData)];
  const release = await lock(stuck);
  try {
    assert.equal(await sweepSandboxes(appData), 2, 'the others go, whichever order they are read in');
    assert.ok(others.every((copy) => !fs.existsSync(copy.root)));
    assert.ok(fs.existsSync(stuck.root), 'the folder stays: it is how a later start knows to try again');
    assert.ok(!fs.existsSync(path.join(stuck.live, '.env')));
    assert.ok(!fs.existsSync(path.join(stuck.live, '.env.production')));
    assert.equal(await sweepSandboxes(appData), 0, 'tried again, and refused again, without an error');
    assert.ok(fs.existsSync(stuck.root));
    // Quitting over such a copy does not fail either.
    removeSandboxAtQuit(stuck.root);
  } finally {
    await release();
  }
  await sweepSandboxes(appData);
  await until('the copy to go', () => !fs.existsSync(stuck.root));
  fs.rmSync(path.dirname(appData), { recursive: true, force: true });
});

test('a copy something still runs from is kept without its secrets; one whose processes could not be read is deleted', async () => {
  const appData = scratchAppData();
  const running = makeCopy(appData);
  fs.writeFileSync(path.join(running.live, '.dev.vars'), 'TOKEN=3\n');
  fs.writeFileSync(path.join(running.live, 'src', 'site.pem'), 'key');
  assert.equal(await discardSandbox(running.root, { kind: 'running', pids: [4242] }), 'kept');
  assert.deepEqual(fs.readdirSync(running.live).sort(), ['node_modules', 'src']);
  assert.deepEqual(fs.readdirSync(path.join(running.live, 'src')), ['page.astro']);
  assert.equal(scrubSecrets(running.root), 0);
  assert.equal(scrubSecrets(path.join(appData, 'never-made')), 0);
  assert.equal(await sweepSandboxes(appData), 1, 'the next sweep finds nothing running and deletes it');
  const unread = makeCopy(appData);
  assert.equal(await discardSandbox(unread.root, { kind: 'unlisted', detail: 'no process table' }), 'removed');
  const quitting = makeCopy(appData);
  removeSandboxAtQuit(quitting.root);
  await until('the copy to go at quit', () => !fs.existsSync(quitting.root));
  fs.rmSync(path.dirname(appData), { recursive: true, force: true });
});
