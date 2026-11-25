// Shared pieces of the platform integration suite (plan §10, §11 step 5): a
// real document-actor host, scratch directories on real filesystems, and the
// detection of a Windows filesystem this machine can reach. Nothing here fakes
// the disk; where a test must inject a failure it says so itself.
const { createHash } = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DocumentActors } = require('#dist/electron/documents/documentActors.js');
const { NODE_PROJECTOR, NodeDocumentDisk } = require('#dist/electron/documents/documentDisk.js');
const { createDocumentTelemetry } = require('#dist/electron/documents/documentTelemetry.js');
const { planIntent } = require('#dist/shared/engine/planner.js');
const { atomicDirectoryOf } = require('#dist/electron/documents/atomicDirectory.js');

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** A real host: the real disk, planner and projector; telemetry into `lines`. */
function realHost(lines = []) {
  return new DocumentActors({
    disk: new NodeDocumentDisk(),
    projector: NODE_PROJECTOR,
    planner: planIntent,
    telemetry: createDocumentTelemetry((line) => lines.push(line)),
    drain: 'immediate',
    schedule: (task) => setImmediate(task),
  });
}

/** Run `run(root)` in a fresh directory under `base`, removed afterwards. */
async function scratch(base, run) {
  const root = fs.mkdtempSync(path.join(base, 'stacki-platform-'));
  try {
    return await run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/** Temporary and lock files left in a target directory's stable staging folder. */
function protocolLeftovers(root) {
  const directory = atomicDirectoryOf(path.join(root, 'page.astro'));
  return fs.existsSync(directory) ? fs.readdirSync(directory) : [];
}

/** Where Windows semantics can be tested for real: native Windows, or WSL with
 * interop and an NTFS temp folder. Undefined, with the reason, otherwise. */
function windowsFilesystem() {
  if (process.platform === 'win32') {
    return { directory: os.tmpdir(), toWindows: (file) => file, powershell: 'powershell.exe' };
  }
  if (process.platform !== 'linux') {
    return { skip: `no Windows filesystem on ${process.platform}` };
  }
  if (!fs.existsSync('/proc/sys/fs/binfmt_misc/WSLInterop')) {
    return { skip: 'not WSL with Windows interop' };
  }
  const user = spawnSync('cmd.exe', ['/c', 'echo %USERNAME%'], {
    encoding: 'utf8',
    timeout: 20_000,
  });
  const name = user.stdout?.trim();
  if (user.status !== 0 || !name) {
    return { skip: 'Windows interop did not answer' };
  }
  const directory = `/mnt/c/Users/${name}/AppData/Local/Temp`;
  if (!fs.existsSync(directory)) {
    return { skip: `no NTFS temp folder at ${directory}` };
  }
  const toWindows = (file) => spawnSync('wslpath', ['-w', file], { encoding: 'utf8' }).stdout.trim();
  return { directory, toWindows, powershell: 'powershell.exe' };
}

/** Hold `file` open from a Windows process with the given sharing until the
 * returned release is called. Resolves once the handle is held. */
function holdFromWindows(windows, file, share) {
  const script =
    `$f=[System.IO.File]::Open('${windows.toWindows(file)}','Open','Read','${share}');` + `Write-Output held; [Console]::In.ReadLine() | Out-Null; $f.Close()`;
  const child = spawn(windows.powershell, ['-NoProfile', '-Command', script], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.stdout.on('data', (chunk) => {
      if (String(chunk).includes('held')) {
        resolve(() => {
          child.stdin.end('\n');
          return new Promise((done) => child.on('exit', done));
        });
      }
    });
  });
}

/** Run test/helpers/platformChild.js with a JSON job; resolves with its exit and output. */
function runChild(job) {
  const child = spawn(process.execPath, [path.join(__dirname, 'platformChild.js'), JSON.stringify(job)], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += String(chunk);
  });
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code, signal) => resolve({ code, signal, lines: output.split('\n').filter(Boolean) }));
  });
}

module.exports = {
  holdFromWindows,
  protocolLeftovers,
  realHost,
  runChild,
  scratch,
  sha256,
  windowsFilesystem,
};
