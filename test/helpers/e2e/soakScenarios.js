// Goal: the scenario library of the style-panel soak (test/renderer/style/stylePanelSoak.test.js).
// Each scenario drives the real app through soakDriver.js, cuts what the recorder saw into one
// segment per action, and checks every segment against soakInvariants.js.
//
// Method:
// - The fixture's elements are addressed by id in the canvas and, for navigator presses, by
//   the navigator row the canvas selected for them (learned once at start).
// - Control families name how to find a field's chip or editor, its label and its menus.
// - Scenarios: (i) switches A -> B by canvas, navigator and keyboard with a press on a control
//   at a set delay after the switch; (ii) every popover opened, held and closed by every exit
//   path, and rapid chip toggling; (iii) variable-picker hover preview and each way out; (iv)
//   set -> clear -> undo -> redo with field, label, canvas and file compared; (v) typing,
//   arrow keys and a switch mid-edit; (vi) breakpoint switching and back to Base; (vii) a
//   seeded random walk mixing all of them. Delays, repeats and steps are bounded by the plan.
// - Every violation carries the scenario, step, seed, throttle and evidence, and a screenshot
//   of the window right after the segment for the first violation of each invariant/key.

const path = require('node:path');
const { checkSegment, controlValue } = require('./soakInvariants.js');
const { installRecorder, readRecording } = require('./panelRecorder.js');

const ELEMENTS = Object.freeze({
  headingOne: '#soak-heading-one',
  headingTwo: '#soak-heading-two',
  paragraph: '#soak-paragraph',
  plain: '#soak-plain',
  inline: '#soak-inline',
  nestedSpan: '#soak-nested-span',
  cardTitle: '#soak-card-title',
  cardText: '#soak-card-text',
  expressionOne: '#soak-expr-one',
  expressionTwo: '#soak-expr-two',
});

const FAMILIES = Object.freeze([
  {
    id: 'font-family',
    key: 'Font family',
    property: 'font-family',
    field: 'input[aria-label="Font family"]',
    select: 'Font family',
    label: 'Font',
    chevron: 'Font family',
  },
  {
    id: 'weight',
    key: 'Font weight',
    property: 'font-weight',
    field: 'input[aria-label="Font weight"]',
    select: 'Font weight',
    label: 'Weight',
    chevron: 'Font weight',
  },
  { id: 'size', key: 'font-size', property: 'font-size', field: 'input[data-prop="font-size"]', label: 'Size' },
  { id: 'line-height', key: 'line-height', property: 'line-height', field: 'input[data-prop="line-height"]', label: 'Height' },
  { id: 'color', key: 'color', property: 'color', field: 'input[data-prop="color"]', label: 'Color', swatch: 'Text color' },
  { id: 'letter-spacing', key: 'letter-spacing', property: 'letter-spacing', field: 'input[data-prop="letter-spacing"]', label: 'Letter spacing' },
  { id: 'text-indent', key: 'text-indent', property: 'text-indent', field: 'input[data-prop="text-indent"]', label: 'Text indent' },
  {
    id: 'text-transform',
    key: 'Text transform',
    property: 'text-transform',
    field: 'input[aria-label="Text transform"]',
    label: 'Capitalize',
    arrow: 'More Text transform options',
  },
  { id: 'align', key: 'Text align (segments)', property: 'text-align', group: 'Text align', label: 'Align', arrow: 'More Text align options' },
  {
    id: 'decor',
    key: 'Text decoration (segments)',
    property: 'text-decoration-line',
    group: 'Text decoration',
    label: 'Decor',
    arrow: 'More Text decoration options',
  },
  { id: 'margin', key: 'margin-top (spacing)', property: 'margin-top', spacing: 'margin-top' },
  { id: 'padding', key: 'padding-top (spacing)', property: 'padding-top', spacing: 'padding-top' },
]);

const SWITCH_DELAYS_MS = Object.freeze([0, 16, 50, 120, 300, 1000, 1600]);
const HOLD_OPEN_MS = 700;
const RAPID_TOGGLES = 6;
const WALK_STEPS_DEFAULT = 300;
const SCREENSHOTS_MAX = 40;
const RECORDINGS_MAX = 80;
const FILM_AFTER_MS = 1500;
const DIFF_LINES_MAX = 4;
const LATE_RECHECK_MS = 2500;
const CANVAS_RELOAD_MS = 600;
const CHIP_POLLS_MAX = 300;
const EXIT_PATHS = Object.freeze(['outside-press', 'canvas-press-same', 'canvas-press-other', 'escape', 'tab', 'window-blur', 'scroll']);
const POPOVER_QUERY = `[...document.querySelectorAll('.embed-editor_varpicker, [role="menu"], [role="listbox"], [role="dialog"]')].filter((e) => e.getClientRects().length > 0)`;

