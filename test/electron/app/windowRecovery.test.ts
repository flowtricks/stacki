// Goal: whatever fails in the app window or the main process ends in something a person can see and act on, and the
// recovery screen is correct, safe and translated. The window is never left black.
// Method: the glue (windowRecovery.ts) runs against a fake window and a fake clock. Failures arrive as the events
// Electron sends; the test checks reload counts, that the recovery page is loaded after the allowance, that its three
// links are handled and cancel the navigation, that a hang is only restarted after the wait, and that the crash log
// is written. The page itself is rendered in all five locales and checked for escaping, its links and the absence of
// script. The process guards run against fake registrations, including an error that is not an Error.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { readCrashLog } from '#dist/electron/app/crashLog.js';
import { describeError, installProcessGuards, PROCESS_GUARD_LIMITS } from '#dist/electron/app/processGuards.js';
import { RECOVERY_ACTIONS, recoveryActionOf, recoveryPageUrl, renderRecoveryPage } from '#dist/electron/app/recoveryPage.js';
import { attachWindowRecovery } from '#dist/electron/app/windowRecovery.js';
import { WINDOW_HEALTH_LIMITS } from '#dist/electron/app/windowHealth.js';
import { MAIN_ENGLISH, loadMainLocale } from '#dist/electron/lib/mainLocale.js';

interface Fixture {
  readonly directory: string;
  readonly recovery: ReturnType<typeof attachWindowRecovery>;
  readonly calls: string[];
  readonly clock: { now: number; timers: Array<{ at: number; action: () => void; active: boolean }> };
  readonly advance: (ms: number) => void;
  readonly copied: string[];
}

function fixture(destroyed = false): Fixture {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-recovery-'));
  const calls: string[] = [];
  const copied: string[] = [];
  const clock: Fixture['clock'] = { now: 1_000_000, timers: [] };
  const recovery = attachWindowRecovery({
    contents: {
      reload: () => calls.push('reload'),
      loadURL: (url: string) => {
        calls.push(`load:${url.slice(0, 20)}`);
        calls.push(url);
        return Promise.resolve();
      },
      forcefullyCrashRenderer: () => calls.push('crash-renderer'),
      isDestroyed: () => destroyed,
    },
    directory,
    homeDirectory: undefined,
    now: () => clock.now,
    setTimer: (action, delayMs) => {
      const timer = { at: clock.now + delayMs, action, active: true };
      clock.timers.push(timer);
      return {
        cancel: () => {
          timer.active = false;
        },
      };
    },
    translate: () => MAIN_ENGLISH.translate,
    locale: () => 'en',
    loadApp: () => {
      calls.push('load-app');
      return Promise.resolve();
    },
    onRecoveryShown: () => calls.push('shown'),
    openProject: () => calls.push('open-project'),
    copyText: (text) => copied.push(text),
    log: () => {},
  });
  return {
    directory,
    recovery,
    calls,
    clock,
    copied,
    advance: (ms) => {
      clock.now += ms;
      for (const timer of clock.timers) {
        if (timer.active && timer.at <= clock.now) {
          timer.active = false;
          timer.action();
        }
      }
    },
  };
}

const GONE = { kind: 'renderer-gone', reason: 'crashed', exitCode: 5 } as const;

test('a crashed renderer is reloaded, then after the allowance the recovery page is loaded instead', () => {
  const world = fixture();
  try {
    for (let attempt = 0; attempt < WINDOW_HEALTH_LIMITS.reloadsMax; attempt++) {
      world.recovery.handle(GONE);
      world.advance(1_000);
    }
    assert.deepEqual(world.calls, ['reload', 'reload', 'reload']);
    world.recovery.handle(GONE);
    assert.ok(
      world.calls.some((call) => call.startsWith('load:data:text/html')),
      'the recovery page loads',
    );
    assert.equal(world.calls.filter((call) => call === 'reload').length, WINDOW_HEALTH_LIMITS.reloadsMax, 'and no further reload');
    const page = decodeURIComponent(
      world.calls.find((call) => call.startsWith('data:text/html;charset=utf-8,'))?.replace('data:text/html;charset=utf-8,', '') ?? '',
    );
    assert.match(page, /stopped unexpectedly \(crashed\)/);
    assert.match(page, /reloaded 3 times/);
    assert.match(page, /stacki-recovery:\/\/reload/);
  } finally {
    fs.rmSync(world.directory, { recursive: true, force: true });
  }
});

