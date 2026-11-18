// Copy, cut, paste and drop in a Style panel value field that draws variables as chips.
//
//   node test/renderer/style/tokenFieldClipboard.test.js
//
// Goal: the text a field's selection is copied as is the CSS it stands for, byte for byte, with
// each purple chip written back as the `var(--name)` it was made from; and a paste or drop of
// that text draws every reference in it as a chip again, while the value written is the raw
// text. The reported case: select all in the Custom value box over
// `color-mix(in srgb, red 10%, transparent var(--max-width-full))` and copy; the chip did not
// come along, because the browser copies what a chip draws (its short name), not what it is.
//
// Method: the real LiveInput (the field behind Width, Gap, colours and the rest; the big Custom
// value box is the same TokenField) is mounted in a hidden Electron window over a project whose
// `<style>` declares five variables. Clipboard events are dispatched as a person's shortcut
// produces them, a ClipboardEvent carrying a DataTransfer, and what the field put on it is read
// back; one round trip also goes through the window's own Select All, Copy and Paste commands
// and the system clipboard (saved before and put back after). Undo is the real ⌘Z / Ctrl+Z key.
// Every value the field writes (live and on leaving) is recorded; the last is the stylesheet
// write. Cases: select-all copy of twenty values (chips at the start, middle and end, welded
// and space-separated chips, a fallback, an unknown variable, no variable); partial selections
// that start and end beside a chip; cut; paste of a known reference (a chip with its catalog
// value), an unknown one (a chip by its name, as a typed one reads back), several and nested
// ones, multi-line text and an unclosed `var(` (text, no crash); paste over a selection; undo of
// a paste and of a cut; drag out and drop in; and copy then paste is the identity for all twenty.
// Set STACKI_CLIPBOARD_SHOTS to a folder to keep screenshots of the select-all and the paste.

const fs = require('fs');
const path = require('path');
const { ROOT, repoPath } = require('../../helpers/sources.js');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) {
    failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  }
};

const CATALOG = ':root { --brand: #7c3aed; --max-width-full: 80rem; --space-1: 0.25rem; --space-2: 0.5rem; --radius: 4px; }';
// The values copied and pasted back; the reported one first.
const ROUND_TRIP = [
  'color-mix(in srgb, red 10%, transparent var(--max-width-full))',
  'var(--brand)',
  'var(--space-1) var(--space-2)',
  'calc(var(--space-1) + var(--space-2))',
  'var(--space-1, 4px)',
  'calc(100% - var(--max-width-full))',
  '10px var(--space-2)',
  'var(--space-1) 10px',
  'min(var(--max-width-full), 100%)',
  'clamp(var(--space-1), 2vw, var(--space-2))',
  'var(--unknown-thing)',
  '1px solid var(--brand)',
  'var(--space-1)var(--space-2)',
  'calc(var(--space-1) * 2)',
  'linear-gradient(var(--brand), transparent)',
  '0 0 0 1px var(--brand)',
  'var(--space-2) var(--space-1) var(--space-2)',
  'max(var(--radius), 2px)',
  'calc(var(--space-1) + var(--space-2) + var(--radius))',
  'auto',
];
// Fields the edits below start from, after the round-trip ones.
const EDITS = {
  cut: 'color-mix(in srgb, red 10%, transparent var(--max-width-full))',
  known: 'auto',
  unknown: 'auto',
  several: 'auto',
  multiline: 'auto',
  unclosed: 'auto',
  over: 'calc(var(--space-1) * 2)',
  native: 'color-mix(in srgb, red 10%, transparent var(--max-width-full))',
  drop: '',
  // Last: the Custom value box, which keeps line breaks.
  box: '',
};
const FIELDS = [...ROUND_TRIP, ...Object.values(EDITS)];
const editIndex = (name) => ROUND_TRIP.length + Object.keys(EDITS).indexOf(name);
const REFERENCE = /var\(\s*--[A-Za-z0-9_-]+[^)]*\)/gi;
const referenceCount = (text) => [...text.matchAll(REFERENCE)].length;