// A small deterministic generator (mulberry32): a failing walk names its seed.
function seededRandom(seed) {
  let value = seed >>> 0;
  return () => {
    value = (value + 0x6d2b79f5) >>> 0;
    let mixed = value;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

// Page-side finders: each is the source of an expression that yields an element or undefined.
const finders = {
  opener(family) {
    if (family.group !== undefined) {
      return `(() => { const g = document.querySelector('[role="group"][aria-label=${JSON.stringify(family.group)}]'); return (g && (g.querySelector('[role="radio"]:not([aria-checked="true"])') || g.querySelector('[role="radio"]'))) || undefined; })()`;
    }
    if (family.spacing !== undefined) {
      return `document.querySelector('button.embed-editor_spacing-label[data-prop=${JSON.stringify(family.spacing)}]') || undefined`;
    }
    const select = family.select === undefined ? 'undefined' : `document.querySelector('button.u-select-button[aria-label=${JSON.stringify(family.select)}]')`;
    return `(() => { const input = document.querySelector(${JSON.stringify(family.field)}); const box = input && input.closest('.embed-editor_varconnect'); if (box) { return box.querySelector('[data-chip]') || box.querySelector('.embed-editor_varconnect-hint button') || box.querySelector('[contenteditable="true"]') || input; } return ${select} || undefined; })()`;
  },
  field(family) {
    if (family.field === undefined) {
      return finders.opener(family);
    }
    return `(() => { const input = document.querySelector(${JSON.stringify(family.field)}); const box = input && input.closest('.embed-editor_varconnect'); return (box && box.querySelector('[contenteditable="true"]')) || input || undefined; })()`;
  },
  label(family) {
    if (family.label === undefined) {
      return 'undefined';
    }
    const anchor =
      family.field === undefined
        ? family.group === undefined
          ? 'undefined'
          : `document.querySelector('[role="group"][aria-label=${JSON.stringify(family.group)}]')`
        : `document.querySelector(${JSON.stringify(family.field)})`;
    return `(() => { const anchor = ${anchor}; const labels = [...document.querySelectorAll('.embed-editor_size-label, .u-field-label')].filter((e) => e.textContent.trim() === ${JSON.stringify(family.label)} && e.getClientRects().length > 0); if (!anchor) return labels[0]; const a = anchor.getBoundingClientRect(); let best; let bestDistance = Infinity; for (const label of labels) { const r = label.getBoundingClientRect(); const distance = Math.hypot(r.left - a.left, r.top - a.top); if (distance < bestDistance) { best = label; bestDistance = distance; } } return best; })()`;
  },
  arrow(family) {
    if (family.arrow !== undefined) {
      return `document.querySelector('button[aria-label=${JSON.stringify(family.arrow)}]') || undefined`;
    }
    if (family.chevron !== undefined) {
      return `document.querySelector('button.u-select-chevron-btn[aria-label=${JSON.stringify(family.chevron)}]') || undefined`;
    }
    return 'undefined';
  },
  dot(family) {
    if (family.field === undefined) {
      return 'undefined';
    }
    return `(() => { const input = document.querySelector(${JSON.stringify(family.field)}); const box = input && input.closest('.embed-editor_varconnect'); return (box && box.querySelector('.embed-editor_varconnect-dot')) || undefined; })()`;
  },
  neutral: `document.querySelector('.embed-editor_element-id') || undefined`,
  context: `document.querySelector('button[aria-label="Style context"]') || undefined`,
  pickerItem: (index) =>
    `(() => { const items = [...document.querySelectorAll('.embed-editor_varpicker .embed-editor_varpicker-item-name')].map((e) => e.parentElement).filter((e) => e.getClientRects().length > 0); return items[${index}] || undefined; })()`,
  pickerOptions: `document.querySelector('.embed-editor_varpicker .embed-editor_varpicker-options') || undefined`,
  pickerSearch: `document.querySelector('.embed-editor_varpicker .embed-editor_varpicker-search') || undefined`,
  listOption: (index) =>
    `(() => { const options = ${POPOVER_QUERY}.flatMap((p) => [...p.querySelectorAll('[role="option"], [role="menuitemradio"], [role="menuitem"]')]); return options[${index}] || undefined; })()`,
  selectorChip: (index) => `[...document.querySelectorAll('.embed-editor_selector-chip')][${index}] || undefined`,
  filter: (index) => `[...document.querySelectorAll('.embed-editor_selector-filter input')][${index}] || undefined`,
  addButton: `document.querySelector('.embed-editor_add-btn') || undefined`,
};

// Whether the first rule for `selector` in `source` (outside any at-rule block written after it)
// declares `property`. The fixture writes each base rule before its media queries.
function ruleDeclares(source, selector, property) {
  const start = source.indexOf(`${selector} {`);
  if (start === -1) {
    return false;
  }
  const body = source.slice(start, source.indexOf('}', start));
  return new RegExp(`(^|[\\s;{])${property}\\s*:`).test(body);
}

// The files a segment changed, each with its first differing lines (before and after).
function fileChanges(before, after) {
  const changes = [];
  for (const [file, text] of after) {
    const previous = before.get(file);
    if (previous === text) {
      continue;
    }
    const oldLines = (previous ?? '').split('\n');
    const newLines = text.split('\n');
    const first = oldLines.findIndex((line, index) => line !== newLines[index]);
    const start = first === -1 ? Math.min(oldLines.length, newLines.length) : first;
    changes.push({ file, line: start + 1, before: oldLines.slice(start, start + DIFF_LINES_MAX), after: newLines.slice(start, start + DIFF_LINES_MAX) });
  }
  return changes;
}

// A segment's recording small enough to keep: per frame, the header, scroll, popovers and each
// control's value (without colours and positions), plus the logs.
function compactRecording(step, recorded) {
  return {
    step,
    action: recorded.action,
    frames: recorded.frames.map((frame) => ({
      frame: frame.frame,
      t: frame.t,
      element: frame.element,
      scrollTop: frame.scrollTop,
      active: frame.active,
      popovers: frame.popovers.map((popover) => popover.what),
      controls: Object.fromEntries(Object.entries(frame.controls ?? {}).map(([key, control]) => [key, controlValue(control)])),
    })),
    popovers: recorded.popovers,
    inputs: recorded.inputs,
    notes: recorded.notes,
  };
}

function createRunner({ driver, electron, window, outDirectory, seed }) {
  let throttle = 1;
  const results = { segments: 0, violations: [], warnings: [], skipped: [], screenshots: 0, recordings: [], films: [] };
  const screenshotKeys = new Set();
  const navigatorRows = new Map();
  let current = '';
  let scenario = '';
  let step = 0;

  async function begin() {
    await driver.waitForApp();
    await driver.setPageFocus('focused');
    await installRecorder(driver.contents);
    await driver.sleep(500);
    await driver.settle();
  }

  // One action, recorded from just before it until the panel settles, then checked.
  async function segment(label, kind, act, { holdMs = 0, editedKey } = {}) {
    step += 1;
    await driver.settle();
    await readRecording(driver.contents);
    const before = await driver.evaluate('window.__soak.snapshot()');
    // Looking, hovering and closing never write; a hover preview is a draft, never a save.
    const filesBefore = kind === 'look' || kind === 'preview' ? driver.projectSnapshot() : undefined;
    const actResult = await act();
    if (holdMs > 0) {
      await driver.sleep(holdMs);
    }
    const settled = await driver.settle();
    const recording = await readRecording(driver.contents);
    const recorded = { action: { label, kind, editedKey }, before, ...recording };
    const { violations, warnings } = checkSegment(recorded);
    if (filesBefore !== undefined) {
      const changes = fileChanges(filesBefore, driver.projectSnapshot());
      if (changes.length > 0) {
        violations.push({
          invariant: 'source-written',
          summary: `${label} changed ${changes.map((change) => change.file).join(', ')} without an edit`,
          evidence: { changes },
        });
      }
    }
    if (!settled.settled) {
      warnings.push({ invariant: 'settle', summary: `${label}: the panel kept changing for ${settled.waitedMs} ms`, evidence: {} });
    }
    results.segments += 1;
    if (violations.length > 0 && results.recordings.length < RECORDINGS_MAX) {
      results.recordings.push({ throttle, ...compactRecording(step, recorded) });
    }
    for (const violation of violations) {
      await report(violation, label);
    }
    for (const warning of warnings) {
      results.warnings.push({ scenario, step, seed, throttle, action: label, ...warning });
    }
    return { recorded, violations, actResult };
  }

  async function report(violation, label) {
    const entry = { scenario, step, seed, throttle, action: label, ...violation };
    const key = `${violation.invariant}:${violation.evidence?.key ?? violation.summary.slice(0, 40)}`;
    if (!screenshotKeys.has(key) && results.screenshots < SCREENSHOTS_MAX) {
      screenshotKeys.add(key);
      results.screenshots += 1;
      const file = path.join(outDirectory, `violation-${results.screenshots}.png`);
      await driver.screenshot(file);
      entry.screenshot = file;
    }
    results.violations.push(entry);
  }

  async function pressPanel(finder, label, options = {}) {
    const point = await driver.panelPoint(finder, options);
    if (point === undefined) {
      results.skipped.push({ scenario, step, action: label, why: 'control not found' });
      return false;
    }
    await driver.pointerPress(point, { label, modifiers: options.modifiers ?? [] });
    return true;
  }

  async function select(element, method) {
    if (method === 'canvas' || !navigatorRows.has(element)) {
      await driver.pointerPress(await driver.canvasPoint(ELEMENTS[element]), { label: `canvas select ${element}` });
    } else if (method === 'navigator') {
      const index = navigatorRows.get(element);
      await pressPanel(`[...document.querySelectorAll('.structure-node:not(.is-pseudo)')][${index}] || undefined`, `navigator select ${element}`, {
        scroll: false,
      });
    } else {
      const keys = await adjacentKeys(current, element);
      for (const keyCode of keys) {
        await driver.key(keyCode, { label: `switch key ${keyCode}` });
      }
    }
    current = element;
  }

  // The arrow keys that walk the navigator from one row to the other (siblings only).
  async function adjacentKeys(from, to) {
    const fromIndex = navigatorRows.get(from);
    const toIndex = navigatorRows.get(to);
    if (fromIndex === undefined || toIndex === undefined) {
      return [];
    }
    const keyCode = toIndex > fromIndex ? 'Down' : 'Up';
    return Array.from({ length: Math.abs(toIndex - fromIndex) }, () => keyCode);
  }

  async function learnNavigator() {
    for (const element of Object.keys(ELEMENTS)) {
      await driver.pointerPress(await driver.canvasPoint(ELEMENTS[element]), { label: `canvas select ${element}` });
      await driver.settle();
      const index = await driver.evaluate(
        `[...document.querySelectorAll('.structure-node:not(.is-pseudo)')].findIndex((e) => e.classList.contains('selected'))`,
      );
      if (index >= 0) {
        navigatorRows.set(element, index);
      }
      current = element;
    }
  }

  async function exitBy(exitPath) {
    switch (exitPath) {
      case 'outside-press':
        return pressPanel(finders.neutral, 'outside press', { scroll: false });
      case 'canvas-press-same':
        await driver.pointerPress(await driver.canvasPoint(ELEMENTS[current]), { label: 'canvas press same element' });
        return true;
      case 'canvas-press-other': {
        const other = current === 'headingOne' ? 'headingTwo' : 'headingOne';
        await select(other, 'canvas');
        return true;
      }
      case 'escape':
        await driver.key('Escape', { label: 'key Escape' });
        return true;
      case 'tab':
        await driver.key('Tab', { label: 'key Tab' });
        return true;
      case 'window-blur': {
        await driver.note({ kind: 'action', action: 'blur window' });
        // The page holds emulated focus (begin), which no other window can take: drop it so the
        // window really blurs, then give it back as a person's return to the window would.
        await driver.setPageFocus('unfocused');
        const other = new electron.BrowserWindow({ width: 200, height: 120, show: true });
        other.focus();
        await driver.sleep(300);
        other.destroy();
        window.focus();
        driver.contents.focus();
        await driver.setPageFocus('focused');
        return true;
      }
      case 'scroll': {
        const point = await driver.panelPoint(finders.neutral, { scroll: false });
        if (point === undefined) {
          return false;
        }
        await driver.wheel({ x: point.x, y: point.y + 200 }, -120, 'scroll panel');
        return true;
      }
      default:
        throw new Error(`soakScenarios: unknown exit path ${exitPath}`);
    }
  }

  const openCount = () => driver.evaluate(`${POPOVER_QUERY}.length`);

  async function closeEverything() {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if ((await openCount()) === 0) {
        return;
      }
      await driver.key('Escape', { label: 'key Escape' });
      await driver.settle();
    }
  }

  // (i) Switch A -> B, press a control at a delay after the switch.
  // A person's fastest press: the first frame the panel names another element and shows the
  // family's chip.
  async function waitForNewChip(family, headerBefore) {
    for (let poll = 0; poll < CHIP_POLLS_MAX; poll += 1) {
      const ready = await driver.evaluate(
        `(() => { const header = document.querySelector('.embed-editor_element-id'); const chip = (${finders.opener(family)}); return !!header && header.textContent !== ${JSON.stringify(headerBefore)} && !!chip && chip.matches('[data-chip]'); })()`,
      );
      if (ready) {
        return;
      }
      await driver.sleep(8);
    }
  }

  // The canvas's own Reload button: a fresh page forgets every answer the panel remembered,
  // so the next switch meets the element as for the first time (runtime classes unreported).
  async function reloadCanvas() {
    await pressPanel(`document.querySelector('button[aria-label="Reload preview"]') || undefined`, 'press Reload preview', { scroll: false });
    await driver.sleep(CANVAS_RELOAD_MS);
    await driver.waitForApp();
    await driver.settle();
  }

  async function switchMatrix({ pairs, methods, delays, families, fresh = false }) {
    scenario = 'switch-press';
    for (const [from, to] of pairs) {
      for (const method of methods) {
        for (const delay of delays) {
          for (const family of families) {
            await closeEverything();
            await select(from, 'canvas');
            await driver.settle();
            if (fresh) {
              await reloadCanvas();
            }
            await driver.panelPoint(finders.opener(family));
            await segment(
              `switch ${from}->${to} by ${method}${fresh ? ' on a fresh canvas' : ''}, press ${family.id} after ${delay} ms`,
              'switch',
              async () => {
                const headerBefore = await driver.evaluate(`document.querySelector('.embed-editor_element-id')?.textContent ?? ''`);
                await select(to, method);
                if (delay === 'chip') {
                  await waitForNewChip(family, headerBefore);
                } else {
                  await driver.sleep(delay);
                }
                const point = await driver.panelPoint(finders.opener(family), { scroll: false });
                if (point !== undefined && point.hit) {
                  await driver.pointerPress(point, { label: `press ${family.id}` });
                }
              },
              { holdMs: HOLD_OPEN_MS },
            );
            await closeEverything();
          }
        }
      }
    }
  }

  // (i, plain) A -> B -> A with no press: the state-only checks (steps, provisional, blank).
  async function switchOnly({ pairs, methods, repeats }) {
    scenario = 'switch';
    for (const [from, to] of pairs) {
      for (const method of methods) {
        await closeEverything();
        await select(from, 'canvas');
        for (let round = 0; round < repeats; round += 1) {
          const target = round % 2 === 0 ? to : from;
          await segment(`switch ${current}->${target} by ${method}`, 'switch', () => select(target, method));
        }
      }
    }
  }

  // (ii) Open every popover of every family, hold it, leave by each exit path.
  async function popoverMatrix({ element, families, exitPaths }) {
    scenario = 'popover';
    for (const family of families) {
      const openers = [
        ['chip', finders.opener(family)],
        ['menu', finders.arrow(family)],
        ['label', finders.label(family)],
        ['dot', finders.dot(family)],
      ];
      for (const [openerName, finder] of openers) {
        if (finder === 'undefined') {
          continue;
        }
        for (const exitPath of exitPaths) {
          await closeEverything();
          if (current !== element) {
            await select(element, 'canvas');
          }
          const opened = await segment(`open ${family.id} ${openerName}`, 'open', () => pressPanel(finder, `press ${family.id} ${openerName}`), {
            holdMs: HOLD_OPEN_MS,
          });
          if (!opened.actResult || (await openCount()) === 0) {
            continue;
          }
          await segment(`close ${family.id} ${openerName} by ${exitPath}`, exitPath === 'canvas-press-other' ? 'switch' : 'look', async () => {
            await exitBy(exitPath);
          });
          await checkFocusAfter(exitPath, `${family.id} ${openerName}`);
          if (exitPath === 'canvas-press-other') {
            await select(element, 'canvas');
          }
        }
      }
    }
  }

  async function checkFocusAfter(exitPath, what) {
    if (exitPath !== 'outside-press' && exitPath !== 'canvas-press-same' && exitPath !== 'canvas-press-other') {
      return;
    }
    const snapshot = await driver.evaluate('window.__soak.snapshot()');
    if (snapshot.activeEditable) {
      await report(
        { invariant: 'focus-after-click-out', summary: `${what}: ${snapshot.active} kept the caret after ${exitPath}`, evidence: { active: snapshot.active } },
        `focus after ${exitPath}`,
      );
    }
  }

  // (ii) Rapid toggling of a chip: an even number of presses leaves it closed, odd open.
  async function rapidToggle({ element, families }) {
    scenario = 'rapid-toggle';
    for (const family of families) {
      await closeEverything();
      if (current !== element) {
        await select(element, 'canvas');
      }
      const point = await driver.panelPoint(finders.opener(family));
      if (point === undefined) {
        continue;
      }
      await segment(`rapid toggle ${family.id} x${RAPID_TOGGLES}`, 'look', async () => {
        for (let press = 0; press < RAPID_TOGGLES; press += 1) {
          await driver.pointerPress(point, { label: `toggle ${family.id}`, holdMs: 10 });
          await driver.sleep(40);
        }
      });
      const open = await openCount();
      if (open !== 0) {
        await report(
          { invariant: 'toggle-parity', summary: `${family.id}: ${RAPID_TOGGLES} presses left ${open} popover(s) open`, evidence: {} },
          `rapid toggle ${family.id}`,
        );
      }
    }
  }

  async function canvasStyle(property) {
    return driver.canvasEvaluate(
      `getComputedStyle(document.querySelector(${JSON.stringify(ELEMENTS[current])})).getPropertyValue(${JSON.stringify(property)})`,
    );
  }

  // (iii) Hover preview in the variable picker, then each way out: nothing may stick.
  async function hoverPreview({ element, families, exitPaths }) {
    scenario = 'hover-preview';
    for (const family of families) {
      for (const exitPath of exitPaths) {
        await closeEverything();
        if (current !== element) {
          await select(element, 'canvas');
        }
        await driver.settle();
        const property = family.property;
        const styleBefore = await canvasStyle(property);
        const fieldBefore = await fieldState(family);
        const opened = await pressPanel(finders.dot(family) === 'undefined' ? finders.opener(family) : finders.opener(family), `press ${family.id} chip`);
        await driver.settle();
        if (!opened || (await openCount()) === 0) {
          continue;
        }
        let previewed = false;
        await segment(`hover ${family.id} picker rows`, 'preview', async () => {
          for (let index = 0; index < 3; index += 1) {
            const point = await driver.panelPoint(finders.pickerItem(index), { scroll: false });
            if (point !== undefined) {
              await driver.hover(point, `hover picker row ${index}`);
              await driver.sleep(120);
              if ((await canvasStyle(property)) !== styleBefore) {
                previewed = true;
              }
            }
          }
        });
        await segment(`leave ${family.id} picker by ${exitPath}`, exitPath === 'canvas-press-other' ? 'switch' : 'look', () => exitBy(exitPath));
        if (exitPath === 'canvas-press-other') {
          await select(element, 'canvas');
          await driver.settle();
        }
        // A way out that leaves the picker open (window blur, for one) may keep previewing the
        // row under the pointer; what must not happen is the preview outliving the picker.
        const stillOpen = await openCount();
        if (stillOpen > 0) {
          await driver.hover({ x: 5, y: 5 }, 'move pointer away');
          await closeEverything();
        }
        const styleAfter = await canvasStyle(property);
        const fieldAfter = await fieldState(family);
        if (styleAfter !== styleBefore) {
          await report(
            {
              invariant: 'preview-stuck',
              summary: `${family.id}: canvas ${property} ${styleBefore} -> ${styleAfter} after hover and ${exitPath}`,
              evidence: { previewed },
            },
            `leave by ${exitPath}`,
          );
        }
        if (fieldAfter !== fieldBefore) {
          await report(
            { invariant: 'preview-stuck', summary: `${family.id}: field ${fieldBefore} -> ${fieldAfter} after hover and ${exitPath}`, evidence: { previewed } },
            `leave by ${exitPath}`,
          );
        }
        await checkFocusAfter(exitPath, `${family.id} picker`);
      }
    }
  }

  async function fieldState(family) {
    const snapshot = await driver.evaluate('window.__soak.snapshot()');
    const key = Object.keys(snapshot.controls ?? {}).find((name) => name === family.key);
    return controlValue(key === undefined ? undefined : snapshot.controls[key]);
  }

  // (iv) set -> clear -> undo -> redo, with field, label, canvas and saved file compared.
  async function editCycle({ element, family, value, file, selector, clearBy = 'menu' }) {
    scenario = 'edit-cycle';
    await closeEverything();
    await select(element, 'canvas');
    await driver.settle();
    const expectations = [];
    // One reading of the four places the value shows: the field, its label's colour, the
    // canvas's computed style and the rule in the saved file.
    const read = async () => {
      const snapshot = await driver.evaluate('window.__soak.snapshot()');
      return {
        field: controlValue(snapshot.controls?.[family.key]),
        label: snapshot.labels?.[family.label],
        style: await canvasStyle(family.property),
        declared: ruleDeclares(driver.readProjectFile(file), selector, family.property),
      };
    };
    const base = await (async () => {
      await driver.settle();
      return read();
    })();
    const fieldPoint = await driver.panelPoint(finders.field(family));
    if (fieldPoint === undefined) {
      results.skipped.push({ scenario, action: `edit ${family.id}`, why: 'field not found' });
      return;
    }
    // Each stage names the reading it must equal on every axis (and whether the rule declares
    // the property); a mismatch is read again after LATE_RECHECK_MS to tell "late" from "never".
    const stages = [
      [
        `set ${family.id} ${value}`,
        async () => {
          await driver.pointerPress(fieldPoint, { label: `press ${family.id} field` });
          await driver.sleep(80);
          // The field starts empty (each cycle picks an unset property), so nothing to select first.

          await driver.typeText(value);
          await driver.key('Enter', { label: 'key Enter' });
        },
        undefined,
        true,
      ],
      [`clear ${family.id} by ${clearBy}`, () => clearField(family, clearBy), 'base', false],
      [
        `undo ${family.id}`,
        async () => {
          await pressPanel(finders.neutral, 'outside press', { scroll: false });
          await driver.menu('CmdOrCtrl+Z', 'undo');
        },
        'set',
        true,
      ],
      [`redo ${family.id}`, () => driver.menu('Shift+CmdOrCtrl+Z', 'redo'), 'base', false],
    ];
    const readings = { base };
    for (const [label, act, expected, declares] of stages) {
      await segment(label, 'edit', act, { editedKey: family.key });
      const stage = label.split(' ')[0];
      const reading = await read();
      readings[stage] = reading;
      const want = expected === undefined ? undefined : readings[expected];
      const wrong = (candidate) => {
        const problems = [];
        if (candidate.declared !== declares) {
          problems.push(`file ${declares ? 'lacks' : 'still has'} ${family.property} in ${selector}`);
        }
        if (want === undefined) {
          if (candidate.style === base.style) {
            problems.push(`canvas still ${candidate.style}`);
          }
          return problems;
        }
        for (const axis of ['field', 'label', 'style']) {
          if (candidate[axis] !== want[axis]) {
            problems.push(`${axis} ${candidate[axis]} (expected ${want[axis]} as at ${expected})`);
          }
        }
        return problems;
      };
      const problems = wrong(reading);
      expectations.push({ stage, reading, problems });
      if (problems.length === 0) {
        continue;
      }
      await driver.sleep(LATE_RECHECK_MS);
      const later = await read();
      const stillWrong = wrong(later);
      const timing = stillWrong.length === 0 ? `converged only after ${LATE_RECHECK_MS} ms` : 'still wrong after a further wait';
      readings[stage] = later;
      await report(
        {
          invariant: 'state-disagrees',
          summary: `${family.id} on ${element} after ${stage}: ${problems.join('; ')} (${timing})`,
          evidence: { expectations, later },
        },
        label,
      );
    }
  }

  // Clear a property the two ways the panel offers: the label's menu (its Clear item), or
  // Option+press on a spacing label.
  async function clearField(family, clearBy) {
    if (clearBy === 'option-press') {
      return pressPanel(finders.opener(family), `press ${family.id} label alt`, { modifiers: ['alt'] });
    }
    const opened = await pressPanel(finders.label(family), `press ${family.id} label`);
    if (!opened) {
      return false;
    }
    await driver.sleep(150);
    return pressPanel(
      `${POPOVER_QUERY}.flatMap((p) => [...p.querySelectorAll('button, [role="menuitem"]')]).find((e) => /^clear/i.test(e.textContent.trim())) || undefined`,
      `pick Clear in ${family.id} label menu`,
      { scroll: false },
    );
  }

  // (v) Typing and arrow keys in a field, then a switch mid-edit: the edit lands on the element
  // it was typed for, and the other element is untouched.
  async function typeThenSwitch({ element, other, family, typed, file }) {
    scenario = 'type-switch';
    await closeEverything();
    await select(element, 'canvas');
    await driver.settle();
    const otherStyleBefore = await (async () => {
      const saved = current;
      current = other;
      const style = await canvasStyle(family.property);
      current = saved;
      return style;
    })();
    const point = await driver.panelPoint(finders.field(family));
    if (point === undefined) {
      results.skipped.push({ scenario, action: `type ${family.id}`, why: 'field not found' });
      return;
    }
    await segment(
      `type ${typed} + ArrowUp x3 in ${family.id}`,
      'edit',
      async () => {
        await driver.pointerPress(point, { label: `press ${family.id} field` });
        await driver.sleep(60);
        await driver.menu('selectAll', 'select all');
        await driver.typeText(typed);
        for (let press = 0; press < 3; press += 1) {
          await driver.key('Up', { label: 'key ArrowUp' });
          await driver.sleep(30);
        }
      },
      { editedKey: family.key },
    );
    await segment(`switch ${element}->${other} mid-edit`, 'switch', () => select(other, 'canvas'));
    const otherStyleAfter = await canvasStyle(family.property);
    if (otherStyleAfter !== otherStyleBefore) {
      await report(
        {
          invariant: 'state-disagrees',
          summary: `typing in ${family.id} for ${element} then switching changed ${other}'s ${family.property}: ${otherStyleBefore} -> ${otherStyleAfter}`,
          evidence: {},
        },
        'switch mid-edit',
      );
    }
    // The project writes rem in a Lumos site, so the edit is checked on the canvas, in px.
    const expected = `${Number.parseFloat(typed) + 3}px`;
    const landed = await driver.canvasEvaluate(
      `getComputedStyle(document.querySelector(${JSON.stringify(ELEMENTS[element])})).getPropertyValue(${JSON.stringify(family.property)})`,
    );
    if (landed !== expected) {
      await report(
        {
          invariant: 'state-disagrees',
          summary: `typed ${typed} + 3 ArrowUp in ${family.id} on ${element}, switched away: it shows ${landed}, expected ${expected} (${file})`,
          evidence: {},
        },
        'switch mid-edit',
      );
    }
  }

  // (vi) Breakpoint switching: each query option, then Base again.
  async function breakpoints({ element, options }) {
    scenario = 'breakpoint';
    await closeEverything();
    await select(element, 'canvas');
    for (let index = 1; index <= options; index += 1) {
      await segment('open breakpoint menu', 'open', () => pressPanel(finders.context, 'press breakpoint menu'), { holdMs: 300 });
      if ((await openCount()) === 0) {
        continue;
      }
      await segment(`pick breakpoint option ${index}`, 'edit', () => pressPanel(finders.listOption(index), `pick option ${index}`, { scroll: false }));
      await closeEverything();
      await segment('back to Base', 'edit', async () => {
        await pressPanel(finders.context, 'press breakpoint menu');
        await driver.sleep(200);
        await pressPanel(finders.listOption(0), 'pick Base', { scroll: false });
      });
      await closeEverything();
    }
  }

  // (vii) The seeded random walk.
  async function randomWalk({ steps = WALK_STEPS_DEFAULT, families }) {
    scenario = 'random-walk';
    const random = seededRandom(seed);
    const pick = (list) => list[Math.floor(random() * list.length)];
    const elementNames = Object.keys(ELEMENTS);
    for (let walkStep = 0; walkStep < steps; walkStep += 1) {
      const roll = random();
      const family = pick(families);
      if (roll < 0.25) {
        const method = pick(['canvas', 'navigator', 'canvas']);
        const target = pick(elementNames.filter((name) => name !== current));
        const delay = pick(SWITCH_DELAYS_MS);
        const pressAfter = random() < 0.6;
        await segment(
          `walk ${walkStep}: switch to ${target} by ${method}${pressAfter ? `, press ${family.id} after ${delay} ms` : ''}`,
          'switch',
          async () => {
            await select(target, method);
            if (pressAfter) {
              await driver.sleep(delay);
              const point = await driver.panelPoint(finders.opener(family), { scroll: false });
              if (point !== undefined && point.hit) {
                await driver.pointerPress(point, { label: `press ${family.id}` });
              }
            }
          },
          { holdMs: pressAfter ? HOLD_OPEN_MS : 0 },
        );
      } else if (roll < 0.5) {
        const opener = pick(['opener', 'arrow', 'label', 'dot']);
        const finder = finders[opener](family);
        if (finder !== 'undefined') {
          await segment(`walk ${walkStep}: open ${family.id} ${opener}`, 'open', () => pressPanel(finder, `press ${family.id} ${opener}`), {
            holdMs: HOLD_OPEN_MS,
          });
        }
      } else if (roll < 0.7) {
        const exitPath = pick(EXIT_PATHS);
        await segment(`walk ${walkStep}: exit by ${exitPath}`, exitPath === 'canvas-press-other' ? 'switch' : 'look', () => exitBy(exitPath));
        await checkFocusAfter(exitPath, `walk ${walkStep}`);
      } else if (roll < 0.8) {
        await segment(`walk ${walkStep}: hover picker row`, 'preview', async () => {
          const point = await driver.panelPoint(finders.pickerItem(Math.floor(random() * 4)), { scroll: false });
          if (point !== undefined) {
            await driver.hover(point, 'hover picker row');
          }
        });
      } else if (roll < 0.88) {
        const keyCode = pick(['Escape', 'Tab', 'Down', 'Up']);
        await segment(`walk ${walkStep}: key ${keyCode}`, keyCode === 'Down' || keyCode === 'Up' ? 'switch' : 'look', () =>
          driver.key(keyCode, { label: `key ${keyCode}` }),
        );
      } else if (roll < 0.94) {
        const point = await driver.panelPoint(finders.neutral, { scroll: false });
        if (point !== undefined) {
          await segment(`walk ${walkStep}: scroll panel`, 'look', () =>
            driver.wheel({ x: point.x, y: point.y + 250 }, random() < 0.5 ? -240 : 240, 'scroll panel'),
          );
        }
      } else {
        await segment(`walk ${walkStep}: wait`, 'look', () => driver.sleep(pick([16, 120, 600])));
      }
    }
    await closeEverything();
  }

  // Evidence: the real painted frames of the panel across a switch (and a press after it).
  async function filmSwitches({ pairs, family, delayMs }) {
    scenario = 'film';
    for (const [from, to] of pairs) {
      await closeEverything();
      await select(from, 'canvas');
      await driver.settle();
      if (family !== undefined) {
        await reloadCanvas();
        await driver.panelPoint(finders.opener(family));
        await driver.settle();
      }
      const rect = await driver.evaluate(
        `(() => { const r = document.querySelector('.embed-editor_root').getBoundingClientRect(); return { x: Math.max(0, r.left - 12), y: 56, width: Math.min(innerWidth - Math.max(0, r.left - 12), r.width + 24), height: innerHeight - 56 }; })()`,
      );
      const directory = path.join(outDirectory, `film-${throttle}x-${from}-to-${to}${family === undefined ? '' : `-press-${family.id}`}`);
      await driver.film(directory, rect, FILM_AFTER_MS, async () => {
        await select(to, 'canvas');
        if (family !== undefined) {
          await driver.sleep(delayMs);
          const point = await driver.panelPoint(finders.opener(family), { scroll: false });
          if (point !== undefined && point.hit) {
            await driver.pointerPress(point, { label: `press ${family.id}` });
          }
        }
      });
      results.films.push(directory);
      await driver.settle();
    }
  }

  return {
    results,
    filmSwitches,
    setThrottle: (rate) => {
      throttle = rate;
    },
    begin,
    learnNavigator,
    switchMatrix,
    switchOnly,
    popoverMatrix,
    rapidToggle,
    hoverPreview,
    editCycle,
    typeThenSwitch,
    breakpoints,
    randomWalk,
  };
}

module.exports = { createRunner, seededRandom, ELEMENTS, FAMILIES, SWITCH_DELAYS_MS, EXIT_PATHS };
