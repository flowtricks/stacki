import fs from 'fs';
import path from 'path';
import type { BrowserWindow } from 'electron';
import { COMPONENT_SHOT_LIMITS, type ComponentShot } from '../../shared/properties/componentShots';
import { readSource } from '../lib/mainLimits';
import { isPathDescendant } from '../lib/platform';
import { toPosix } from '../lib/mainHelpers';
import { resolveImportPath } from '../properties/importPaths';
import {
  assignShots,
  callSitesOf,
  collectAnchorRegionsExpression,
  collectEmptyAnchorsExpression,
  collectLinksExpression,
  hiddenComponents,
  hideOutsideScript,
  parseAnchorPaths,
  parseAnchorRegions,
  parseLinks,
  pickDynamicPages,
  sameOriginPaths,
  SHOW_FIXED,
  shotHeight,
  type AnchorRegion,
  type CallSites,
  type ShotAssignment,
  type ShotPage,
} from './componentShotPlan';
import { pruneShotImages, readShotMeta, shotFileName, writeShotImage, writeShotMeta } from '../project/componentShotStore';
import { captureImage, fingerprint, makeWindow, wait, within } from '../project/thumbs';

// One run: load each page of the project in a hidden window, find the first instance of every
// component that has none yet, and photograph that spot. The window is the one thumbs.ts makes
// (no preload, sandboxed, never shown); it is resized to each region, because a section that sizes
// itself to the viewport must be measured at the size it is photographed at.

const WINDOW_HEIGHT = 900;
const FRAME_SETTLE_MS = 150;
// What the page may not show: the dev server's own furniture and the skip link a keyboard user
// sees on focus. Hidden with a stylesheet because none of it belongs to a component.
// The scrollbar is the window's, not the page's, and would otherwise stand in every picture.
const HIDE_FURNITURE =
  '.skip-link, astro-dev-toolbar, vite-error-overlay { display: none !important; } html { scroll-behavior: auto !important; scrollbar-width: none !important; } ::-webkit-scrollbar { display: none !important; }';
const PREPARE_TIMEOUT_MS = 3000;
// One script in a page may take this long. A page whose main thread is blocked never answers, and an
// unlimited wait would hold the run, and the queue behind it, for good.
const SCRIPT_TIMEOUT_MS = 5000;

const evaluate = (win: BrowserWindow, code: string): Promise<unknown> =>
  within(win.webContents.executeJavaScript(code, true), SCRIPT_TIMEOUT_MS, 'a script in the page did not answer');

export interface ShotRun {
  readonly projectPath: string;
  readonly userDataPath: string;
  readonly devUrl: string;
  readonly trailingSlash: string;
  readonly pages: readonly ShotPage[];
  /** Pages behind dynamic routes: each is loaded once, at an address found by following links from the pages above. */
  readonly dynamicPages: readonly ShotPage[];
  /** False once the run should stop: the project closed, another opened, or the app is quitting. */
  readonly isCurrent: () => boolean;
  /** Called after each page, when new pictures are stored. */
  readonly onProgress: () => void;
}

export type ShotRunResult = { readonly ok: true; readonly shots: number } | { readonly ok: false; readonly error: string };

