// Page performance for the Audits panel, measured without any login: the route
// loads from the project's own dev server in a hidden, sandboxed window with its
// own session (a cold cache, nothing shared with the canvas), and the page's own
// browser APIs report what happened: LCP and layout shifts (buffered
// PerformanceObserver), long tasks (observed from dom-ready), resource timing,
// and the images and fonts on the page. The report goes back as plain data; the
// renderer parses it at the boundary (shared/page/auditPerformance.ts).
//
// The window comes from main.ts through `openWindow`: handler modules import
// electron for its types alone (handlers/mainHost.ts says why).
import type { BrowserWindow, BrowserWindowConstructorOptions } from 'electron';
import { MEASUREMENT_LIMITS } from '../../shared/page/auditPerformance';

const SETTLE_MS = 2_500;
const VIEWPORT = { width: 1366, height: 900 } as const;

// Runs at dom-ready: long tasks are not buffered, so they are counted from here on.
const OBSERVE_LONG_TASKS = `(() => {
  window.__stackiLongTasks = [];
  try {
    new PerformanceObserver((list) => { for (const entry of list.getEntries()) { if (window.__stackiLongTasks.length < 500) window.__stackiLongTasks.push(entry.duration); } }).observe({ type: 'longtask', buffered: true });
  } catch {}
  return true;
})()`;

// Runs once the page has settled; returns plain data only, every list bounded.
const MEASURE = `(async () => {
  const marker = (element) => {
    for (let node = element; node; node = node.parentElement) {
      for (let sibling = node.previousSibling; sibling; sibling = sibling.previousSibling) {
        if (sibling.nodeType === 3 && !sibling.textContent.trim()) continue;
        if (sibling.nodeType === 8) { if (sibling.data.startsWith('avb-s:')) return sibling.data; continue; }
        break;
      }
    }
    return '';
  };
  const describe = (element) => element ? { tag: element.tagName, marker: marker(element), label: (element.getAttribute('src') || element.textContent || '').trim().slice(0, 120) } : undefined;
  const buffered = (type) => new Promise((resolve) => {
    try {
      const found = [];
      const observer = new PerformanceObserver((list) => found.push(...list.getEntries()));
      observer.observe({ type, buffered: true });
      setTimeout(() => { observer.disconnect(); resolve(found); }, 300);
    } catch { resolve([]); }
  });
  const lcp = (await buffered('largest-contentful-paint')).at(-1);
  const shifts = (await buffered('layout-shift')).filter((entry) => !entry.hadRecentInput);
  const cls = shifts.reduce((total, entry) => total + entry.value, 0);
  const shiftNodes = shifts.flatMap((entry) => (entry.sources || []).map((source) => source.node)).filter((node) => node && node.nodeType === 1).slice(0, ${MEASUREMENT_LIMITS.shiftsMax});
  const tbt = (window.__stackiLongTasks || []).reduce((total, duration) => total + Math.max(0, duration - 50), 0);
  const navigation = performance.getEntriesByType('navigation')[0];
  const resources = performance.getEntriesByType('resource');
  const origin = location.origin;
  const transfer = resources.reduce((total, entry) => total + (entry.transferSize || entry.encodedBodySize || 0), navigation ? navigation.transferSize || navigation.encodedBodySize || 0 : 0);
  const blocking = resources.filter((entry) => entry.renderBlockingStatus === 'blocking').map((entry) => entry.name).slice(0, ${MEASUREMENT_LIMITS.resourcesMax});
  const thirdParty = resources.filter((entry) => entry.initiatorType === 'script' && !entry.name.startsWith(origin)).map((entry) => entry.name).slice(0, ${MEASUREMENT_LIMITS.resourcesMax});
  const images = [...document.images].slice(0, ${MEASUREMENT_LIMITS.imagesMax}).map((image) => {
    const box = image.getBoundingClientRect();
    return {
      element: describe(image),
      url: image.currentSrc || image.src || '',
      naturalWidth: image.naturalWidth || 0,
      naturalHeight: image.naturalHeight || 0,
      displayWidth: box.width,
      displayHeight: box.height,
      belowFold: box.top > innerHeight,
      loading: image.getAttribute('loading') || '',
      fetchPriority: image.getAttribute('fetchpriority') || '',
    };
  });
  const fonts = [];
  for (const sheet of [...document.styleSheets]) {
    let rules;
    try { rules = sheet.cssRules; } catch { continue; }
    for (const rule of [...rules]) {
      if (rule instanceof CSSFontFaceRule && !rule.style.getPropertyValue('font-display') && fonts.length < ${MEASUREMENT_LIMITS.fontsMax}) {
        fonts.push(rule.style.getPropertyValue('font-family').replace(/["']/g, '').trim());
      }
    }
  }
  return {
    lcpMs: lcp ? lcp.startTime : undefined,
    lcpElement: lcp ? describe(lcp.element) : undefined,
    cls,
    shifts: shiftNodes.map(describe),
    tbtMs: tbt,
    transferBytes: transfer,
    requests: resources.length + 1,
    blocking,
    thirdParty,
    images,
    fontsWithoutDisplay: [...new Set(fonts)],
    devicePixelRatio: devicePixelRatio || 1,
  };
})()`;

/** Makes the hidden window a measurement runs in. */
export type OpenMeasureWindow = (options: BrowserWindowConstructorOptions) => BrowserWindow;

/** One route measured; the report is plain data, or a message when the page would not load. */
export async function measurePage(
  url: string,
  openWindow: OpenMeasureWindow,
): Promise<{ readonly ok: true; readonly measurement: unknown } | { readonly ok: false; readonly message: string }> {
  const window = openWindow({
    show: false,
    // Paint while hidden: LCP and layout shifts are only reported for a page that paints.
    paintWhenInitiallyHidden: true,
    width: VIEWPORT.width,
    height: VIEWPORT.height,
    useContentSize: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, partition: 'stacki-audit-measure' },
  });
  const timer = setTimeout(() => window.destroy(), MEASUREMENT_LIMITS.pageMsMax);
  try {
    window.webContents.once('dom-ready', () => {
      void window.webContents.executeJavaScript(OBSERVE_LONG_TASKS).catch(() => undefined);
    });
    await window.loadURL(url);
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
    const measurement: unknown = await window.webContents.executeJavaScript(MEASURE, true);
    return { ok: true, measurement };
  } catch (error: unknown) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
    if (!window.isDestroyed()) {
      window.destroy();
    }
  }
}
