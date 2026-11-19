// Goal: hosted Studio offers the project's Settings panel under the same permission Desktop uses
// (`panel:projectSettings`: admin until a role is given it), draws Desktop's own Settings frame with the same
// tabs, and says honestly in each tab that hosted Studio cannot read `.env` or `.mcp.json` yet. It never draws
// a control that could not work and never prints a secret.
// Method: the role rules are asked directly (canStudioPanel over the real role views). The real frame and
// notices are bundled with esbuild (stylesheets emptied), rendered to static markup for every tab, and the
// rail's source is held to the same gate and anchoring as Desktop's rail, since the rail itself needs a
// browser. Browser-free, so it runs with the unit tests.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { build } from 'esbuild';
import { canStudioPanel } from '../src/features/roles/roleStore';
import { ADMIN_VIEW, DEFAULT_PROJECT_ROLES, parseProjectRoles, roleViewOf } from '../vendor/stacki/shared/properties/projectRoles';
import { PROJECT_SETTINGS_TABS } from '../vendor/stacki/src/features/projectSettings/settingsTabs';

const studio = path.resolve(import.meta.dirname, '..');
// Parsed as the app parses a roles file, so each role carries the defaults the parser gives it.
const roles = parseProjectRoles({
  version: 1,
  defaultRole: 'client',
  roles: [
    { id: 'admin', name: 'Admin', members: ['owner'] },
    { id: 'client', name: 'Client', members: ['acme'] },
    { id: 'writer', name: 'Writer', members: ['sam'], access: ['panel:cms', 'panel:variables'] },
    { id: 'ops', name: 'Ops', members: ['kim'], access: ['panel:projectSettings'] },
  ],
});

test('Settings shows for admin and for a role granted it, and for no one else', () => {
  assert.equal(canStudioPanel(ADMIN_VIEW, 'projectSettings'), true);
  assert.equal(canStudioPanel(roleViewOf(roles, 'ops'), 'projectSettings'), true);
  assert.equal(canStudioPanel(roleViewOf(roles, 'client'), 'projectSettings'), false);
  assert.equal(canStudioPanel(roleViewOf(roles, 'writer'), 'projectSettings'), false);
  assert.equal(canStudioPanel(roleViewOf(DEFAULT_PROJECT_ROLES, 'client'), 'projectSettings'), false);
});

test('the rail gates and anchors Settings like Desktop: same feature, above the AI button, outside More', () => {
  const rail = readFileSync(path.join(studio, 'src/app/EditorRail.tsx'), 'utf8');
  assert.match(rail, /canStudioPanel\(role, SETTINGS_PANEL\.id\)/, 'the button asks the role store');
  assert.match(rail, /FEATURE_ICONS\['panel:projectSettings'\]/, 'it draws the shared access icon');
  assert.match(rail, /className="rail-anchor"/, 'it sits in the anchored foot');
  assert.ok(rail.indexOf('SETTINGS_PANEL.labelKey') < rail.indexOf("select('ai')"), 'Settings comes before the AI button');
  const sidebar = readFileSync(path.join(studio, 'src/app/EditorSidebar.tsx'), 'utf8');
  assert.match(sidebar, /panel === 'projectSettings' && <StudioProjectSettings \/>/);
});

async function render(tab: string | undefined): Promise<string> {
  const outDir = path.join(studio, 'node_modules/.studio-test');
  mkdirSync(outDir, { recursive: true });
  const outfile = path.join(outDir, 'project-settings-panel.mjs');
  await build({
    stdin: {
      contents: [
        "import { renderToStaticMarkup } from 'react-dom/server';",
        "import { createElement } from 'react';",
        "import { HostedTabNotice, StudioProjectSettings } from './src/features/projectSettings/StudioProjectSettings';",
        'export const frame = () => renderToStaticMarkup(createElement(StudioProjectSettings));',
        'export const notice = (tab) => renderToStaticMarkup(createElement(HostedTabNotice, { tab }));',
      ].join('\n'),
      resolveDir: studio,
      loader: 'tsx',
    },
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    jsx: 'automatic',
    loader: { '.css': 'empty', '.svg': 'empty' },
    external: ['react', 'react-dom', 'react/jsx-runtime'],
    logLevel: 'silent',
  });
  // The bundle's two functions are checked as they are picked, so nothing is cast.
  const loaded: unknown = await import(pathToFileURL(outfile).href + '?v=' + String(Math.random()));
  assert.ok(typeof loaded === 'object' && loaded !== null);
  const frame: unknown = Reflect.get(loaded, 'frame');
  const notice: unknown = Reflect.get(loaded, 'notice');
  assert.ok(typeof frame === 'function' && typeof notice === 'function');
  const html: unknown = tab === undefined ? Reflect.apply(frame, undefined, []) : Reflect.apply(notice, undefined, [tab]);
  assert.ok(typeof html === 'string');
  return html;
}

test('the frame lists Desktop’s tabs and opens on the first, saying it is not available in hosted Studio', async () => {
  const html = await render(undefined);
  assert.ok(PROJECT_SETTINGS_TABS.length >= 2, 'Desktop has Secrets and MCP');
  for (const tab of ['Secrets', 'MCP']) {
    assert.match(html, new RegExp(`project-settings-tab[^>]*>.*?<span>${tab}</span>`), `${tab} tab`);
  }
  assert.match(html, /Not available in hosted Studio\. Use Stacki Desktop\./);
});

test('each tab states its hosted limit, names no endpoint and draws no form control', async () => {
  const mcp = await render('mcp');
  assert.match(mcp, /Not available in hosted Studio yet\. Use Stacki Desktop\./);
  assert.match(mcp, /MCP servers/);
  assert.match(mcp, /\.mcp\.json/, 'the long explanation sits behind the info hint');
  const secrets = await render('secrets');
  assert.match(secrets, /Not available in hosted Studio\. Use Stacki Desktop\./);
  assert.match(secrets, /\.env/);
  for (const html of [mcp, secrets]) {
    assert.doesNotMatch(html, /<input|<textarea|<select|https?:\/\//, 'no field, no invented endpoint');
    assert.doesNotMatch(html, /Restart Stacki/, 'Desktop’s restart message is not the hosted answer');
  }
});