test('the failure is written to the crash log on disk', () => {
  const world = fixture();
  try {
    world.recovery.handle({ kind: 'load-failed', code: -6, description: 'ERR_FILE_NOT_FOUND', url: 'file:///app/index.html' });
    const stored = readCrashLog(world.directory);
    assert.equal(stored.length, 1);
    assert.equal(stored[0]?.source, 'load-failed');
    assert.match(stored[0]?.reason ?? '', /ERR_FILE_NOT_FOUND/);
    assert.equal(stored[0]?.detail, 'file:///app/index.html');
  } finally {
    fs.rmSync(world.directory, { recursive: true, force: true });
  }
});

test('a replaced navigation and a clean exit do nothing', () => {
  const world = fixture();
  try {
    world.recovery.handle({ kind: 'load-failed', code: -3, description: 'ERR_ABORTED', url: 'x' });
    world.recovery.handle({ kind: 'renderer-gone', reason: 'clean-exit', exitCode: 0 });
    assert.deepEqual(world.calls, []);
    assert.deepEqual(world.recovery.records(), []);
  } finally {
    fs.rmSync(world.directory, { recursive: true, force: true });
  }
});

test('a hang restarts the renderer only after the wait, and not when the window answers again first', () => {
  const world = fixture();
  try {
    world.recovery.handle({ kind: 'unresponsive' });
    world.advance(WINDOW_HEALTH_LIMITS.unresponsiveMsMax - 1);
    assert.deepEqual(world.calls, []);
    world.recovery.handle({ kind: 'responsive' });
    world.advance(WINDOW_HEALTH_LIMITS.unresponsiveMsMax * 2);
    assert.deepEqual(world.calls, [], 'a window that answered is left alone');
    world.recovery.handle({ kind: 'unresponsive' });
    world.advance(WINDOW_HEALTH_LIMITS.unresponsiveMsMax);
    assert.deepEqual(world.calls, ['crash-renderer']);
  } finally {
    fs.rmSync(world.directory, { recursive: true, force: true });
  }
});

test('the recovery links are handled, cancel the navigation, and Reload gives the window its allowance back', () => {
  const world = fixture();
  try {
    for (let attempt = 0; attempt <= WINDOW_HEALTH_LIMITS.reloadsMax; attempt++) {
      world.recovery.handle(GONE);
    }
    world.calls.length = 0;
    assert.equal(world.recovery.handleNavigation('stacki-recovery://open-project'), true);
    assert.equal(world.recovery.handleNavigation('stacki-recovery://copy-details'), true);
    assert.deepEqual(world.calls, ['open-project']);
    assert.match(world.copied[0] ?? '', /renderer-gone/);
    assert.equal(world.recovery.handleNavigation('stacki-recovery://reload'), true);
    assert.deepEqual(world.calls.slice(1), ['load-app']);
    world.recovery.handle(GONE);
    assert.equal(world.calls.at(-1), 'reload', 'a fresh allowance after the person reloaded');
    assert.equal(world.recovery.handleNavigation('https://example.com/'), false);
    assert.equal(world.recovery.handleNavigation('stacki-recovery://unknown'), false);
  } finally {
    fs.rmSync(world.directory, { recursive: true, force: true });
  }
});

test('a destroyed window is left alone', () => {
  const world = fixture(true);
  try {
    world.recovery.handle(GONE);
    assert.deepEqual(world.calls, []);
  } finally {
    fs.rmSync(world.directory, { recursive: true, force: true });
  }
});