export async function runComponentShots(run: ShotRun): Promise<ShotRunResult> {
  const startedFingerprint = fingerprint(run.projectPath);
  const previous = readShotMeta(run.userDataPath, run.projectPath);
  // Photographs made in this run. The old ones stand in `kept` until a run completes without a failed
  // page; then only these are kept, so a component that left every page loses its picture.
  const fresh = new Map<string, ComponentShot>();
  const kept = new Map<string, ComponentShot>();
  for (const shot of previous?.shots ?? []) {
    if (fs.existsSync(shot.component)) {
      kept.set(shot.component, shot);
    }
  }
  const taken = new Set<string>();
  const sites = new CallSiteCache(run.projectPath);
  const wanted = (component: string): boolean => isPathDescendant(path.join(run.projectPath, 'src', 'components'), component);
  const deadline = Date.now() + COMPONENT_SHOT_LIMITS.runTimeoutMs;
  const store = (fingerprintValue: string, shots: ReadonlyMap<string, ComponentShot>): void => {
    writeShotMeta(run.userDataPath, run.projectPath, {
      version: 1,
      fingerprint: fingerprintValue,
      capturedAt: Date.now(),
      shots: [...shots.values()].slice(0, COMPONENT_SHOT_LIMITS.componentsMax),
    });
  };
  const context: PageContext = { run, sites, taken, kept, fresh, wanted };
  const links = new Set<string>();
  // Pages with components that took no room at the desktop width, for the narrower look after all pages.
  const hiddenOn: Array<{ readonly page: ShotPage; readonly hidden: ReadonlySet<string> }> = [];
  let failedPages = 0;
  const progress = (made: number): void => {
    if (made > 0) {
      store(previous?.fingerprint ?? '', kept);
      run.onProgress();
    }
  };
  const stopped = (): ShotRunResult | undefined => {
    if (!run.isCurrent()) {
      return { ok: false, error: 'skipped' };
    }
    // Out of time is a failure, not a skip: a skip is tried again, and a project that always runs
    // out of time would then start a full run every time the palette opens.
    return Date.now() > deadline ? { ok: false, error: 'the run took longer than its time limit' } : undefined;
  };
  const visit = async (page: ShotPage): Promise<ShotRunResult | undefined> => {
    const halt = stopped();
    if (halt !== undefined) {
      return halt;
    }
    const first = await shootPage(context, page, { width: COMPONENT_SHOT_LIMITS.widthPx });
    for (const link of first.links) {
      if (links.size < COMPONENT_SHOT_LIMITS.linksMax) {
        links.add(link);
      }
    }
    if (first.hidden.size > 0) {
      hiddenOn.push({ page, hidden: first.hidden });
    }
    failedPages += first.failed ? 1 : 0;
    progress(first.made);
    return undefined;
  };
  try {
    for (const page of run.pages) {
      const halt = await visit(page);
      if (halt !== undefined) {
        return halt;
      }
    }
    // Dynamic routes have no address of their own; the links the pages above carry supply one each.
    const fixedRoutes = new Set(run.pages.map((page) => page.route));
    const budget = Math.max(0, COMPONENT_SHOT_LIMITS.pagesMax - run.pages.length);
    for (const page of pickDynamicPages(run.dynamicPages, [...links], fixedRoutes, budget)) {
      const halt = await visit(page);
      if (halt !== undefined) {
        return halt;
      }
    }
    // The narrower look comes last, so a component hidden at 1440 px on one page but shown on a later
    // one keeps the wider picture, and one hidden everywhere is tried once.
    const tried = new Set<string>();
    for (const { page, hidden } of hiddenOn) {
      const only = new Set([...hidden].filter((component) => !taken.has(component) && !tried.has(component)));
      if (only.size === 0) {
        continue;
      }
      for (const component of only) {
        tried.add(component);
      }
      const halt = stopped();
      if (halt !== undefined) {
        return halt;
      }
      const narrow = await shootPage(context, page, { width: COMPONENT_SHOT_LIMITS.narrowWidthPx, only });
      failedPages += narrow.failed ? 1 : 0;
      progress(narrow.made);
    }
    if (failedPages > 0) {
      // Old pictures stay and the old fingerprint with them, so a later start of the app tries again.
      store(previous?.fingerprint ?? '', kept);
      run.onProgress();
      return { ok: false, error: `${failedPages} page look${failedPages === 1 ? '' : 's'} failed` };
    }
    store(startedFingerprint, fresh);
    pruneShotImages(run.userDataPath, run.projectPath, { version: 1, fingerprint: startedFingerprint, capturedAt: 0, shots: [...fresh.values()] });
    run.onProgress();
    return { ok: true, shots: fresh.size };
  } catch (error: unknown) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Source files parsed for their call sites, once each per run. */
class CallSiteCache {
  private readonly cache = new Map<string, CallSites>();
  constructor(private readonly projectPath: string) {}

  /** `file` is a project-relative path, as the anchors name it. */
  get(file: string): CallSites | undefined {
    const known = this.cache.get(file);
    if (known !== undefined) {
      return known;
    }
    if (this.cache.size >= COMPONENT_SHOT_LIMITS.filesParsedMax) {
      return undefined;
    }
    const absolute = path.join(this.projectPath, file);
    let sites: CallSites;
    try {
      sites = callSitesOf(readSource(absolute), (specifier) => resolveImportPath(this.projectPath, absolute, specifier));
    } catch {
      sites = new Map();
    }
    this.cache.set(file, sites);
    return sites;
  }
}

interface PageContext {
  readonly run: ShotRun;
  readonly sites: CallSiteCache;
  readonly taken: Set<string>;
  /** Old pictures and new ones: what is stored while a run is under way. */
  readonly kept: Map<string, ComponentShot>;
  /** The pictures this run made. */
  readonly fresh: Map<string, ComponentShot>;
  readonly wanted: (component: string) => boolean;
}

/** How a page is looked at: the window's width, and for a second look the only components worth photographing. */
interface PageView {
  readonly width: number;
  readonly only?: ReadonlySet<string>;
}

interface PageResult {
  readonly made: number;
  /** Addresses the page links to; read on the first look only. */
  readonly links: readonly string[];
  /** Components on the page that took no room at this width and have no photograph. */
  readonly hidden: ReadonlySet<string>;
  /** The page did not load or answer, or a photograph timed out: the run is not complete. */
  readonly failed: boolean;
}

async function shootPage(context: PageContext, page: ShotPage, view: PageView): Promise<PageResult> {
  const { run, sites, taken, kept, fresh } = context;
  const only = view.only;
  const wanted = (component: string): boolean => context.wanted(component) && (only === undefined || only.has(component));
  let win: BrowserWindow | undefined = undefined;
  try {
    win = makeWindow({ width: view.width, height: WINDOW_HEIGHT });
    win.webContents.setAudioMuted(true);
    await prepareWindow(win);
    await within(win.loadURL(pageURL(run, page)), COMPONENT_SHOT_LIMITS.pageLoadTimeoutMs, 'the page did not finish loading');
    await within(win.webContents.insertCSS(HIDE_FURNITURE), SCRIPT_TIMEOUT_MS, 'the page did not take the stylesheet');
    await evaluate(win, 'document.fonts ? document.fonts.ready.then(() => true) : true').catch(() => false);
    await wait(COMPONENT_SHOT_LIMITS.settleMs);
    const regions = parseAnchorRegions(await evaluate(win, collectAnchorRegionsExpression()));
    const pageFile = toPosix(path.relative(run.projectPath, page.path));
    const emptyPaths = only === undefined ? parseAnchorPaths(await evaluate(win, collectEmptyAnchorsExpression())) : [];
    const links = only === undefined ? sameOriginPaths(parseLinks(await evaluate(win, collectLinksExpression()).catch(() => [])), run.devUrl) : [];
    const assignments = assignShots(regions, pageFile, taken, (file) => sites.get(file), wanted);
    let made = 0;
    let failed = false;
    for (const assignment of assignments) {
      if (!run.isCurrent()) {
        break;
      }
      let shot: Awaited<ReturnType<typeof photograph>>;
      try {
        shot = await within(photograph(win, assignment, view.width), COMPONENT_SHOT_LIMITS.shotTimeoutMs, 'the photograph did not finish');
      } catch (error: unknown) {
        // The work behind a timeout is still running in this window and could write into the next
        // photograph, so the page ends here and the window with it. Its other components wait for a later run.
        console.warn(
          `[component-shots] ${page.route}: stopped at ${path.basename(assignment.component)}:`,
          error instanceof Error ? error.message : String(error),
        );
        failed = true;
        break;
      }
      if (shot === undefined) {
        console.warn(`[component-shots] ${page.route}: no photograph of ${path.basename(assignment.component)}`);
        continue;
      }
      const file = shotFileName(assignment.component);
      writeShotImage(run.userDataPath, run.projectPath, file, shot.bytes);
      const entry = { component: assignment.component, file, width: shot.width, height: shot.height };
      kept.set(assignment.component, entry);
      fresh.set(assignment.component, entry);
      taken.add(assignment.component);
      made += 1;
    }
    const hidden = only === undefined ? hiddenComponents(emptyPaths, pageFile, taken, (file) => sites.get(file), context.wanted) : new Set<string>();
    return { made, links, hidden, failed };
  } catch (error: unknown) {
    // One page failing to load or answer must not cost the others; the log says which.
    console.warn(`[component-shots] ${page.route} at ${view.width}px: page skipped:`, error instanceof Error ? error.message : String(error));
    return { made: 0, links: [], hidden: new Set<string>(), failed: true };
  } finally {
    if (win !== undefined && !win.isDestroyed()) {
      win.destroy();
    }
  }
}

/** Reduced motion, so entrance animations are finished; best effort, since it needs the debugger protocol. */
async function prepareWindow(win: BrowserWindow): Promise<void> {
  // A window that has never loaded anything has no page target yet, and the command then never
  // answers: a blank page first, and a time limit, so the run cannot stall here.
  try {
    await within(win.loadURL('about:blank'), PREPARE_TIMEOUT_MS, 'the blank page did not load');
    win.webContents.debugger.attach('1.3');
    await within(
      win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] }),
      PREPARE_TIMEOUT_MS,
      'reduced motion did not apply',
    );
  } catch {
    /* the pictures are taken without it */
  }
}

