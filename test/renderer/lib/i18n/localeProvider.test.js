// Goal: the provider (src/lib/i18n/LocaleProvider.tsx) never blocks the first render. English is on
// screen immediately; when the person's language is another one, the text swaps once its catalog
// arrives; a failed or late load leaves English; the document language follows what is on screen;
// and choosing another language in Settings (the locale store) loads that language.
// Method: the real provider is bundled and mounted with React under jsdom, with a loader the test
// resolves by hand, so the order of events (first paint, then arrival) is observable.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const { ROOT, repoPath } = require('../../../helpers/sources.js');

const directory = repoPath('node_modules/.stacki-test');
fs.mkdirSync(directory, { recursive: true });
const output = path.join(directory, 'locale-provider.bundle.cjs');
buildSync({
  stdin: {
    contents: `export { LocaleProvider } from './src/lib/i18n/LocaleProvider.tsx';
      export { useTranslate, useLocale } from './src/lib/i18n/useTranslate.ts';
      export { writeLocalePreference } from './src/lib/i18n/localeStore.ts';
      export { messages as spanish } from './shared/properties/i18n/messages/es.ts';
      export { messages as french } from './shared/properties/i18n/messages/fr.ts';`,
    resolveDir: ROOT,
  },
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  logLevel: 'silent',
  external: ['react', 'react-dom', 'react/jsx-runtime'],
});
const { LocaleProvider, useTranslate, useLocale, writeLocalePreference, spanish, french } = require(output);

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { pretendToBeVisual: true, url: 'http://localhost/' });
Object.assign(global, { window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage, IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperty(global, 'navigator', { value: dom.window.navigator, configurable: true });

function Probe() {
  const translate = useTranslate();
  const { locale } = useLocale();
  return React.createElement('p', { id: 'probe' }, `${locale}|${translate('settings.title')}|${translate('ai.composer.placeholder.send', { queueKey: 'K' })}`);
}
const text = () => document.getElementById('probe').textContent;

function controlledLoader() {
  const requests = [];
  const loader = (locale) =>
    new Promise((resolve) => {
      requests.push({ locale, resolve });
    });
  return { loader, requests };
}

async function mount(props) {
  document.getElementById('root').remove();
  const host = document.createElement('div');
  host.id = 'root';
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(React.createElement(LocaleProvider, props, React.createElement(Probe))));
  return root;
}

test('English renders at once; the translation swaps in when the catalog arrives', async () => {
  localStorage.clear();
  const { loader, requests } = controlledLoader();
  const root = await mount({ loader, languageTags: ['es-MX'] });
  assert.equal(text(), 'en|Settings|⏎ to send, K to queue for later');
  assert.equal(document.documentElement.lang, 'en');
  assert.deepEqual(
    requests.map((request) => request.locale),
    ['es'],
  );
  await act(async () => requests[0].resolve({ ok: true, value: spanish }));
  assert.equal(text(), 'es|Ajustes|⏎ para enviar, K para poner en cola para después');
  assert.equal(document.documentElement.lang, 'es');
  await act(async () => root.unmount());
});

test('English users never load a catalog', async () => {
  localStorage.clear();
  const { loader, requests } = controlledLoader();
  const root = await mount({ loader, languageTags: ['en-GB'] });
  assert.equal(requests.length, 0);
  assert.equal(text().startsWith('en|Settings'), true);
  await act(async () => root.unmount());
});

test('a failed load leaves English on screen', async () => {
  localStorage.clear();
  const { loader, requests } = controlledLoader();
  const warnings = [];
  const warn = console.warn;
  console.warn = (...parts) => warnings.push(parts.join(' '));
  const root = await mount({ loader, languageTags: ['fr'] });
  await act(async () => requests[0].resolve({ ok: false, error: { code: 'catalog-import-failed', message: 'offline' } }));
  console.warn = warn;
  assert.equal(text().startsWith('en|Settings'), true);
  assert.equal(warnings.length, 1);
  await act(async () => root.unmount());
});

test('a load that finishes after the language changed again is ignored', async () => {
  localStorage.clear();
  const { loader, requests } = controlledLoader();
  const root = await mount({ loader, languageTags: ['en'] });
  await act(async () => writeLocalePreference('es'));
  await act(async () => writeLocalePreference('fr'));
  assert.deepEqual(
    requests.map((request) => request.locale),
    ['es', 'fr'],
  );
  await act(async () => requests[1].resolve({ ok: true, value: french }));
  await act(async () => requests[0].resolve({ ok: true, value: spanish }));
  assert.equal(text().startsWith('fr|Réglages'), true);
  await act(async () => writeLocalePreference('system'));
  assert.equal(text().startsWith('en|Settings'), true);
  assert.equal(document.documentElement.lang, 'en');
  await act(async () => root.unmount());
});

test('a stored value that is not a shipped language is ignored', async () => {
  localStorage.setItem('stacki.locale', 'klingon');
  const { loader, requests } = controlledLoader();
  const root = await mount({ loader, languageTags: ['en'] });
  assert.equal(requests.length, 0);
  localStorage.clear();
  await act(async () => root.unmount());
});

test('without a provider the context is English', async () => {
  document.getElementById('root').remove();
  const host = document.createElement('div');
  host.id = 'root';
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(React.createElement(Probe)));
  assert.equal(text(), 'en|Settings|⏎ to send, K to queue for later');
  await act(async () => root.unmount());
});
