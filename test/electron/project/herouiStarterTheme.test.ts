// Check that the pinned theme inventory becomes editable CSS, then use the
// same variable operations as the editors to change one mode and read it back.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readDeclarations } from '#dist/electron/project/cssVarRead.js';
import { readVariables, setVariable } from '#dist/electron/project/cssVars.js';
import { HEROUI_THEME_FILE, heroUIThemeCSS } from '#dist/electron/project/herouiStarterTheme.js';
import {
  darkVariables,
  lightVariables,
  motionUtilities,
  sharedVariables,
  tailwindMappings,
  vibrantPaletteVariables,
} from '#dist/electron/project/herouiStarterThemeInventory.js';
import { HEROUI_VERSION } from '#dist/electron/project/herouiStarterSite.js';

const light = ':root[data-theme="light"]';
const dark = ':root[data-theme="dark"]';

test('the audited HeroUI 3.2.8 variables keep their pinned expressions and intended scope', () => {
  assert.equal(HEROUI_VERSION, '3.2.8');
  assert.equal(Object.keys(sharedVariables).length, 58);
  assert.equal(Object.keys(lightVariables).length, 31);
  assert.equal(Object.keys(darkVariables).length, 31);
  assert.equal(Object.keys(tailwindMappings).length + Object.keys(motionUtilities).length, 101);
  const source = heroUIThemeCSS();
  const rules = readDeclarations(source);
  for (const [selector, values] of [
    [':root', sharedVariables],
    [light, lightVariables],
    [dark, darkVariables],
    ['[data-vibrant-palette="true"]', vibrantPaletteVariables],
  ] as const) {
    const rule = rules.find((entry) => entry.selector === selector);
    assert.ok(rule, selector);
    const declarations = Object.fromEntries(rule.entries.flatMap((entry) => (entry.kind === 'var' ? [[entry.name, entry.value]] : [])));
    for (const [name, value] of Object.entries(values)) {
      assert.equal(declarations[name], value, `${selector} ${name}`);
    }
  }
  assert.match(source, /--field-radius: calc\(var\(--radius\) \* 1\.5\)/);
  assert.match(source, /--accent-hover: color-mix\(in oklab, var\(--accent\)/);
  assert.match(source, /--font-sans: system-ui/);
  assert.match(source, /--ease-smooth: var\(--motion-ease-smooth\)/);
  assert.match(source, /--animate-skeleton: var\(--motion-animate-skeleton\)/);
});

test('variable edits to a dark override preserve the light declaration and shared references', (context) => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-heroui-theme-'));
  context.after(() => fs.rmSync(project, { recursive: true, force: true }));
  const file = path.join(project, HEROUI_THEME_FILE);
  const source = heroUIThemeCSS();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, source);

  const properties = () => {
    const model = readVariables(project);
    const stylesheet = model.files.find((entry) => entry.rel === HEROUI_THEME_FILE);
    assert.ok(stylesheet);
    return stylesheet.groups.flatMap((group) => group.blocks.flatMap((block) => block.rows.flatMap((row) => row.cells)));
  };
  const read = (name: string, selector: string) => {
    const cell = properties().find((candidate) => candidate?.name === name && candidate.selector === selector);
    assert.ok(cell, `${selector} ${name}`);
    return cell;
  };
  const overlay = read('--overlay', dark);
  assert.equal(overlay.value, darkVariables['--overlay']);
  assert.equal(read('--overlay', light).value, lightVariables['--overlay']);
  const updatedOverlay = 'oklch(0.25 0.01 270)';
  assert.equal(
    setVariable(project, { file: HEROUI_THEME_FILE, valueStart: overlay.valueStart, valueEnd: overlay.valueEnd, expect: overlay.value, value: updatedOverlay })
      .ok,
    true,
  );
  assert.equal(fs.readFileSync(file, 'utf8'), source.slice(0, overlay.valueStart) + updatedOverlay + source.slice(overlay.valueEnd));
  assert.equal(read('--overlay', dark).value, updatedOverlay);
  assert.equal(read('--overlay', light).value, lightVariables['--overlay']);
  assert.equal(read('--field-radius', ':root').value, 'calc(var(--radius) * 1.5)');
  assert.match(read('--field-border-hover', ':root').value, /var\(--field-border, var\(--border\)\)/);
});
