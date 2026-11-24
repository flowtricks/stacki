// Goal: `.stacki/audits.json` changed outside the Audits panel (`stacki audits add`, a pull, an editor) is what the next audit
// run uses, because no file watcher announces that file. A file that stops reading keeps the last good settings, and a read
// overtaken by the panel's own write never puts the older text back.
// Method: bundle the real runner hook, mount it in jsdom over a fake main whose audit file the test rewrites, ask for a run as
// Re-audit does, and wait on the store the panel reads.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources.js');
const { waitFor } = require('../../helpers/waitFor.js');

const output = repoPath('node_modules/.stacki-test/audit-settings-reread.cjs');
fs.mkdirSync(path.dirname(output), { recursive: true });
esbuild.buildSync({
  stdin: {
    contents: [
      "export { useAuditRunner } from './src/features/audits/useAuditRunner';",
      "export { updateAuditState, auditState } from './src/features/audits/auditStore';",
    ].join('\n'),
    resolveDir: path.dirname(repoPath('package.json')),
    loader: 'tsx',
  },
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  jsx: 'automatic',
  loader: { '.css': 'empty', '.svg': 'empty' },
  external: ['react', 'react-dom', 'react/jsx-runtime'],
  logLevel: 'silent',
});

const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
global.window = dom.window;
for (const name of ['document', 'navigator', 'localStorage']) {
  Object.defineProperty(global, name, { value: dom.window[name], configurable: true, writable: true });
}
global.IS_REACT_ACT_ENVIRONMENT = true;

// The file on disk, and a gate that can hold one read open while the panel writes.
let disk = '{ "version": 2, "ignored": [] }\n';
let held;
let reads = 0;
const metadata = async () => {
  reads += 1;
  const source = disk;
  await held;
  return { ok: true, value: { source } };
};
// Every other call answers nothing: the audit run itself is not what this file tests.
window.avb = new Proxy(
  { projectMetadata: metadata },
  { get: (known, name) => known[name] ?? (String(name).startsWith('on') ? () => () => {} : async () => ({})) },
);

const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const audits = require(output);

const withIgnored = (id) => `${JSON.stringify({ version: 2, ignored: [{ id }] })}\n`;
const scan = { pages: [], pageFolders: [], layouts: [], components: [], astroConfig: undefined };
const storedIds = () => audits.auditState().ignores.value.ignored.map((entry) => entry.id);
const reAudit = () => act(async () => audits.updateAuditState((current) => ({ ...current, request: current.request + 1 })));
const settled = (what, until) =>
  waitFor({
    what,
    read: async () => {
      await act(async () => undefined);
      return { ids: storedIds(), reads, running: audits.auditState().running };
    },
    until,
  });

function Runner() {
  audits.useAuditRunner({ projectPath: '/site', scan, open: undefined, pageState: undefined, devUrl: undefined });
  return undefined;
}

test('each audit run reads audits.json again, without losing good settings or a newer write', async () => {
  const root = createRoot(document.getElementById('root'));
  await act(async () => root.render(React.createElement(Runner)));
  await settled('the first run to finish', (seen) => seen.reads >= 2 && !seen.running);
  assert.deepEqual(storedIds(), []);

  disk = withIgnored('from-the-cli');
  await reAudit();
  await settled('the outside edit to reach the panel', (seen) => seen.ids.includes('from-the-cli'));
  assert.equal(audits.auditState().ignores.source, disk, 'the next write is checked against the new bytes');

  disk = '{ not json';
  let before = reads;
  await reAudit();
  await settled('the run over a broken file to finish', (seen) => seen.reads > before && !seen.running);
  assert.deepEqual(storedIds(), ['from-the-cli'], 'a file that does not read keeps the last good settings');

  disk = withIgnored('older');
  let release;
  held = new Promise((resolve) => {
    release = resolve;
  });
  before = reads;
  await reAudit();
  await settled('the held read to start', (seen) => seen.reads > before);
  const written = withIgnored('panel-write');
  await act(async () =>
    audits.updateAuditState((current) => ({
      ...current,
      ignores: { source: written, value: { ...current.ignores.value, ignored: [{ id: 'panel-write', reason: undefined }] } },
    })),
  );
  await act(async () => release());
  await settled('the overtaken run to finish', (seen) => !seen.running);
  assert.deepEqual(storedIds(), ['panel-write'], 'a read that started before the write never undoes it');
  await act(async () => root.unmount());
});
