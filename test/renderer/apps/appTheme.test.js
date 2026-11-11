// Goal: an app hears the editor's theme. `ui.theme` answers the theme and every
// design token's value, exactly the UI kit's; `theme.change` reaches the apps
// that subscribed to it, and only those the role lets run; the follower behind
// AppsHost's theme events (appTheme.ts) calls once per change and never for an
// unchanged theme; and in a page, the SDK and the kit's script (`__stacki/ui.js`)
// set the theme on the app's root at start and again on each `theme.change`,
// while the kit's custom elements render the editor's own components.
// Method: the real dispatcher (appRpcHost.ts), the theme module and the shared
// kit through the renderer bundler; the page is a jsdom window running the SDK
// and ui.js as served, whose requests to its parent reach the real dispatcher
// and whose answers and events come back as message events.
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const load = require('../../helpers/rendererModule');

const rpc = load('src/features/apps/appRpcHost.ts');
const theme = load('src/features/apps/appTheme.ts');
const kit = load('shared/properties/appUiKit.ts');
const sdk = load('shared/properties/appSdk.ts');
const roles = load('shared/properties/projectRoles.ts');

const app = (id) => ({
  manifest: { manifestVersion: 1, id, name: id, version: '1.0.0', description: '', icon: undefined, entry: 'index.html', window: { mode: 'panel' } },
  lock: { id, version: '1.0.0', sha256: 'a'.repeat(64), installedAt: '2026-11-10T00:00:00Z', source: { kind: 'file', fileName: 'a.zip' }, update: undefined },
});
const session = (id) => ({ app: app(id), subscriptions: new Set(), ...rpc.inFlightCounter() });
const context = (role = roles.ADMIN_VIEW) => ({ host: {}, role: () => role, setOverlay: () => undefined });
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

test('ui.theme answers the theme and every token, as the kit has them', async () => {
  const answer = await rpc.answerAppMessage(session('pins'), { stacki: 'app', v: 1, id: 1, method: 'ui.theme' }, context());
  assert.equal(answer.ok, true, JSON.stringify(answer.error));
  assert.deepEqual(answer.value, kit.appThemeView('dark'));
  assert.equal(answer.value.tokens.accent, '#0099ff');
  assert.equal(answer.value.tokens['bg-panel'], '#111111');
});

test('theme.change reaches subscribers the role lets run, and no one else', () => {
  const view = kit.appThemeView('dark');
  const listening = session('pins');
  listening.subscriptions.add('theme.change');
  const deaf = session('outline');
  const message = rpc.eventForSession(listening, roles.ADMIN_VIEW, 'theme.change', view);
  assert.deepEqual(message, { stacki: 'host', v: 1, event: 'theme.change', data: view });
  assert.equal(rpc.eventForSession(deaf, roles.ADMIN_VIEW, 'theme.change', view), undefined, 'not subscribed');
  const without = { id: 'client', name: 'Client', isAdmin: false, features: new Set(['panel:apps']) };
  assert.equal(rpc.eventForSession(listening, without, 'theme.change', view), undefined, 'the role may not use the app');
});

test('the theme follower calls once per change, never for the same theme', () => {
  const dark = kit.appThemeView('dark');
  // A second theme, as the follower would see one: the kit has only dark today.
  const light = { ...dark, theme: 'light' };
  let current = dark;
  const heard = [];
  const follower = theme.createThemeFollower(
    () => current,
    (view) => heard.push(view.theme),
  );
  follower.check();
  assert.deepEqual(heard, [], 'no change, no event');
  current = light;
  follower.check();
  follower.check();
  current = dark;
  follower.check();
  assert.deepEqual(heard, ['light', 'dark']);
  assert.equal(theme.currentAppTheme().theme, 'dark', 'the editor without a data-theme is dark');
});

test('in a page, the kit script sets the theme at start and on theme.change, and upgrades its elements', async () => {
  const dom = new JSDOM(
    '<!doctype html><html><head></head><body><stacki-switch label="Pins" checked></stacki-switch>' +
      '<stacki-tabs value="b"><button value="a">A</button><button value="b">B</button></stacki-tabs>' +
      '<stacki-dropdown value="two" placeholder="Choose"><option value="one">One</option><option value="two">Two</option></stacki-dropdown></body></html>',
    { runScripts: 'outside-only', pretendToBeVisual: true },
  );
  const { window } = dom;
  const one = session('pins');
  const deliver = (data) => window.dispatchEvent(new window.MessageEvent('message', { data, source: window }));
  // The parent: each app request reaches the real dispatcher, and its answer comes back.
  window.addEventListener('message', (event) => {
    if (event.data && event.data.stacki === 'app') {
      void rpc.answerAppMessage(one, structuredClone(event.data), context()).then((answer) => answer && deliver(answer));
    }
  });
  try {
    await runPage(window, one, deliver);
  } finally {
    // A failed check must not leave jsdom's animation frames holding the process open.
    window.close();
  }
});

async function runPage(window, one, deliver) {
  window.eval(sdk.appSdkSource());
  window.eval(kit.appHostAsset('__stacki/ui.js').body);
  await settle();
  await settle();
  const root = window.document.documentElement;
  assert.equal(root.getAttribute('data-theme'), 'dark', 'the start theme, from ui.theme');
  assert.ok(one.subscriptions.has('theme.change'), 'the kit script listens for changes');

  deliver(rpc.eventForSession(one, roles.ADMIN_VIEW, 'theme.change', { ...kit.appThemeView('dark'), theme: 'light' }));
  assert.equal(root.getAttribute('data-theme'), 'light', 'a change reaches the root');

  // The elements are the editor's components: the switch is Switch.tsx's button, the tabs SegmentedTabs.tsx's.
  const toggle = window.document.querySelector('stacki-switch .stacki-ui button.ui-switch');
  assert.ok(toggle, 'the switch renders Switch.tsx');
  assert.equal(toggle.getAttribute('role'), 'switch');
  assert.equal(toggle.getAttribute('aria-checked'), 'true');
  let changes = 0;
  window.document.querySelector('stacki-switch').addEventListener('change', () => (changes += 1));
  toggle.click();
  await settle();
  assert.equal(toggle.getAttribute('aria-checked'), 'false');
  assert.equal(changes, 1);

  const tabs = window.document.querySelector('stacki-tabs');
  assert.ok(tabs.querySelector('.ui-tabs .ui-tabs-indicator'), 'the tabs render SegmentedTabs.tsx with its pill');
  const [first, second] = tabs.querySelectorAll('.ui-tab');
  assert.equal(second.getAttribute('aria-selected'), 'true');
  first.click();
  await settle();
  assert.equal(tabs.value, 'a');
  assert.ok(first.classList.contains('on'));

  const trigger = window.document.querySelector('stacki-dropdown .dd-trigger');
  assert.ok(trigger, 'the dropdown renders Dropdown.tsx');
  assert.equal(trigger.querySelector('.dd-label').textContent, 'Two');
}
