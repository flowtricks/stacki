import React from 'react';
import { createRoot } from 'react-dom/client';
import { assert } from '../shared/core/assert';
import App from './app/App';
import { mirrorLocalePreference } from './ipc/localeBridge';
import { LocaleProvider } from './lib/i18n/LocaleProvider';
import { runAfterFirstPaint } from './app/startupMarks';
import './app/styles.css';

const rootElement = document.getElementById('root');
assert(rootElement !== null, 'Renderer root element exists.');
document.documentElement.dataset['platform'] = window.avb.platform;
trackWindowZoom();

createRoot(rootElement).render(
  <LocaleProvider onPreference={mirrorLocalePreference}>
    <React.Suspense fallback={undefined}>
      <App />
    </React.Suspense>
  </LocaleProvider>,
);
runAfterFirstPaint();

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
