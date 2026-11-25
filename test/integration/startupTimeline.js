// Goal: record where a cold start's time goes, in the packaged-like flow: the bundled renderer
// loaded from disk, a COPY of the fixture project (never a person's own), a private user-data
// directory, and the project reopened (or the start screen when --mode welcome).
//
// Method: `node test/integration/startupTimeline.js --dist <root> --label <name> [--mode project|welcome] [--runs N]`
// where <root> holds dist/{electron,shared,resources,renderer} and node_modules (the repository
// itself by default). Each run launches test/helpers/e2e/startupEntry.js, which writes a JSON
// report; this prints the median of each milestone over the runs. Opt in: this is a measurement,
// not a test, and it asserts nothing about wall-clock time (a budget lives in docs/startup.md).
// Numbers are milliseconds since the process began. Nothing here runs in CI.

const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { ROOT } = require('../helpers/sources.js');
const { cloneModules, copySite, removeWithRetries } = require('../helpers/e2e/soakLaunch.js');
const { RUN_DIRECTORY_PREFIX, stopRun, writeRegistry } = require('../helpers/e2e/soakProcesses.js');

const RUNS_MAX = 20;
const RUN_TIMEOUT_MS = 120000;

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : fallback;
}

function median(values) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((left, right) => left - right);
  return sorted.length === 0 ? undefined : sorted[Math.floor(sorted.length / 2)];
}

async function oneRun({ distRoot, mode }) {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), RUN_DIRECTORY_PREFIX));
  writeRegistry(directory);
  const userData = path.join(directory, 'user-data');
  const outFile = path.join(directory, 'report.json');
  fs.mkdirSync(userData, { recursive: true });
  const projectDirectory = path.join(directory, 'project');
  if (mode === 'project') {
    copySite(projectDirectory);
    cloneModules(projectDirectory);
  }
  const env = { ...process.env, ASTRO_TELEMETRY_DISABLED: '1', STACKI_SOAK_RUNNER_PID: String(process.pid) };
  delete env.ELECTRON_RUN_AS_NODE;
  env.STACKI_START_DIST = distRoot;
  env.STACKI_START_USER_DATA = userData;
  env.STACKI_START_OUT = outFile;
  env.STACKI_START_PROJECT = mode === 'project' ? projectDirectory : '';
  if (mode === 'project') {
    // main.js reopens a project only in development (a dev server URL is set); the bundled renderer is the page.
    env.VITE_DEV_SERVER_URL = pathToFileURL(path.join(distRoot, 'dist/renderer/index.html')).href;
  }
  const electron = require('electron');
  const code = await new Promise((resolve, reject) => {
    const child = childProcess.spawn(electron, [path.join(ROOT, 'test/helpers/e2e/startupEntry.js'), `--soak-run=${directory}`], {
      cwd: ROOT,
      env,
      stdio: 'inherit',
      detached: process.platform !== 'win32',
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), RUN_TIMEOUT_MS);
    child.on('error', reject);
    child.on('exit', (exitCode) => {
      clearTimeout(timer);
      resolve(exitCode ?? 1);
    });
  });
  try {
    if (code !== 0 || !fs.existsSync(outFile)) {
      throw new Error(`the run exited with ${code} and wrote no report`);
    }
    return JSON.parse(fs.readFileSync(outFile, 'utf8'));
  } finally {
    await stopRun(directory);
    await removeWithRetries(directory);
  }
}

function milestones(report) {
  const origin = report.rendererOriginMs;
  const main = new Map(report.main);
  const event = (name) => report.events.find(([label]) => label === name)?.[1];
  const mark = (name) => {
    const found = report.renderer.marks.find(([label]) => label === name);
    return found === undefined ? undefined : origin + found[1];
  };
  const paint = (name) => {
    const found = report.renderer.paints.find(([label]) => label === name);
    return found === undefined ? undefined : origin + found[1];
  };
  const probe = (name) => (report.renderer.probe[name] === undefined ? undefined : origin + report.renderer.probe[name]);
  const subFrames = report.events.filter(([label]) => label === 'subFrameLoaded').map(([, ms]) => ms);
  return {
    appReady: main.get('appReady'),
    windowCreated: main.get('windowCreated'),
    htmlLoading: main.get('rendererLoading'),
    windowShown: main.get('windowShown') ?? event('windowShow'),
    firstPaint: paint('first-paint'),
    firstContentfulPaint: paint('first-contentful-paint'),
    shellPainted: mark('stacki:shell-painted'),
    welcomeInDom: probe('welcome'),
    railRealInDom: probe('railReal'),
    projectReady: mark('stacki:project-ready'),
    firstCanvasFrame: subFrames[0],
    interactive: mark('stacki:interactive'),
    rendererLoaded: main.get('rendererLoaded'),
    longTaskMsTotal: report.renderer.longTasks.reduce((sum, [, duration]) => sum + duration, 0),
    longTaskCount: report.renderer.longTasks.length,
    entryBytes: report.renderer.resources.filter((resource) => resource.name.endsWith('.js')).reduce((sum, resource) => sum + resource.bytes, 0),
    skeletonsAtEnd: report.renderer.skeletons,
  };
}

(async () => {
  const distRoot = path.resolve(option('dist', ROOT));
  const label = option('label', 'run');
  const mode = option('mode', 'project');
  const runs = Math.min(Number(option('runs', '3')), RUNS_MAX);
  const reports = [];
  for (let run = 0; run < runs; run += 1) {
    reports.push(await oneRun({ distRoot, mode }));
  }
  const tables = reports.map(milestones);
  const names = Object.keys(tables[0]);
  console.log(`# startup timeline: ${label}, ${mode}, ${runs} runs, median ms since process start`);
  for (const name of names) {
    console.log(`${name.padEnd(24)} ${String(median(tables.map((table) => table[name])) ?? '-').padStart(8)}`);
  }
  const outDirectory = option('out', '');
  if (outDirectory !== '') {
    fs.mkdirSync(outDirectory, { recursive: true });
    fs.writeFileSync(path.join(outDirectory, `${label}-${mode}.json`), JSON.stringify(reports, null, 1), 'utf8');
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
