const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { BrowserWindow } = require('electron');

// The picture of a project on the start screen.
//
// It used to be a photograph of the app: capturePage over the region where the
// canvas iframe sat. That takes a picture of whatever the editor happened to be
// showing — the page you left off on, scrolled to wherever you left it, with
// any panel that was open over the canvas in the shot. A thumbnail is supposed
// to say "this is the site", and that one said "this is what you were doing".
//
// So nothing is photographed through the app any more. The project's home page
// is loaded into a window of its own, off screen, at a fixed desktop size, and
// the top of it is captured: the hero, at the top of the page, at a size that
// matches what the site is designed for, with no editor chrome in the frame
// because there is no editor in the window.

const VIEWPORT = { width: 1440, height: 900 };
const THUMB_WIDTH = 720;
// Long enough for fonts, hero video posters and entrance animations to land —
// a hero whose headline animates in letter by letter is halfway through it at a
// second. Short enough that a project that never settles (a rotator, a marquee)
// still gets its picture taken.
const SETTLE_MS = 1800;
const LOAD_TIMEOUT = 15000;

const thumbsDir = (userDataPath) => path.join(userDataPath, 'thumbs');
const keyFor = (projectPath) => crypto.createHash('sha1').update(projectPath).digest('hex').slice(0, 16);
const thumbPathFor = (userDataPath, projectPath) =>
  path.join(thumbsDir(userDataPath), `${keyFor(projectPath)}.png`);
const metaPathFor = (userDataPath, projectPath) =>
  path.join(thumbsDir(userDataPath), `${keyFor(projectPath)}.json`);

// What the site is made of, as one number that changes when any of it does.
// Only the directories a page can be built from — a thumbnail does not go stale
// because node_modules changed, and walking it would cost more than the
// screenshot.
const SOURCE_DIRS = ['src', 'public'];
const SKIP = new Set(['node_modules', 'dist', '.git', '.astro', '.stacki', '.vercel', '.netlify']);

function fingerprint(projectPath) {
  let newest = 0;
  let count = 0;
  const walk = (dir, depth) => {
    if (depth > 8) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || SKIP.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      try {
        const stat = fs.statSync(full);
        count++;
        if (stat.mtimeMs > newest) newest = stat.mtimeMs;
      } catch {
        /* raced with a write */
      }
    }
  };
  for (const dir of SOURCE_DIRS) walk(path.join(projectPath, dir), 0);
  // Config decides what the pages are, so it counts too.
  for (const name of ['astro.config.mjs', 'astro.config.ts', 'astro.config.js', 'package.json']) {
    try {
      const stat = fs.statSync(path.join(projectPath, name));
      count++;
      if (stat.mtimeMs > newest) newest = stat.mtimeMs;
    } catch {
      /* not there */
    }
  }
  return `${count}:${Math.round(newest)}`;
}

function readMeta(userDataPath, projectPath) {
  try {
    return JSON.parse(fs.readFileSync(metaPathFor(userDataPath, projectPath), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * True when the site has changed since its picture was taken — including
 * changes made with the app closed, which is most of them.
 */
function isStale(userDataPath, projectPath) {
  const meta = readMeta(userDataPath, projectPath);
  if (!meta) return true;
  return meta.fingerprint !== fingerprint(projectPath);
}

function readThumb(userDataPath, projectPath) {
  try {
    const data = fs.readFileSync(thumbPathFor(userDataPath, projectPath));
    return 'data:image/png;base64,' + data.toString('base64');
  } catch {
    return null;
  }
}

function forget(userDataPath, projectPath) {
  try {
    fs.rmSync(thumbPathFor(userDataPath, projectPath), { force: true });
    fs.rmSync(metaPathFor(userDataPath, projectPath), { force: true });
  } catch {
    /* non-fatal */
  }
}

// The window the page is rendered in. No preload, no node, nothing of the app:
// this is a browser showing a website, and it should behave like one — the page
// is the real page, not the marked-up one the canvas edits.
function makeWindow() {
  return new BrowserWindow({
    show: false,
    width: VIEWPORT.width,
    height: VIEWPORT.height,
    useContentSize: true,
    backgroundColor: '#ffffff',
    webPreferences: {
      // Hidden windows still paint with this, which is what capturePage needs.
      paintWhenInitiallyHidden: true,
      offscreen: false,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      backgroundThrottling: false,
      images: true,
    },
  });
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Renders `url` and stores the top of the page as this project's thumbnail.
 * Returns { ok } or { ok: false, error } — a thumbnail is never worth throwing
 * over, so every failure comes back as a value and the old picture stays.
 */
async function capture(userDataPath, projectPath, url) {
  let win = null;
  try {
    win = makeWindow();
    const loaded = new Promise((resolve, reject) => {
      const done = () => resolve();
      win.webContents.once('did-finish-load', done);
      win.webContents.once('did-fail-load', (_e, code, description) =>
        reject(new Error(`${description || 'load failed'} (${code})`))
      );
      setTimeout(() => reject(new Error('the page did not finish loading')), LOAD_TIMEOUT);
    });
    // A load that fails does so during loadURL below, before anything awaits
    // this — which node reports as an unhandled rejection even though the
    // await two lines down handles it. Claim it now; the await still sees it.
    loaded.catch(() => {});
    await win.loadURL(url).catch(() => {});
    await loaded;

    // Wait for the things that arrive after the load event and change what the
    // hero looks like, then put the page back at the top: a fragment in the
    // URL, a restored scroll position or a script's own scrollTo would
    // otherwise photograph the middle of the page — which is the bug this
    // replaces.
    await win.webContents
      .executeJavaScript(
        `(async () => {
           try { await document.fonts.ready; } catch {}
           window.scrollTo(0, 0);
           return document.title || '';
         })()`,
        true
      )
      .catch(() => '');
    await wait(SETTLE_MS);

    // Back to the top, and stay there until it has been painted. Two things
    // make this more than one line: a page with smooth scrolling animates to
    // the top rather than jumping (so the capture catches it halfway), and a
    // scroll that has been applied has not necessarily been drawn — the
    // compositor paints on the next frame, and capturePage photographs
    // whatever is on screen now.
    await win.webContents
      .executeJavaScript(
        `new Promise((done) => {
           document.documentElement.style.scrollBehavior = 'auto';
           window.scrollTo(0, 0);
           requestAnimationFrame(() => requestAnimationFrame(() => done(true)));
         })`,
        true
      )
      .catch(() => {});
    await wait(150);

    const image = await win.webContents.capturePage({
      x: 0,
      y: 0,
      width: VIEWPORT.width,
      height: VIEWPORT.height,
    });
    if (image.isEmpty()) return { ok: false, error: 'the capture came back empty' };

    fs.mkdirSync(thumbsDir(userDataPath), { recursive: true });
    fs.writeFileSync(thumbPathFor(userDataPath, projectPath), image.resize({ width: THUMB_WIDTH }).toPNG());
    fs.writeFileSync(
      metaPathFor(userDataPath, projectPath),
      JSON.stringify({ fingerprint: fingerprint(projectPath), capturedAt: Date.now(), url }, null, 2)
    );
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  } finally {
    try {
      if (win && !win.isDestroyed()) win.destroy();
    } catch {
      /* already gone */
    }
  }
}

module.exports = {
  capture,
  fingerprint,
  isStale,
  readMeta,
  readThumb,
  forget,
  thumbPathFor,
  VIEWPORT,
};