function pageURL(run: ShotRun, page: ShotPage): string {
  const route = run.trailingSlash === 'always' && !page.route.endsWith('/') ? page.route + '/' : page.route;
  // The marker hash keeps the editor's comments in the page, which is where the regions come from.
  return new URL(route, run.devUrl.endsWith('/') ? run.devUrl : run.devUrl + '/').href + '#avb-design';
}

async function photograph(
  win: BrowserWindow,
  assignment: ShotAssignment,
  viewWidth: number,
): Promise<{ readonly bytes: Uint8Array; readonly width: number; readonly height: number } | undefined> {
  const height = shotHeight(assignment.region);
  win.setContentSize(viewWidth, Math.max(height, 100));
  await frames(win);
  // Before measuring: a sticky wrapper still stuck from the previous photograph would give the wrong top.
  await evaluate(win, hideOutsideScript(assignment.region.path));
  try {
    // Measured again at the size it is photographed at: a hero that is 100vh tall changed with the window.
    const regions = parseAnchorRegions(await evaluate(win, collectAnchorRegionsExpression()));
    const region: AnchorRegion | undefined = regions.find((candidate) => candidate.path === assignment.region.path);
    if (region === undefined) {
      return undefined;
    }
    const shown = shotHeight(region);
    const scrolled: unknown = await evaluate(
      win,
      `(window.scrollTo(0, ${Math.floor(region.top)}), new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(window.scrollY)))))`,
    );
    const scrollY = typeof scrolled === 'number' && Number.isFinite(scrolled) ? scrolled : 0;
    await wait(FRAME_SETTLE_MS);
    const offset = Math.max(0, Math.ceil(region.top - scrollY));
    const view = win.getContentSize()[1] ?? height;
    const captureHeight = Math.min(shown, Math.max(1, view - offset));
    // Only the component's own columns: a button photographed across the whole page width is a speck
    // in a band of page. Sections span the page, so for them this is the full width anyway.
    const left = Math.min(viewWidth - 1, Math.max(0, Math.floor(region.left)));
    const width = Math.max(1, Math.min(viewWidth - left, Math.ceil(region.left + region.width) - left));
    const captured = await captureImage(win.webContents, { x: left, y: offset, width, height: captureHeight });
    if (!captured.ok || captured.value.isEmpty()) {
      return undefined;
    }
    const image = captured.value.getSize().width > viewWidth ? captured.value.resize({ width: viewWidth }) : captured.value;
    // `width` stays in logical pixels, the scale the card draws at; the bytes may be denser.
    return { bytes: image.toJPEG(COMPONENT_SHOT_LIMITS.jpegQuality), width, height: captureHeight };
  } finally {
    await evaluate(win, SHOW_FIXED).catch(() => false);
  }
}

const frames = (win: BrowserWindow): Promise<unknown> =>
  evaluate(win, 'new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(true))))').then(() => wait(FRAME_SETTLE_MS));