test('recoveryActionOf names only the three recovery actions', () => {
  for (const action of RECOVERY_ACTIONS) {
    assert.equal(recoveryActionOf(`stacki-recovery://${action}`), action);
  }
  for (const other of ['', 'not a url', 'https://stacki-recovery//reload', 'stacki-recovery://reload/extra', 'file:///reload', 'javascript:alert(1)']) {
    assert.equal(recoveryActionOf(other), undefined, other);
  }
});

test('the recovery page is built in every language, escapes what it is given, and carries no script', async () => {
  for (const locale of ['en', 'de', 'es', 'fr', 'pt-BR'] as const) {
    const loaded = await loadMainLocale(locale);
    assert.equal(loaded.locale, locale);
    const html = renderRecoveryPage(
      { lang: locale, reason: { kind: 'load-failed', code: -2, description: '<b>"bad"</b>' }, details: 'trace </pre><script>alert(1)</script>' },
      loaded.translate,
    );
    assert.doesNotMatch(html, /<script/i, locale);
    assert.doesNotMatch(html, /<b>/, locale);
    assert.match(html, /&lt;b&gt;&quot;bad&quot;&lt;\/b&gt;/, locale);
    assert.match(html, /&lt;script&gt;alert\(1\)/, locale);
    assert.match(html, /default-src 'none'/);
    for (const action of RECOVERY_ACTIONS) {
      assert.match(html, new RegExp(`href="stacki-recovery://${action}"`), `${locale} ${action}`);
    }
    if (locale !== 'en') {
      assert.notEqual(loaded.translate('recovery.screen.reload'), MAIN_ENGLISH.translate('recovery.screen.reload'), `${locale} is translated, not English`);
    }
  }
  assert.ok(recoveryPageUrl('<p>ü</p>').startsWith('data:text/html;charset=utf-8,'));
});

test('the blue button has no grey hover and the page has no borders', () => {
  const html = renderRecoveryPage({ lang: 'en', reason: { kind: 'renderer-gone', reason: 'oom' }, details: '' }, MAIN_ENGLISH.translate);
  const hover = /a\.primary:hover \{([^}]*)\}/.exec(html)?.[1] ?? '';
  assert.match(hover, /background: #26a7ff/);
  assert.doesNotMatch(html, /border\s*:/);
});

test('process guards record an Error with its frames and a thrown string, and bound the frames', () => {
  const notes: Array<{ source: string; reason: string; detail: string }> = [];
  let uncaught: ((error: unknown) => void) | undefined;
  let rejected: ((reason: unknown) => void) | undefined;
  installProcessGuards({
    onUncaughtException: (listener) => {
      uncaught = listener;
    },
    onUnhandledRejection: (listener) => {
      rejected = listener;
    },
    note: (entry) => notes.push(entry),
    log: () => {},
  });
  const error = new Error('disk exploded');
  error.stack = ['Error: disk exploded', ...Array.from({ length: 40 }, (_, index) => `    at frame${index}`)].join('\n');
  uncaught?.(error);
  rejected?.('plain string');
  rejected?.({ code: 7 });
  rejected?.(undefined);
  assert.equal(notes.length, 4);
  assert.equal(notes[0]?.source, 'main-error');
  assert.match(notes[0]?.reason ?? '', /uncaught exception: disk exploded/);
  assert.equal(notes[0]?.detail.split('\n').length, PROCESS_GUARD_LIMITS.stackLinesMax - 1);
  assert.match(notes[1]?.reason ?? '', /unhandled rejection: plain string/);
  assert.match(notes[2]?.reason ?? '', /\{"code":7\}/);
  assert.match(notes[3]?.reason ?? '', /undefined/);
});

test('a guard whose recording throws does not throw', () => {
  let uncaught: ((error: unknown) => void) | undefined;
  installProcessGuards({
    onUncaughtException: (listener) => {
      uncaught = listener;
    },
    onUnhandledRejection: () => {},
    note: () => {
      throw new Error('log failed');
    },
    log: () => {},
  });
  assert.doesNotThrow(() => uncaught?.(new Error('x')));
  assert.equal(describeError(new Error('')).reason, 'Error');
});
