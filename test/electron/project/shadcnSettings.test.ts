// Exercise detection, stylesheet edits, and safe RTL changes against real temporary project files.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { changeShadcnSetting, readShadcnSettings } from '#dist/electron/project/shadcnSettings.js';
import { shadcnStarterLayout } from '#dist/electron/project/shadcnStarterContent.js';
import { shadcnThemePicker } from '#dist/electron/project/shadcnStarterTheme.js';

const config = {
  $schema: 'https://ui.shadcn.com/schema.json',
  style: 'base-nova',
  tailwind: { css: 'src/styles/global.css' },
  aliases: { ui: '@/components/ui' },
  rtl: true,
};

function site(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'stacki-shadcn-settings-'));
}

test('detects shadcn from project files and edits only the cursor declaration', async () => {
  const root = site();
  try {
    assert.deepEqual(readShadcnSettings(root), { ok: true, value: undefined });
    writeFileSync(path.join(root, 'components.json'), JSON.stringify(config));
    mkdirSync(path.join(root, 'src/styles'), { recursive: true });
    const file = path.join(root, config.tailwind.css);
    const original = '@layer base { button:not(:disabled), [role="button"]:not(:disabled) { color: red; } }\n';
    writeFileSync(file, original);
    assert.deepEqual(readShadcnSettings(root), { ok: true, value: { pointer: false, rtl: true } });
    assert.deepEqual(await changeShadcnSetting(root, { setting: 'pointer', enabled: true }), { ok: true, value: { pointer: true, rtl: true } });
    assert.deepEqual(await changeShadcnSetting(root, { setting: 'pointer', enabled: false }), { ok: true, value: { pointer: false, rtl: true } });
    assert.equal(readFileSync(file, 'utf8').trim(), original.trim());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('turning RTL off updates the starter preview and retains migrated component source', async () => {
  const root = site();
  try {
    writeFileSync(path.join(root, 'components.json'), JSON.stringify(config));
    mkdirSync(path.join(root, 'src/layouts'), { recursive: true });
    mkdirSync(path.join(root, 'src/components/examples'), { recursive: true });
    const layout = path.join(root, 'src/layouts/main.astro');
    const picker = path.join(root, 'src/components/examples/ThemePicker.tsx');
    writeFileSync(layout, shadcnStarterLayout('base', { rtl: true }));
    writeFileSync(picker, shadcnThemePicker('base', { rtl: true }));
    const component = path.join(root, 'src/components/Custom.astro');
    writeFileSync(component, '<button class="ms-4">Project content</button>');
    assert.deepEqual(await changeShadcnSetting(root, { setting: 'rtl', enabled: false }), { ok: true, value: { pointer: false, rtl: false } });
    assert.equal(readFileSync(layout, 'utf8'), shadcnStarterLayout('base', { rtl: false }));
    assert.equal(readFileSync(picker, 'utf8'), shadcnThemePicker('base', { rtl: false }));
    assert.equal(readFileSync(component, 'utf8'), '<button class="ms-4">Project content</button>');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('keeps another library hidden and refuses CSS linked outside the project', async () => {
  const root = site();
  const other = site();
  try {
    const manifest = path.join(root, 'components.json');
    writeFileSync(manifest, JSON.stringify({ ...config, $schema: 'https://example.test/schema.json' }));
    assert.deepEqual(readShadcnSettings(root), { ok: true, value: undefined });
    writeFileSync(manifest, JSON.stringify(config));
    mkdirSync(path.join(root, 'src/styles'), { recursive: true });
    const target = path.join(other, 'global.css');
    writeFileSync(target, ':root {}\n');
    symlinkSync(target, path.join(root, config.tailwind.css));
    assert.equal((await changeShadcnSetting(root, { setting: 'pointer', enabled: true })).ok, false);
    assert.equal(readFileSync(target, 'utf8'), ':root {}\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  }
});