(async () => {
  const esbuild = require('esbuild');
  const buildDirectory = repoPath('node_modules/.stacki-test/field-clipboard');
  fs.mkdirSync(buildDirectory, { recursive: true });

  const entry = `
    import React from 'react'
    import { createRoot } from 'react-dom/client'
    import LiveInput from './src/features/style/components/LiveInput'
    import { connectCustomField } from './src/features/style/VariableConnect'
    import { setHost } from './src/features/style/model/host'
    import './src/features/style/tokens.css'
    import './src/features/style/utilities.css'
    import './src/features/style/embedEditor.css'

    // No project path: the catalog is read from the open page's <style> alone, with no IPC to answer.
    // The one preload method the catalog read calls: a change notice that never comes.
    window.avb = { onCssChanged: () => () => {} }
    setHost({ projectPath: '', nodes: [{ kind: 'raw', name: 'style', inner: ${JSON.stringify(CATALOG)} }], selectedId: null, files: [], astroFiles: [] })
    const fields = ${JSON.stringify(FIELDS)}
    window.saved = fields.map(() => [])
    const record = (index) => (value) => window.saved[index].push(value)
    const field = (index) => document.querySelector('#field-' + index + ' [contenteditable]')
    // The field's text with each chip as one mark, as the field counts it.
    const marked = (index) => {
      let out = ''
      const walk = (node) => node.childNodes.forEach((child) => {
        if (child.nodeType === 3) { out += child.textContent }
        else if (child.dataset && child.dataset.chip !== undefined) { out += '\\u0000' }
        else { walk(child) }
      })
      walk(field(index))
      return out
    }
    // A selection from one mark offset to another, a chip counting as one.
    const select = (index, from, to) => {
      const root = field(index)
      // A person selects in the field they are in.
      root.focus()
      const range = document.createRange()
      let at = 0
      let started = false
      let ended = false
      const visit = (node) => node.childNodes.forEach((child) => {
        if (ended) { return }
        if (child.nodeType === 3) {
          const length = child.textContent.length
          if (!started && from <= at + length) { range.setStart(child, from - at); started = true }
          if (started && to <= at + length) { range.setEnd(child, to - at); ended = true }
          at += length
        } else if (child.dataset && child.dataset.chip !== undefined) {
          if (!started && from === at) { range.setStartBefore(child); started = true }
          at += 1
          if (started && to === at) { range.setEndAfter(child); ended = true }
        } else { visit(child) }
      })
      visit(root)
      const selection = getSelection()
      selection.removeAllRanges()
      selection.addRange(range)
      return started && ended
    }
    const selectAll = (index) => { field(index).focus(); getSelection().selectAllChildren(field(index)) }
    const clip = (index, type, text) => {
      const data = new DataTransfer()
      if (text !== undefined) { data.setData('text/plain', text) }
      const event = new ClipboardEvent(type, { clipboardData: data, bubbles: true, cancelable: true })
      field(index).dispatchEvent(event)
      return { plain: data.getData('text/plain'), html: data.getData('text/html'), handled: event.defaultPrevented }
    }
    const chips = (index) => [...field(index).querySelectorAll('[data-chip]')].map((chip) => ({
      binding: chip.dataset.binding, name: chip.textContent, value: chip.dataset.value === undefined ? '' : chip.dataset.value,
    }))
    const drop = (index, text) => {
      const root = field(index)
      const box = root.getBoundingClientRect()
      const data = new DataTransfer()
      data.setData('text/plain', text)
      const event = new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true, clientX: box.x + 4, clientY: box.y + box.height / 2 })
      root.dispatchEvent(event)
      return event.defaultPrevented
    }
    const dragOut = (index) => {
      const data = new DataTransfer()
      field(index).dispatchEvent(new DragEvent('dragstart', { dataTransfer: data, bubbles: true, cancelable: true }))
      return data.getData('text/plain')
    }
    // The Custom value box: its <textarea> wrapped the way CustomValueEditor wraps it.
    function Box({ index, value }) {
      const [text, setText] = React.useState(value)
      const write = (next) => { setText(next); record(index)(next) }
      return connectCustomField(<textarea className="u-input" rows={4} value={text} onChange={(event) => write(event.target.value)} />, 'width', undefined, undefined, write)
    }
    window.probe = { field, marked, select, selectAll, clip, chips, drop, dragOut, leave: (index) => field(index).blur() }
    createRoot(document.getElementById('root')).render(
      <div className="embed-editor_root" style={{ width: 560, padding: 12 }}>
        {fields.map((value, index) => (
          <div key={index} id={'field-' + index} className="embed-editor_rule" style={{ display: 'flex', width: 520, marginBottom: 8 }}>
            {index === fields.length - 1 ? <Box index={index} value={value} /> : <LiveInput value={value} busy={false} ariaLabel={'Field ' + index} prop="width" onLive={record(index)} onCommit={record(index)} />}
          </div>
        ))}
      </div>
    )
  `;
  await esbuild.build({
    stdin: { contents: entry, resolveDir: ROOT, loader: 'jsx' },
    outfile: path.join(buildDirectory, 'bundle.js'),
    bundle: true,
    format: 'iife',
    jsx: 'automatic',
    logLevel: 'silent',
  });
  fs.writeFileSync(
    path.join(buildDirectory, 'index.html'),
    '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="bundle.css">' +
      '<style>body{margin:0;background:#111}</style><div id="root"></div>' +
      '<script src="bundle.js"></script>',
  );

  const electronPath = (() => {
    try {
      return require('electron');
    } catch {
      return undefined;
    }
  })();
  if (typeof electronPath !== 'string') {
    console.log('token-field-clipboard: skipped — no Electron to run the field in');
    return;
  }

  const shots = process.env['STACKI_CLIPBOARD_SHOTS'] ?? '';
  const scriptPath = path.join(buildDirectory, 'probe.js');
  fs.writeFileSync(
    scriptPath,
    `const { app, BrowserWindow, clipboard } = require('electron');
     const fs = require('fs');
     const path = require('path');
     app.on('window-all-closed', () => app.quit());
     const { pollUntil, waitFor } = require(${JSON.stringify(repoPath('test/helpers/waitFor.js'))});
     app.whenReady().then(async () => {
       const win = new BrowserWindow({ show: false, width: 600, height: 1400 });
       await win.loadFile(${JSON.stringify(path.join(buildDirectory, 'index.html'))});
       win.webContents.focus();
       const js = (code) => win.webContents.executeJavaScript(code);
       const call = (name, ...args) => js('window.probe.' + name + '(' + args.map((arg) => JSON.stringify(arg)).join(',') + ')');
       const out = {};
       const shots = ${JSON.stringify(shots)};
       const shoot = async (name) => {
         if (shots !== '') {
           // A hidden window paints on request: ask for a frame and wait for it before the capture.
           win.webContents.invalidate();
           await js('new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))');
           const image = await win.webContents.capturePage({ x: 0, y: 0, width: 600, height: 60 });
           fs.writeFileSync(path.join(shots, name + '.png'), image.toPNG());
         }
       };
       const fields = ${JSON.stringify(FIELDS)};
       const last = (index) => js('window.saved[' + index + '].at(-1)');
       // Leaving a field writes it; wait until that write is the one recorded last.
       const leave = async (index) => {
         await call('leave', index);
         let countLast = -1;
         await waitFor({ what: 'field ' + index + ' to commit', read: () => js('window.saved[' + index + '].length'), until: (count) => {
           const still = count > 0 && count === countLast;
           countLast = count;
           return still;
         } });
         return last(index);
       };
       const undoKey = () => {
         const modifiers = [process.platform === 'darwin' ? 'meta' : 'control'];
         win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'z', modifiers });
         win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'z', modifiers });
       };
       // The catalog is read once the page has a project: the reported chip carries its value.
       await waitFor({ what: 'the catalog to reach the chips', read: () => call('chips', 0), until: (chips) => chips.length === 1 && chips[0].value === '80rem' });

       // Select all, copy, then paste what was copied over the whole field.
       out.trip = [];
       for (let index = 0; index < ${ROUND_TRIP.length}; index++) {
         await call('selectAll', index);
         if (index === 0) await shoot('select-all-with-chip');
         const copied = await call('clip', index, 'copy');
         await call('selectAll', index);
         const pasted = await call('clip', index, 'paste', copied.plain);
         const chips = await call('chips', index);
         if (index === 0) await shoot('pasted-chip-back');
         out.trip.push({ copied, pasted, chips, written: await leave(index) });
       }

       // Partial selections in the reported value: from text to the chip, from the chip on, text only.
       const reported = await call('marked', 0);
       const mark = reported.indexOf('\\u0000');
       out.partial = [];
       for (const [from, to] of [[reported.indexOf('transparent'), mark + 1], [mark, reported.length], [0, 5], [mark, mark + 1]]) {
         const selected = await call('select', 0, from, to);
         out.partial.push({ selected, copied: await call('clip', 0, 'copy') });
       }
       // Adjacent chips: the space between them, and the second chip alone.
       const adjacent = await call('marked', 2);
       const first = adjacent.indexOf('\\u0000');
       const second = adjacent.indexOf('\\u0000', first + 1);
       await call('select', 2, first, second + 1);
       out.adjacentBoth = await call('clip', 2, 'copy');
       await call('select', 2, second, second + 1);
       out.adjacentSecond = await call('clip', 2, 'copy');

       // Cut from the text before the chip through the chip, then undo it.
       const cut = ${editIndex('cut')};
       await call('selectAll', cut);
       const cutMarked = await call('marked', cut);
       await call('select', cut, cutMarked.indexOf('transparent'), cutMarked.indexOf('\\u0000') + 1);
       out.cut = await call('clip', cut, 'cut');
       out.cutChips = await call('chips', cut);
       out.cutWritten = await leave(cut);
       await js('window.probe.field(' + cut + ').focus()');
       undoKey();
       await waitFor({ what: 'undo to bring the cut chip back', read: () => call('chips', cut), until: (chips) => chips.length === 1 });
       out.cutUndone = await leave(cut);

       // Pastes into a field: one known reference, one unknown, several, multi-line, unclosed.
       const pastes = {
         known: 'var(--brand)',
         unknown: 'var(--nope)',
         several: 'color-mix(in srgb, var(--brand) 40%, calc(var(--space-1) + var(--space-2)))',
         multiline: 'calc(\\r\\n  var(--space-1) +\\r\\n  var(--space-2)\\r\\n)',
         unclosed: 'calc(var(--space-1',
       };
       out.pastes = {};
       for (const [name, text] of Object.entries(pastes)) {
         const index = ${JSON.stringify(Object.fromEntries(Object.keys(EDITS).map((name) => [name, editIndex(name)])))}[name];
         await call('selectAll', index);
         const pasted = await call('clip', index, 'paste', text);
         out.pastes[name] = { pasted, chips: await call('chips', index), written: await leave(index) };
       }
       // The Custom value box keeps the line breaks a one-line field joins; it writes as it changes.
       const box = ${editIndex('box')};
       await call('selectAll', box);
       await call('clip', box, 'paste', pastes.multiline);
       out.boxChips = await call('chips', box);
       out.boxWritten = await last(box);

       // Paste over a selected chip, then undo: one step brings the old chip back.
       const over = ${editIndex('over')};
       await call('selectAll', over);
       const overMarked = await call('marked', over);
       await call('select', over, overMarked.indexOf('\\u0000'), overMarked.indexOf('\\u0000') + 1);
       await call('clip', over, 'paste', 'var(--space-2)');
       out.overChips = await call('chips', over);
       out.overDraft = (await pollUntil({ what: 'the paste over the chip to be written', read: () => last(over), until: (value) => value === 'calc(var(--space-2) * 2)' })).value;
       undoKey();
       await waitFor({ what: 'undo to restore the replaced chip', read: () => call('chips', over), until: (chips) => chips.length === 1 && chips[0].binding === 'var(--space-1)' });
       out.overUndone = await leave(over);

       // The window's own Select All, Copy and Paste, through the system clipboard.
       // This Electron's clipboard reads and writes text, asynchronously; the text a person had there is put back.
       const saved = await clipboard.readText();
       try {
         const native = ${editIndex('native')};
         await js('window.probe.field(' + native + ').focus()');
         win.webContents.selectAll();
         await clipboard.clear();
         win.webContents.copy();
         await waitFor({ what: 'Copy to reach the clipboard', read: () => clipboard.readText(), until: (text) => text !== '' });
         out.nativeCopied = await clipboard.readText();
         await call('selectAll', native);
         win.webContents.paste();
         await waitFor({ what: 'Paste to draw the chip', read: () => call('chips', native), until: (chips) => chips.length === 1 });
         out.nativeChips = await call('chips', native);
         out.nativeWritten = await leave(native);
       } finally {
         if (saved === '') {
           await clipboard.clear();
         } else {
           await clipboard.writeText(saved);
         }
       }

       // Drag the reported value out, and drop it into an empty field.
       await call('selectAll', 0);
       out.dragged = await call('dragOut', 0);
       const drop = ${editIndex('drop')};
       out.dropped = await call('drop', drop, out.dragged);
       out.dropChips = await call('chips', drop);
       out.dropWritten = await leave(drop);
       console.log(JSON.stringify(out));
       app.quit();
     }).catch((error) => {
       console.error(String(error && error.stack ? error.stack : error));
       app.exit(1);
     });`,
  );

  if (shots !== '') {
    fs.mkdirSync(shots, { recursive: true });
  }
  const { spawnSync } = require('child_process');
  const run = spawnSync(electronPath, [scriptPath], { encoding: 'utf8', timeout: 120000 });
  const line = (run.stdout || '').split('\n').find((candidate) => candidate.trim().startsWith('{'));
  if (!line) {
    check('the probe ran in a browser', false, (run.stderr || run.stdout || '').slice(0, 800));
  } else {
    const out = JSON.parse(line);
    const reported = ROUND_TRIP[0];
    ROUND_TRIP.forEach((value, index) => {
      const trip = out.trip[index];
      check(`${JSON.stringify(value)}: select-all copy is the field's own`, trip.copied.handled === true);
      check(`${JSON.stringify(value)}: select-all copy is the CSS, byte for byte`, trip.copied.plain === value, `copied ${JSON.stringify(trip.copied.plain)}`);
      check(`${JSON.stringify(value)}: the copy is plain text only`, trip.copied.html === '', `html ${JSON.stringify(trip.copied.html)}`);
      check(`${JSON.stringify(value)}: the paste is the field's own`, trip.pasted.handled === true);
      check(
        `${JSON.stringify(value)}: every reference pasted back is a chip`,
        trip.chips.length === referenceCount(value),
        `chips ${JSON.stringify(trip.chips)}`,
      );
      check(`${JSON.stringify(value)}: copy then paste writes the same value`, trip.written === value, `written ${JSON.stringify(trip.written)}`);
    });
    const knownChip = out.trip[0].chips[0];
    check('the pasted reported chip is the catalog variable', knownChip !== undefined && knownChip.value === '80rem', JSON.stringify(knownChip));

    const partial = ['transparent var(--max-width-full)', 'var(--max-width-full))', 'color', 'var(--max-width-full)'];
    partial.forEach((expected, index) => {
      check(`partial selection ${index + 1} was made`, out.partial[index].selected === true);
      check(
        `partial selection copies ${JSON.stringify(expected)}`,
        out.partial[index].copied.plain === expected,
        `copied ${JSON.stringify(out.partial[index].copied.plain)}`,
      );
    });
    check('two adjacent chips copy with the space between', out.adjacentBoth.plain === 'var(--space-1) var(--space-2)', JSON.stringify(out.adjacentBoth.plain));
    check('the second of two adjacent chips copies alone', out.adjacentSecond.plain === 'var(--space-2)', JSON.stringify(out.adjacentSecond.plain));

    check('cut copies the text and the chip', out.cut.plain === 'transparent var(--max-width-full)', JSON.stringify(out.cut.plain));
    check('cut takes the chip out of the field', out.cutChips.length === 0, JSON.stringify(out.cutChips));
    check('cut writes what is left', out.cutWritten === 'color-mix(in srgb, red 10%, )', JSON.stringify(out.cutWritten));
    check('undo after a cut writes the value back', out.cutUndone === reported, JSON.stringify(out.cutUndone));

    const pastes = out.pastes;
    check('a known reference pastes as a chip', pastes.known.chips.length === 1, JSON.stringify(pastes.known.chips));
    check('a known reference pastes as its catalog variable', pastes.known.chips[0]?.value === '#7c3aed', JSON.stringify(pastes.known.chips));
    check('a known reference is written raw', pastes.known.written === 'var(--brand)', JSON.stringify(pastes.known.written));
    check(
      'an unknown reference is drawn by its name, as a typed one reads back',
      pastes.unknown.chips[0]?.name === 'nope',
      JSON.stringify(pastes.unknown.chips),
    );
    check('an unknown reference carries no catalog value', pastes.unknown.chips[0]?.value === '', JSON.stringify(pastes.unknown.chips));
    check('an unknown reference is written raw', pastes.unknown.written === 'var(--nope)', JSON.stringify(pastes.unknown.written));
    check('several and nested references paste as chips', pastes.several.chips.length === 3, JSON.stringify(pastes.several.chips));
    check(
      'several and nested references are written raw',
      pastes.several.written === 'color-mix(in srgb, var(--brand) 40%, calc(var(--space-1) + var(--space-2)))',
      JSON.stringify(pastes.several.written),
    );
    check('multi-line text pastes its references as chips', pastes.multiline.chips.length === 2, JSON.stringify(pastes.multiline.chips));
    check(
      'a one-line field joins pasted lines with a space',
      pastes.multiline.written === 'calc( var(--space-1) + var(--space-2) )',
      JSON.stringify(pastes.multiline.written),
    );
    check('the Custom value box draws pasted multi-line references as chips', out.boxChips.length === 2, JSON.stringify(out.boxChips));
    check('the Custom value box keeps the line breaks', out.boxWritten === 'calc(\n  var(--space-1) +\n  var(--space-2)\n)', JSON.stringify(out.boxWritten));
    check('an unclosed var( stays text', pastes.unclosed.chips.length === 0, JSON.stringify(pastes.unclosed.chips));
    check('an unclosed var( is written as pasted', pastes.unclosed.written === 'calc(var(--space-1', JSON.stringify(pastes.unclosed.written));

    check(
      'a paste over a selected chip replaces it',
      out.overChips.length === 1 && out.overChips[0].binding === 'var(--space-2)',
      JSON.stringify(out.overChips),
    );
    check('a paste over a selected chip writes the new reference', out.overDraft === 'calc(var(--space-2) * 2)', JSON.stringify(out.overDraft));
    check('one undo brings the replaced chip back', out.overUndone === 'calc(var(--space-1) * 2)', JSON.stringify(out.overUndone));

    check("the window's Copy puts the CSS on the system clipboard", out.nativeCopied === reported, JSON.stringify(out.nativeCopied));
    check("the window's Paste draws the chip again", out.nativeChips[0]?.binding === 'var(--max-width-full)', JSON.stringify(out.nativeChips));
    check("the window's Paste writes the raw value", out.nativeWritten === reported, JSON.stringify(out.nativeWritten));

    check('a drag carries the CSS', out.dragged === reported, JSON.stringify(out.dragged));
    check('a drop is the field’s own', out.dropped === true);
    check('a drop draws the chip', out.dropChips.length === 1, JSON.stringify(out.dropChips));
    check('a drop writes the raw value', out.dropWritten === reported, JSON.stringify(out.dropWritten));
  }

  if (failures.length) {
    console.error(`token-field-clipboard: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`token-field-clipboard: ${checked} passed  [chips copy as var() and paste back as chips]`);
})();
