import React from 'react';
import { createRoot } from 'react-dom/client';
import { assert } from '../shared/core/assert';
import App from './app/App';
import { AppBoundary } from './app/recovery/AppBoundary';
import { mirrorLocalePreference } from './ipc/localeBridge';
import { LocaleProvider } from './lib/i18n/LocaleProvider';
import { runAfterFirstPaint } from './app/startupMarks';
import { bootSeed } from './lib/bootSeed';
import { loadShell } from './app/shell/lazyShell';
import './app/styles.css';
// The design tokens are app-wide (:root): shared controls drawn outside the Style panel read them too.
import './features/style/tokens.css';

const rootElement = document.getElementById('root');
assert(rootElement !== null, 'Renderer root element exists.');
document.documentElement.dataset['platform'] = window.avb.platform;
trackWindowZoom();

// A window that opens a project renders the project's real shell in its first frame, so its chunk is awaited
// first (nothing is drawn meanwhile: the window is still hidden, main shows it on the first real frame). A start
// screen needs nothing awaited. A chunk that fails to load must not leave a blank window: render anyway, and the
// app's own lazy boundary reports the failure.
const shellReady =
  bootSeed().project === undefined
    ? Promise.resolve(undefined)
    : loadShell().then(
        () => undefined,
        () => undefined,
      );
void shellReady.then(() => {
  createRoot(rootElement).render(
    <LocaleProvider onPreference={mirrorLocalePreference}>
      <AppBoundary>
        <React.Suspense fallback={undefined}>
          <App />
        </React.Suspense>
      </AppBoundary>
    </LocaleProvider>,
  );
  runAfterFirstPaint();
});

// The page zoom (⌘+ / ⌘−), as `--window-zoom`. The window's own buttons are drawn
// by the system and never zoom, so space kept clear for them is divided by it
// (styles.css .titlebar). The window's outer width is in screen points and its
// inner width in CSS pixels, so their ratio is the zoom.
function trackWindowZoom(): void {
  const update = () => {
    const zoom = window.outerWidth / window.innerWidth;
    const bounded = Number.isFinite(zoom) && zoom > 0 ? Math.min(Math.max(zoom, 0.25), 5) : 1;
    assert(bounded >= 0.25, 'A window zoom stays within Electron’s range');
    document.documentElement.style.setProperty('--window-zoom', bounded.toFixed(3));
  };
  update();
  window.addEventListener('resize', update);
}
