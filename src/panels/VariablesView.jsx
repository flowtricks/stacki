import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CloseIcon, CheckIcon, CopyIcon, DragIcon, EaseIcon, MoreIcon, PencilIcon, PlusIcon, TrashIcon } from '../ui/Icons.jsx';
import useListReorder from '../ui/useListReorder.js';
import useDismiss from '../ui/useDismiss.js';
import MoreMenu from '../ui/MoreMenu.jsx';
import VariableTypeIcon from '../ui/VariableTypeIcon.jsx';
import FluidBadge from '../ui/FluidBadge.jsx';
import { fluidCheck, resolveValue } from '../fluid.js';
import ColorSwatch from '../style-panel/components/ColorSwatch';
import VariableConnect from '../style-panel/VariableConnect';
import EasingEditor, { MiniCurve } from '../style-panel/EasingEditor';
import { easingToBezier, isEasing } from '../style-panel/lib/transition';
import { setHost } from '../style-panel/lib/host';
import { popupBox, POPUP_GAP } from '../ui/Dropdown.jsx';
import CustomValue, { doesNotFit, isLong, withBinding } from '../ui/CustomValueEditor.jsx';
import '../style-panel/utilities.css';

// The variables sheet: one group of a stylesheet, as tables.
//
// Two kinds of table, because there are two ways a set of variables can be the
// same thing more than once (see electron/cssVars.js):
//
//   modes    one rule per column — a light theme, a dark one, a brand one —
//            with the variable names down the side. What you want to see is
//            one name across all of them at once, which is a row.
//   matrix   one rule, but names that share their endings: `--h1-line-height`
//            and `--text-small-line-height` are one property of two things. The
//            things are the columns and the properties are the rows.
//
// Anything that is neither is a plain list, which is the same table with one
// column. A value that is only a reference to another variable shows that
// variable's name rather than its own text, because that is what was written
// and what the author would go looking for.

const SAVE_ON = ['Enter', 'Tab'];

// Everything this sheet writes goes over the preload bridge, and the bridge is
// only rebuilt when the app restarts — so a method added since the running app
// started is simply not there. Left alone, that throws inside an async handler
// and looks exactly like a feature that does nothing: pressing the button, and
// nothing happening, with nothing said. It says so instead.
const RESTART = 'Stacki needs to be restarted before this can be used.';

/**
 * What went wrong, in words that say what to do about it.
 *
 * There are two ways a call can be missing, and they look nothing alike. The
 * bridge is built when the app starts, so a method added since is simply not
 * there — that one is caught before calling. The other is worse: reloading the
 * window rebuilds the bridge but NOT the main process behind it, so the method
 * exists, the call goes out, and the answer is "No handler registered for
 * 'css:moveHeading'" — which reads like a bug in the feature rather than an app
 * that is half a version behind itself. Same cause, same remedy.
 */
export function friendlyError(err) {
  const text = String(err?.message || err).replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '');
  return /No handler registered/i.test(text) ? RESTART : text;
}

async function bridge(name, payload) {
  const call = window.avb?.[name];
  if (typeof call !== 'function') {
    return { ok: false, error: RESTART };
  }
  try {
    return (await call(payload)) || { ok: true };
  } catch (err) {
    return { ok: false, error: friendlyError(err) };
  }
}



// And one curve editor, for the same reason: each cell owns its own, so the
// sheet holds the pointer and opening another closes the one before it —
// keeping whatever that one had been dragged to.
let closeOpenCurve = null;




// Every value is an editable field, and a value that references another
// variable draws that reference as a purple chip inside the field — the same
// control the style panel uses (VariableConnect), so a chip behaves the same in
// both places: click it to swap the variable, type in front of or behind it
// (`calc(`, `!important`), backspace to remove it.
//
// The colour box is beside the field rather than in it, because it is not part
// of the text: clicking it opens the picker, and what the picker returns is
// written as the value.
function Cell({ cell, onSave, fluidOf, onDraft }) {
  const [draft, setDraft] = useState(null);
  const [custom, setCustom] = useState(null); // the anchor rect while open
  const [curve, setCurve] = useState(null); // {left,width} of the sheet, while the editor is open
  const value = draft ?? cell?.value ?? '';

  useEffect(() => setDraft(null), [cell?.value, cell?.valueStart]);

  // Every keystroke goes up as well as into the field: another row's badge may
  // be about this value.
  useEffect(() => {
    if (!cell?.name) return undefined;
    onDraft?.(cell.name, draft);
    return () => onDraft?.(cell.name, null);
  }, [cell?.name, draft, onDraft]);

  if (!cell) return <div className="var-cell empty">—</div>;

  const commit = async (next = value) => {
    setDraft(null);
    if (next === cell.value) return;
    await onSave(cell, next);
  };

  // Whatever `commit` is this render — the closer below outlives the render it
  // was made in, and must not write a value from an older one.
  const commitRef = useRef(commit);
  commitRef.current = commit;
  useEffect(() => {
    if (!curve) return undefined;
    closeOpenCurve?.(); // never two at once
    const close = () => {
      setCurve(null);
      commitRef.current();
    };
    closeOpenCurve = close;
    return () => {
      if (closeOpenCurve === close) closeOpenCurve = null;
    };
  }, [curve]);

  const isColor = !!cell.color || cell.unknownColor;

  // Where a press lands decides what it does. The field is not always the
  // <input>: as soon as a value carries a variable, the token editor takes its
  // place and the input is hidden behind it — so a long value full of
  // references (which is most long values) never saw the press at all when this
  // was bound to the input. It is bound to the cell instead.
  //
  // Two things keep their own press wherever they are: the colour box and the
  // connect dot, which do not edit the value at all. A chip keeps its own only
  // while the value FITS — in a cell showing half an expression the chip is
  // most of what there is to click, and swapping a variable you cannot see the
  // rest of is not what that press means. It opens the value instead, where the
  // chip is there to click at full size.
  const alwaysOwn = (target) =>
    target instanceof Element && !!target.closest('.embed-editor_varconnect-dot, .u-color-swatch');

  const openCustom = (node) => setCustom(node.getBoundingClientRect());

  return (
    <div
      className="var-cell"
      onMouseDownCapture={(e) => {
        if (custom || alwaysOwn(e.target)) return;
        // Fits: everything in the field keeps its own press, chip included.
        if (!doesNotFit(e.currentTarget, value)) return;
        e.preventDefault();
        // And nothing else gets this press. preventDefault only cancels the
        // browser's own reaction (focus, caret); the chip's handler is another
        // listener further down and ran anyway — so a press on the chip of a
        // value too long to read opened the variable picker ON TOP of the
        // editor it had just opened. Stopping here in the capture phase means
        // the press reaches nothing inside the cell.
        e.stopPropagation();
        openCustom(e.currentTarget);
      }}
      onKeyDownCapture={(e) => {
        // The same shortcut, wherever the caret is — the token editor holds it
        // as often as the input does.
        if (e.key !== '=' || custom) return;
        e.preventDefault();
        openCustom(e.currentTarget);
      }}
    >
      {/* A timing function is a curve, and a curve is easier to judge by eye
          than by four numbers — so it gets the same editor the style panel's
          transitions use. Beside the value, like a colour's swatch: the value
          itself stays editable as text. */}
      {isEasing(value) && (
        <button
          type="button"
          className="var-ease"
          title={`Edit the curve for ${cell.name}`}
          aria-label={`Edit the curve for ${cell.name}`}
          // The editor belongs over the sheet it was opened from, not over the
          // panel beside it — so it is handed the sheet's own box. Read at the
          // press rather than held in state: the sheet is resizable.
          onClick={(e) => {
            const sheet = e.currentTarget.closest('.vars-view') || e.currentTarget.closest('.cms-view');
            const box = sheet?.getBoundingClientRect();
            // Always framed, even when the sheet measures nothing (a mid-layout
            // read): the window is the fallback, never the style panel's box —
            // the shared backdrop is pinned to that panel, and a popup opened
            // from here has nothing to do with it.
            setCurve(
              box?.width
                ? { left: box.left, width: box.width }
                : { left: 0, width: typeof window === 'undefined' ? 0 : window.innerWidth }
            );
          }}
        >
          {/* The value's own curve, at glyph size — the same drawing the
              editor's presets use, so the button says which ease it opens. */}
          <MiniCurve b={easingToBezier(value)} />
        </button>
      )}
      {curve && (
        <EasingEditor
          value={value}
          frame={curve}
          // Dragging a control point emits a value per frame. Those land in the
          // draft so the field follows the curve, and the file is written once,
          // when the editor closes — a drag is one edit, not sixty.
          onChange={(timing) => setDraft(timing)}
          onClose={() => {
            setCurve(null);
            commit();
          }}
        />
      )}
      {isColor && (
        <ColorSwatch
          // The colour, not the word "transparent". `cell.color` is a literal
          // the app can paint on its own; everything else is a value that
          // refers to something — `color-mix(in srgb, var(--brand-500), white
          // 80%)` is the ordinary way to write a tint — and those were handed
          // over as the string "transparent", which is a colour, so the swatch
          // painted it: a chequerboard beside a row whose colour is perfectly
          // knowable.
          //
          // Handed the value instead, the swatch resolves it the way every
          // other swatch in the app does (see computed-color): substituted text
          // paints anywhere, and a reference that leads outside this file is
          // answered by the page.
          value={cell.color || cell.resolved || value}
          ariaLabel={`Choose the colour for ${cell.name}`}
          // Dragging in the picker fires live updates; only the settled value
          // is written, or a drag would be a hundred edits to the file.
          onChange={(color, live) => {
            if (live) setDraft(color);
            else commit(color);
          }}
        />
      )}
      <VariableConnect
        className="is-fill"
        code
        onPick={(binding) => commit(withBinding(value, binding))}
        // The rich field commits on blur, which is right for writing and wrong
        // for watching: a badge about this value has to answer to the keystroke.
        onDraft={(next) => setDraft(next)}
      >
        <input
          className="var-input"
          value={value}
          spellCheck={false}
          title={`${cell.name}: ${cell.value}${cell.resolved ? `\n→ ${cell.resolved}` : ''}`}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => !custom && commit()}
          // Arriving by keyboard: the value is what you came to replace.
          //
          // Only when the focus is really this input's. The rich field calls
          // this handler itself when IT takes focus (VariableConnect hands it a
          // stand-in event pointing here), and select() on an input focuses it
          // — so clicking a value moved the caret into the hidden input behind
          // the field, where nothing typed and nothing showed.
          onFocus={(e) => {
            if (document.activeElement !== e.currentTarget) return;
            e.currentTarget.select();
          }}
          onMouseDown={(e) => {
            // A value too long for its column edits in the bigger box instead —
            // clicking it there would put the caret in a slot showing a third
            // of what is being changed.
            if (isLong(value)) {
              e.preventDefault();
              setCustom(e.currentTarget.getBoundingClientRect());
              return;
            }
            // Clicking in takes the whole value, because replacing it is what
            // you are nearly always here to do. Selecting on focus alone does
            // not hold — the click that caused the focus then puts the caret
            // where it landed and drops the selection — so the caret placement
            // is what gets skipped. A second click, once the field already has
            // focus, behaves normally and can place the caret or drag over
            // part of the value.
            if (document.activeElement === e.currentTarget) return;
            e.preventDefault();
            e.currentTarget.focus();
            e.currentTarget.select();
          }}
          onKeyDown={(e) => {
            if (e.key === '=') {
              e.preventDefault();
              setCustom(e.currentTarget.getBoundingClientRect());
              return;
            }
            if (SAVE_ON.includes(e.key)) {
              e.preventDefault();
              e.currentTarget.blur();
            }
            if (e.key === 'Escape') {
              e.preventDefault();
              setDraft(null);
            }
          }}
        />
      </VariableConnect>
      {/* Only drawn when the value is a fluid clamp with something wrong with
          it — see fluidCheck in electron/cssVars.js. */}
      <FluidBadge fluid={fluidOf ? fluidOf(cell) : cell.fluid} />
      {custom && (
        <CustomValue
          value={value}
          label={cell.name}
          anchor={custom}
          onCancel={() => {
            setCustom(null);
            setDraft(null);
          }}
          onSave={(next) => {
            setCustom(null);
            commit(next);
          }}
        />
      )}
    </div>
  );
}

export default function VariablesView({ project, selected, hidden, onClose, showToast, onRecordUndo }) {
  const [files, setFiles] = useState([]);
  const [values, setValues] = useState({});
  const [saved, setSaved] = useState(false);
  const [query, setQuery] = useState('');
  // What is being typed, by variable name, before it has been saved. A clamp()
  // is only as accessible as the numbers it references, and those are usually
  // three rows further down the same table — so the badge has to be recomputed
  // from the draft, not from the file.
  const [drafts, setDrafts] = useState({});
  // `move` is defined above the point where the selected file is worked out, and
  // a drop needs to know which file it is writing to — so it reads it from here.
  const fileRef = useRef(null);
  const firstSelectorRef = useRef(':root');


  const refresh = useCallback(async () => {
    const result = await window.avb.cssVariables(project.path);
    setFiles(result?.files || []);
    setValues(result?.values || {});
    setDrafts({});
  }, [project.path]);

  useEffect(() => {
    refresh();
    return window.avb.onCssChanged(refresh);
  }, [refresh]);

  // The variable picker inside a field reads the project from the style panel's
  // shared host, which is set while that panel is mounted — and it is not,
  // unless an element is selected. Set it here too, so a chip can be swapped
  // from this sheet on its own.
  useEffect(() => {
    setHost({ projectPath: project.path });
  }, [project.path]);

  const file = files.find((f) => f.rel === selected?.file);
  const group = file?.groups?.[selected?.index];
  fileRef.current = file || null;
  firstSelectorRef.current = group?.columns?.[0]?.selector || ':root';

  // Undo, for the things this sheet writes.
  //
  // These edits do not go through the page model — they rewrite stylesheets on
  // disk — so ⌘Z would step straight past them to the last layout change unless
  // each one hands the app a way back. Deleting a group in particular is one
  // keystroke away from being gone, and it was.
  //
  // A single-file edit remembers the file as it was and as it became: writing
  // either one back IS the undo (and the redo), which is exact and needs no
  // second implementation of the edit to run backwards.
  const fileText = useCallback(
    async (rel) => {
      const result = await bridge('readStyleFile', `${project.path}/${rel}`);
      return typeof result?.css === 'string' ? result.css : null;
    },
    [project.path]
  );
  const putFiles = useCallback(
    async (texts) => {
      for (const [rel, css] of Object.entries(texts)) {
        if (css == null) continue;
        await bridge('writeStyleFile', { filePath: `${project.path}/${rel}`, css });
      }
      await refresh();
    },
    [project.path, refresh]
  );
  /**
   * Run an edit and put it on the undo stack, as the text of the files it
   * touched before and after. A rename reaches every file that mentions the
   * name and a group can straddle two stylesheets, so the unit is a set of
   * files rather than one — and reading them back is the only inverse that
   * doesn't need a second implementation of the edit to run backwards.
   *
   * `run` returns false to skip. `coalesceKey` collapses a burst into one step:
   * typing a value is one edit however many keystrokes it took.
   */
  const writeWithUndo = useCallback(
    async (rels, label, run, coalesceKey = null) => {
      const list = [...new Set((Array.isArray(rels) ? rels : [rels]).filter(Boolean))];
      const read = async () =>
        Object.fromEntries(await Promise.all(list.map(async (rel) => [rel, await fileText(rel)])));
      const before = list.length ? await read() : {};
      const ok = await run();
      if (ok === false || !list.length) return;
      const after = await read();
      const changed = list.filter(
        (rel) => before[rel] != null && after[rel] != null && before[rel] !== after[rel]
      );
      if (!changed.length) return;
      const only = (texts) => Object.fromEntries(changed.map((rel) => [rel, texts[rel]]));
      onRecordUndo?.({
        label,
        coalesceKey,
        undo: () => putFiles(only(before)),
        redo: () => putFiles(only(after)),
      });
    },
    [fileText, putFiles, onRecordUndo]
  );

  const save = useCallback(
    async (cell, value) => {
      // One step per value, not per keystroke: the field writes as it is typed
      // and the burst collapses on the key.
      await writeWithUndo(
        cell.file,
        'the value',
        async () => {
          const result = await bridge('setCssVariable', {
            projectPath: project.path,
            file: cell.file,
            valueStart: cell.valueStart,
            valueEnd: cell.valueEnd,
            expect: cell.value,
            value,
          });
          if (!result.ok) {
            showToast?.(result.error || 'Could not write that value.', 'error');
            await refresh();
            return false;
          }
          setSaved(true);
          setTimeout(() => setSaved(false), 1200);
          await refresh();
          return true;
        },
        `var:${cell.file}:${cell.name}`
      );
    },
    [project.path, refresh, showToast, writeWithUndo]
  );

  // Dragging a row moves the declaration inside its rule — a row in a table of
  // modes is one name in several rules, so it moves in each of them.
  // A drop is either variables moving between groups, or a heading moving
  // between variables — which is the same file in both cases, so the same undo.
  const move = useCallback(
    async (slots, from, to) => {
      const plan = dropPlan(slots, from, to);
      if (!plan) return;
      if (plan.kind === 'rows') {
        if (!plan.moves.length) return;
        // Every file the plan names, not just the first: one name can be
        // declared in two stylesheets, and putting back half of a move is
        // worse than not putting it back at all.
        await writeWithUndo(plan.moves.map((m) => m.file), 'the move', async () => {
          const result = await bridge('moveCssVariables', { projectPath: project.path, moves: plan.moves });
          if (!result.ok) showToast?.(result.error || 'Could not move that.', 'error');
          await refresh();
          return result.ok;
        });
        return;
      }
      const anchor = plan.block.rows.map((row) => row.cells.find(Boolean)).find(Boolean);
      await writeWithUndo(fileRef.current?.rel, 'the group', async () => {
        const result = await bridge('moveCssHeading', {
          projectPath: project.path,
          file: fileRef.current?.rel,
          selector: anchor?.selector || firstSelectorRef.current,
          start: plan.block.titleStart,
          end: plan.block.titleEnd,
          expect: plan.block.title,
          before: plan.before,
        });
        if (!result.ok) showToast?.(result.error || 'Could not move that.', 'error');
        await refresh();
        return result.ok;
      });
    },
    [project.path, refresh, showToast, writeWithUndo]
  );

  // Dragging a group moves everything under its heading — the comment included
  // — in each rule the group appears in.
  const moveGroup = useCallback(
    async (list, from, to) => {
      const source = list[from];
      const target = to > from ? list[to] : list[to] ?? null;
      if (!source || source === target) return;
      const columns = source.rows[0]?.cells?.length || 1;
      const moves = [];
      for (let column = 0; column < columns; column++) {
        const names = source.rows.map((row) => row.cells[column]).filter(Boolean).map((c) => c.name);
        if (!names.length) continue;
        const anchor = source.rows.find((row) => row.cells[column])?.cells[column];
        const landing = target?.rows.map((row) => row.cells[column]).find(Boolean);
        moves.push({ file: anchor.file, selector: anchor.selector, names, target: landing ? landing.name : null });
      }
      if (!moves.length) return;
      // A group can be declared in more than one stylesheet, so the edit is
      // whatever files its moves name.
      await writeWithUndo(moves.map((m) => m.file), 'the group', async () => {
        const result = await bridge('moveCssVariables', { projectPath: project.path, moves });
        if (!result.ok) showToast?.(result.error || 'Could not move that.', 'error');
        await refresh();
        return result.ok;
      });
    },
    [project.path, refresh, showToast, writeWithUndo]
  );

  // Adding a variable to a group. What the name is depends on the shape of the
  // group: in a family the typed word is the property (`--h1-<word>` for every
  // column), in a group named after a prefix it is what follows that prefix,
  // and in a plain list it is the whole name. In every case it lands under the
  // group's last variable rather than at the end of the rule.
  const add = useCallback(
    async (block, columns, word) => {
      const typed = word.trim().replace(/^--/, '');
      if (!typed) return;
      const last = block.rows[block.rows.length - 1];
      const adds = [];
      columns.forEach((column, index) => {
        const anchor = last?.cells[index] || block.rows.map((r) => r.cells[index]).filter(Boolean).pop();
        if (!anchor) return;
        const name =
          block.kind === 'matrix'
            ? `--${column.label}-${typed}`
            : `${stemOf(block)}${typed}`;
        adds.push({ file: anchor.file, selector: anchor.selector, name, value: '', after: anchor.name });
      });
      if (!adds.length) return;
      await writeWithUndo(adds.map((a) => a.file), 'the variable', async () => {
        const result = await bridge('addCssVariables', { projectPath: project.path, adds });
        if (!result.ok) showToast?.(result.error || 'Could not add that.', 'error');
        await refresh();
        return result.ok;
      });
    },
    [project.path, refresh, showToast, writeWithUndo]
  );

  // Renaming a variable — or a group of them, which is the same thing done to
  // every member at once. A name is not held anywhere but in the text that
  // declares and reads it, so this is one call that rewrites all of it; the
  // panel reloads from the files afterwards either way.
  const rename = useCallback(
    async (renames) => {
      if (!renames?.length) return true;
      const result = await bridge('renameCssVariables', { projectPath: project.path, renames });
      if (!result.ok) {
        showToast?.(result.error || 'Could not rename that.', 'error');
        await refresh();
        return false;
      }
      // A rename reaches as many files as mention the name, so its inverse is
      // not a file to put back — it is the same rename read backwards.
      const back = renames.map(({ from, to }) => ({ from: to, to: from }));
      const apply = async (list) => {
        await bridge('renameCssVariables', { projectPath: project.path, renames: list });
        await refresh();
      };
      onRecordUndo?.({
        label: renames.length > 1 ? 'the group rename' : 'the rename',
        undo: () => apply(back),
        redo: () => apply(renames),
      });
      await refresh();
      return true;
    },
    [project.path, refresh, showToast, onRecordUndo]
  );

  // A heading that is a comment in the file rather than a name its rows share.
  // Renaming it writes those words; nothing else in the project refers to them,
  // so unlike a variable's name this reaches exactly one place.
  const retitleOnce = useCallback(
    async (block, title) => {
      const result = await bridge('setCssSectionTitle', {
        projectPath: project.path,
        file: file?.rel,
        start: block.titleStart,
        end: block.titleEnd,
        expect: block.title,
        title,
      });
      if (!result.ok) {
        showToast?.(result.error || 'Could not rename that.', 'error');
        await refresh();
        return false;
      }
      await refresh();
      return true;
    },
    [project.path, file?.rel, refresh, showToast]
  );

  const retitle = useCallback(
    async (block, title) => {
      let ok = true;
      await writeWithUndo(file?.rel, 'the heading', async () => {
        ok = await retitleOnce(block, title);
        return ok;
      });
      return ok;
    },
    [file?.rel, writeWithUndo, retitleOnce]
  );

  // Another heading, written directly above this one — so the new group starts
  // empty, with nothing of this one's in it. Its variables are the ones you put
  // there afterwards, which is what an empty group is for.
  const duplicateSection = useCallback(
    async (block) => {
      const anchor = block.rows.map((row) => row.cells.find(Boolean)).find(Boolean);
      await writeWithUndo(file?.rel, 'the group', async () => {
        const result = await bridge('addCssSection', {
          projectPath: project.path,
          file: file?.rel,
          selector: anchor?.selector,
          title: `${block.title} copy`,
          at: block.titleStart,
        });
        if (!result.ok) showToast?.(result.error || 'Could not duplicate that.', 'error');
        await refresh();
        return result.ok;
      });
    },
    [project.path, file?.rel, refresh, showToast, writeWithUndo]
  );

  // Deleting a heading deletes the comment and nothing else: its variables join
  // the group above, which is what removing a line between two runs does.
  const deleteSection = useCallback(
    async (block) => {
      await writeWithUndo(file?.rel, 'deleting the group', async () => {
        const result = await bridge('removeCssSection', {
          projectPath: project.path,
          file: file?.rel,
          start: block.titleStart,
          end: block.titleEnd,
          expect: block.title,
        });
        if (!result.ok) showToast?.(result.error || 'Could not delete that.', 'error');
        await refresh();
        return result.ok;
      });
    },
    [project.path, file?.rel, refresh, showToast, writeWithUndo]
  );

  // What the accessibility check makes of a value right now — the file's values
  // with whatever is in the fields on top.
  const fluidOf = useCallback(
    (cell) => {
      if (!cell) return null;
      const own = drafts[cell.name];
      const check = fluidCheck(resolveValue(own ?? cell.value, values, drafts));
      return check && check.status !== 'ok' ? check : null;
    },
    [values, drafts]
  );

  const noteDraft = useCallback((name, value) => {
    setDrafts((current) => {
      if (value === null) {
        if (!(name in current)) return current;
        const next = { ...current };
        delete next[name];
        return next;
      }
      return current[name] === value ? current : { ...current, [name]: value };
    });
  }, []);

  const blocks = useMemo(() => {
    if (!group) return [];
    const q = query.trim().toLowerCase();
    if (!q) return group.blocks;
    return group.blocks
      .map((block) => ({
        ...block,
        rows: block.rows.filter(
          (row) =>
            `${block.title || ''} ${row.label} ${row.name || ''}`.toLowerCase().includes(q) ||
            row.cells.some((c) => c && `${c.name} ${c.value}`.toLowerCase().includes(q))
        ),
      }))
      .filter((block) => block.rows.length);
  }, [group, query]);

  if (!group) return <div className={`cms-view vars-view ${hidden ? 'hidden' : ''}`} />;


  return (
    <div className={`cms-view vars-view ${hidden ? 'hidden' : ''}`}>
      <div className="cms-detail">
        <div className="cms-detail-head">
          <button className="ghost cms-back" title="Close" onClick={onClose}>
            <CloseIcon size={13} />
          </button>
          <span className="cms-detail-title">{group.label}</span>
          <span className={`cms-saved ${saved ? 'on' : ''}`}>
            <CheckIcon size={11} /> Saved
          </span>
          <input
            className="vars-search"
            value={query}
            placeholder="Search variables"
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
          />
          <span className="cms-detail-path">{file.rel}</span>
        </div>

        <div className="cms-detail-body vars-body">
          <Sheet
            blocks={blocks}
            group={group}
            onSave={save}
            onMove={move}
            onMoveGroup={moveGroup}
            onAdd={add}
            onRename={rename}
            onRetitle={retitle}
            onDuplicateSection={duplicateSection}
            onDeleteSection={deleteSection}
            fluidOf={fluidOf}
            onDraft={noteDraft}
          />
        </div>
      </div>
    </div>
  );
}

// Groups with the same number of columns are the same width and start their
// columns at the same x, so one of them scrolled and the others not breaks the
// line the eye follows down the sheet — `button`'s dark column would sit over
// `selection`'s light one. They move together. A group with a different number
// of columns is a different width, has nothing to line up with, and is left
// where it is.
export function createScrollSync() {
  const byColumns = new Map();
  // Assigning scrollLeft fires a scroll event of its own, which arrives back
  // here looking exactly like someone scrolling. Unguarded, that is answered
  // with another round of assignments.
  let echoing = false;
  const release = () => {
    echoing = false;
  };

  return {
    register(count, el) {
      if (!el) return undefined;
      const peers = byColumns.get(count) || new Set();
      peers.add(el);
      byColumns.set(count, peers);
      return () => {
        peers.delete(el);
        if (!peers.size) byColumns.delete(count);
      };
    },
    broadcast(count, from, left) {
      if (echoing) return;
      echoing = true;
      for (const el of byColumns.get(count) || []) {
        // Compared before writing: an assignment that changes nothing still
        // costs a layout, and there is one per group per scroll event.
        if (el !== from && Math.abs(el.scrollLeft - left) > 0.5) el.scrollLeft = left;
      }
      // Next frame, by which time the echoes have arrived and been ignored.
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(release);
      else setTimeout(release, 0);
    },
  };
}

const useScrollSync = () => useMemo(createScrollSync, []);

// The two stacks' tracks. Fixed, not fractions, so every table starts its
// columns at the same x however many it has — and so the sheet's headings sit
// over the columns they name. See the note in Table.
const LABEL_TRACKS = 'calc(var(--vars-inset) + 18px) var(--vars-name-col)';
const valueTracks = (count) => `repeat(${count}, var(--vars-col))`;

// The tables of one group, and the drag that reorders them. The headings sit in
// different tables but are one list as far as dragging goes, so the gesture is
// owned here rather than by any one table.
// What a new name in this group starts with: everything its rows' names have in
// front of the label they show. `--selection-background` shown as `background`
// leaves `--selection-`; a plain list leaves `--`.
function stemOf(block) {
  const row = block.rows.find((r) => r.name);
  if (!row) return '--';
  return row.name.slice(0, row.name.length - row.label.length) || '--';
}

// The heading's own menu.
//
// A heading is a comment in the stylesheet, and the three things you can do to
// a comment are all here: change the words, put another one below (which splits
// the run of variables under it into two groups), and take it away — which
// leaves its variables where they are and folds them into the group above.
//
// Portaled and positioned against the button, because the sheet scrolls in both
// directions and a menu inside it would be cropped by whichever edge it met.
// The group's own `⋯`, from the app's one menu (src/ui/MoreMenu.jsx). This
// panel had the first one; the assets panel wanted the same thing, and two of
// them is one too many.
function SectionMenu({ onRename, onDuplicate, onDelete }) {
  return (
    <MoreMenu
      className="vars-section-menu"
      title="Group options"
      items={[
        { label: 'Rename', icon: <PencilIcon size={13} />, onSelect: onRename },
        { label: 'Duplicate', icon: <CopyIcon size={13} />, onSelect: onDuplicate },
        { label: 'Delete', icon: <TrashIcon size={13} />, danger: true, onSelect: onDelete },
      ]}
    />
  );
}

// What a drop means, as file edits.
//
// `slots` is every row in the sheet with a slot at the end of each group (see
// Sheet); `from` is the row being dragged and `to` is where the pointer let go.
// A row lands IN FRONT OF the next real row at or after that point — which is
// what carries it into another group, since a group is only the run of lines
// between two comments. Past the last row of all, it lands at the end of the
// rule, which is inside the last group.
//
// One move per column: a row in a table of modes is one name declared in
// several rules, and it has to move in each of them or the modes fall out of
// step with each other.
export function dropPlan(slots, from, to) {
  const source = slots?.[from];
  if (!source) return null;
  // Where it lands: in front of the next real row at or after the drop point.
  let landing = null;
  for (let at = to; at < slots.length; at++) {
    if (slots[at].kind === 'row') { landing = slots[at]; break; }
  }
  if (source.kind === 'heading') {
    // A heading that has not actually moved: it is already the thing directly
    // above `landing`.
    const here = slots.indexOf(source);
    if (to === here || to === here + 1) return null;
    return { kind: 'heading', block: source.block, before: landing ? landing.row.name : null };
  }
  if (source.kind !== 'row') return null;
  return { kind: 'rows', moves: movesForDrop(slots, from, to) };
}

export function movesForDrop(slots, from, to) {
  const source = slots?.[from];
  if (!source || source.kind !== 'row') return [];
  // The next thing in the sheet that is a line in the file: a variable, or a
  // HEADING. Headings count, and this is the whole of the bug they fix — a group
  // ends at its next comment, so a drop at the end of a group that lands "in
  // front of the next variable" steps over that comment and into the group
  // after it. Dropped into an empty group, the variable went somewhere else
  // entirely.
  let landing = null;
  for (let at = to; at < slots.length; at++) {
    if (slots[at].kind === 'row' || slots[at].kind === 'heading') { landing = slots[at]; break; }
  }
  if (landing?.kind === 'row' && landing.row === source.row) return [];
  return source.row.cells
    .map((cell, index) => {
      if (!cell) return null;
      // A heading is a place in the text rather than a name to land in front of.
      // Only a heading the panel read out of a comment HAS such a place; the
      // headings of a modes table are shared name prefixes, and a run there is
      // bounded by declarations, so the name is the right answer.
      if (landing?.kind === 'heading') {
        if (typeof landing.block.titleStart === 'number') {
          return { file: cell.file, selector: cell.selector, name: cell.name, at: landing.block.titleStart };
        }
        const firstRow = landing.block.rows.find((row) => row.cells[index]);
        return { file: cell.file, selector: cell.selector, name: cell.name, target: firstRow ? firstRow.cells[index].name : null };
      }
      const target = landing ? landing.row.cells[index] : null;
      // Landing in front of nothing is the end of the rule.
      return { file: cell.file, selector: cell.selector, name: cell.name, target: target ? target.name : null };
    })
    .filter(Boolean);
}

// A name you can rename by clicking it.
//
// A variable's name and a group's heading are both text on a row that also
// drags, so a press has two meanings and the field has to pick one: a click
// opens it, and once open the drag handlers are out of the way. It selects what
// is there because a rename usually replaces the name rather than tweaking it,
// and Escape puts back what it started with.
function EditableName({ value, onRename, className, title, openSignal, children }) {
  const [editing, setEditing] = useState(false);
  // The menu's Rename opens the same field the label does: it bumps a counter,
  // and the field takes that as "open now" rather than owning a second way in.
  const seen = useRef(openSignal);
  useEffect(() => {
    if (openSignal === seen.current) return;
    seen.current = openSignal;
    setText(value);
    setEditing(true);
  }, [openSignal, value]);
  const [text, setText] = useState(value);
  const inputRef = useRef(null);
  const done = useRef(false);

  useEffect(() => {
    if (!editing) return undefined;
    done.current = false;
    const el = inputRef.current;
    el?.focus();
    el?.select();
    return undefined;
  }, [editing]);

  const commit = async () => {
    if (done.current) return;
    done.current = true;
    const next = text.trim();
    setEditing(false);
    if (!next || next === value) { setText(value); return; }
    // Put the old name back if the rename is refused — the sheet reloads from
    // the file either way, but the field would otherwise sit there showing a
    // name the project does not have.
    const ok = await onRename?.(next);
    if (!ok) setText(value);
  };
  const cancel = () => { done.current = true; setEditing(false); setText(value); };

  if (!editing) {
    return (
      <button
        type="button"
        className={`vars-rename ${className || ''}`}
        // The name fills the row, so it is also where a drag starts. Press and
        // move to drag the row; press and release to rename it.
        data-drag-through=""
        title={title ? `${title} — drag to move, click to rename` : 'Click to rename'}
        onClick={() => { setText(value); setEditing(true); }}
      >
        {children ?? value}
      </button>
    );
  }
  return (
    <input
      ref={inputRef}
      className={`vars-rename-input ${className || ''}`}
      value={text}
      spellCheck={false}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (SAVE_ON.includes(e.key)) { e.preventDefault(); commit(); }
        if (e.key === 'Escape') { e.preventDefault(); cancel(); }
      }}
    />
  );
}

function Sheet({ blocks, group, onSave, onMove, onMoveGroup, onAdd, onRename, onRetitle, onDuplicateSection, onDeleteSection, fluidOf, onDraft }) {
  // Dragging a variable is one gesture across the whole sheet rather than one
  // per group. A group is a run of lines between two comments in the same rule,
  // so moving a variable INTO a group is the same file edit as moving it within
  // one — but a drag confined to its own table could only ever land in the table
  // it started in, and a drop anywhere else fell through to "the end".
  //
  // Each group contributes its rows plus one slot at its end (the "New variable"
  // line), so a group with no rows of its own is still somewhere you can drop.
  // A heading is in the list too, and drags on its own: moving a comment up
  // past three variables is how those three come to be under it. So the slots
  // are, per group: its heading, its rows, and one at its end.
  const slots = useMemo(() => {
    const list = [];
    blocks.forEach((block, bi) => {
      if (block.title != null) list.push({ kind: 'heading', block, bi });
      block.rows.forEach((row) => list.push({ kind: 'row', block, row, bi }));
      list.push({ kind: 'end', block, bi });
    });
    return list;
  }, [blocks]);
  // Where each group's slots begin, and where its rows begin inside that.
  const slotOffsets = useMemo(() => {
    const out = [];
    let at = 0;
    blocks.forEach((block) => {
      const head = block.title != null ? 1 : 0;
      out.push({ head: at, rows: at + head });
      at += head + block.rows.length + 1;
    });
    return out;
  }, [blocks]);
  const rowsDrag = useListReorder({
    count: slots.length,
    onMove: (from, to) => onMove?.(slots, from, to),
  });
  // Owned here rather than by any one table, for the same reason the section
  // drag is: what it coordinates is the tables against each other.
  const scrollSync = useScrollSync();

  // The column headings name the selector's modes, not any one group's rows, so
  // they are the sheet's rather than the first table's. Written here, they stay
  // in view over every group under them instead of leaving with the group that
  // happened to be carrying them.
  const headRef = useRef(null);
  const headStripRef = useRef(null);
  useEffect(
    () => scrollSync?.register(group.columns.length, headStripRef.current),
    [scrollSync, group.columns.length]
  );
  // The group titles come to rest under this, so its height has to be known
  // rather than guessed — a row's height is set in CSS and read here.
  useLayoutEffect(() => {
    const el = headRef.current;
    if (!el || typeof ResizeObserver !== 'function') return undefined;
    // Set on the scroller, not on the head itself: the group titles that read
    // it are siblings, and a custom property travels down rather than across.
    const host = el.parentElement;
    if (!host) return undefined;
    const apply = () => host.style.setProperty('--vars-head-h', `${el.offsetHeight}px`);
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const single = group.columns.length === 1;

  return (
    <>
      <div className="vars-table vars-sheet-head" ref={headRef}>
        <div className="vars-fixed">
          <div className="vars-row is-head" style={{ gridTemplateColumns: LABEL_TRACKS }}>
            <div />
            <div className="vars-head">Name</div>
          </div>
        </div>
        <div className="vars-scroll">
          <div className="vars-scroll-head" ref={headStripRef}>
            <div
              className="vars-row is-head"
              style={{ gridTemplateColumns: valueTracks(group.columns.length) }}
            >
              {group.columns.map((column) => (
                <div key={column.id} className="vars-head" title={column.selector || column.label}>
                  {single && group.kind === 'single' ? 'Value' : column.label}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
      {blocks.map((block, index) => (
        <Table
          key={index}
          block={block}
          group={group}
          onSave={onSave}
          onMove={onMove}
          sectionDrag={{
            props: block.title != null ? rowsDrag.rowProps(slotOffsets[index].head) : {},
            className: block.title != null ? rowsDrag.rowClass(slotOffsets[index].head) : '',
          }}
          onAdd={onAdd}
          onRename={onRename}
          onRetitle={onRetitle}
          onDuplicateSection={onDuplicateSection}
          onDeleteSection={onDeleteSection}
          rowsDrag={rowsDrag}
          slotOffset={slotOffsets[index].rows}
          fluidOf={fluidOf}
          onDraft={onDraft}
          scrollSync={scrollSync}
          // The group's headings are the sheet's now; only a matrix, whose
          // columns are its own, still writes its own.
          showHead={block.kind === 'matrix'}
        />
      ))}
      {!blocks.length && <div className="props-empty">Nothing matches the search.</div>}
    </>
  );
}

// The last line of every group: what adds a variable to it. It names the group
// it is in — a new row under `line-height` is `--line-height-<what you type>`,
// under `h1…h6` it is that property on every one of them — so what gets typed
// here is the part that is not already decided.
function NewVariable({ block, columns, onAdd, template, slotProps, dropping }) {
  const [typing, setTyping] = useState(false);
  const [word, setWord] = useState('');
  const inputRef = useRef(null);

  useEffect(() => {
    if (typing) inputRef.current?.focus();
  }, [typing]);

  const commit = async () => {
    const next = word.trim();
    setTyping(false);
    setWord('');
    if (next) await onAdd?.(block, columns, next);
  };

  if (!typing) {
    return (
      <div className={`vars-row vars-add ${dropping ? 'drop-before' : ''}`} style={{ gridTemplateColumns: template }} {...(slotProps || {})}>
        <span />
        <button className="vars-add-btn" onClick={() => setTyping(true)}>
          <PlusIcon size={11} /> New variable
        </button>
      </div>
    );
  }

  return (
    <div className={`vars-row vars-add ${dropping ? 'drop-before' : ''}`} style={{ gridTemplateColumns: template }} {...(slotProps || {})}>
      <span />
      <span className="vars-add-field">
        <span className="vars-add-stem">{block.kind === 'matrix' ? '…-' : stemOf(block)}</span>
        <input
          ref={inputRef}
          value={word}
          placeholder="name"
          spellCheck={false}
          onChange={(e) => setWord(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commit();
            }
            if (e.key === 'Escape') {
              e.preventDefault();
              setTyping(false);
              setWord('');
            }
          }}
        />
      </span>
    </div>
  );
}

// The prefix a group's heading stands for, or null when the heading is not a
// prefix at all. A file with one rule takes its headings from the comments in
// it — `/* Radius */` is a note above some lines, not part of their names — and
// renaming that is editing a comment, which is a different thing from renaming
// a variable. Only a heading every row is actually named after can be renamed
// here.
function sectionPrefix(block) {
  const title = block.title;
  if (!title || block.kind === 'matrix') return null;
  const rows = block.rows.filter((r) => r.name);
  if (!rows.length) return null;
  return rows.every((r) => r.name.startsWith(`--${title}-`)) ? title : null;
}

// Renaming one row: in a table of modes the row is one name declared in several
// rules, so it is a single rename; in a matrix the row is one property of every
// column (`--h1-size`, `--h2-size`), so it is one rename per column.
function rowRenames(block, row, typed) {
  const next = typed.trim().replace(/^--/, '');
  if (!next) return [];
  if (block.kind === 'matrix') {
    return row.cells
      .filter(Boolean)
      .map((cell) => ({ from: cell.name, to: `--${cell.name.slice(2, cell.name.length - row.label.length - 1)}-${next}` }))
      .filter((r) => r.from !== r.to);
  }
  if (!row.name) return [];
  const to = `${stemOf(block)}${next}`;
  return to === row.name ? [] : [{ from: row.name, to }];
}

function Table({ block, group, onSave, onAdd, onRename, onRetitle, onDuplicateSection, onDeleteSection, fluidOf, onDraft, sectionDrag, scrollSync, rowsDrag, slotOffset = 0, showHead = true }) {
  // A matrix carries its own columns (the family's prefixes); everything else
  // uses the group's (one per rule).
  const columns = block.kind === 'matrix' ? block.columns : group.columns;
  const single = columns.length === 1;
  // Two stacks side by side: the labels, which never move, and a scroller
  // holding every value. One grid per row with the label cells stuck to the
  // left was the obvious shape and the wrong one — the values showed through
  // the gaps between the tracks the sticky cells covered, and a rubber-band
  // scroll past either end unsticks them, so the labels rode the bounce.
  // Outside the scroller there is nothing to come unstuck from.
  //
  // Fixed tracks, not fractions, on both sides. The templates are only equal
  // WITHIN a block: a matrix brings its own columns, so a three-column block
  // and a five-column one divided the same width into different tracks and the
  // blocks stopped lining up with each other down the sheet. A constant width
  // per column (and for the names beside them) means every table starts its
  // columns at the same x, however many it has. The label side's first track is
  // the drag handle plus the sheet's own left inset, so the row reaches the
  // panel's edge and its rule runs edge to edge.
  const labelTemplate = LABEL_TRACKS;
  const valueTemplate = valueTracks(columns.length);
  // This table's slice of the sheet-wide drag (see Sheet).
  const reorder = {
    rowProps: (index) => rowsDrag.rowProps(slotOffset + index),
    rowClass: (index) => rowsDrag.rowClass(slotOffset + index),
  };
  // A row is two elements now, so hovering one has to light the other: :hover
  // can't reach across, and the highlight is what ties a name to its values.
  const [hovered, setHovered] = useState(null);
  // The heading strip and the rows scroll together; see the note where they
  // are rendered for why they are two boxes rather than one.
  const headRef = useRef(null);
  const rowsRef = useRef(null);
  // Keyed by how many columns this table has: only tables of the same width
  // have a scroll position worth sharing.
  useEffect(
    () => scrollSync?.register(columns.length, rowsRef.current),
    [scrollSync, columns.length]
  );
  // Whether this table's heading is a name its rows share (renameable) or a
  // comment above them (not — see sectionPrefix).
  const prefix = sectionPrefix(block);
  // Bumped by the menu's Rename, which opens the field the heading already has.
  const [renameSignal, setRenameSignal] = useState(0);
  const rowProps = (index) => ({
    className: `vars-row ${reorder.rowClass(index)} ${hovered === index ? 'is-hover' : ''}`,
    onMouseEnter: () => setHovered(index),
    onMouseLeave: () => setHovered((at) => (at === index ? null : at)),
  });

  return (
    <div className="vars-table">
      <div className="vars-fixed">
        {/* Heading and column head travel together, the same as their
            counterparts on the value side — one sticky box each, so neither
            half needs to know how tall the other's heading is. */}
        <div className="vars-fixed-head">
        {block.title && (
          // The heading lines up with the names under it, and drags the same way
          // a row does — a group is a run of lines in the file like any other.
          <h3
            className={`vars-row vars-section ${sectionDrag?.className || ''}`}
            style={{ gridTemplateColumns: labelTemplate }}
            {...(sectionDrag?.props || {})}
          >
            <span className="vars-grip" title="Drag to reorder">
              <DragIcon size={11} />
            </span>
            {prefix ? (
              // A heading its rows are named after: renaming it renames them.
              <EditableName
                className="vars-section-text"
                value={prefix}
                title={prefix}
                onRename={(next) => onRename?.(block.rows
                  .filter((row) => row.name)
                  .map((row) => ({ from: row.name, to: `--${next.trim().replace(/^--/, '')}-${row.label}` })))}
              />
            ) : block.titleStart != null ? (
              // A heading that is a comment above the names: renaming it writes
              // the comment, and the names underneath are its own business. Its
              // menu carries the two things that are not renaming.
              <>
                <EditableName
                  className="vars-section-text"
                  value={block.title}
                  title={block.title}
                  openSignal={renameSignal}
                  onRename={(next) => onRetitle?.(block, next)}
                />
                <SectionMenu
                  onRename={() => setRenameSignal((n) => n + 1)}
                  onDuplicate={() => onDuplicateSection?.(block)}
                  onDelete={() => onDeleteSection?.(block)}
                />
              </>
            ) : (
              <span className="vars-section-text">{block.title}</span>
            )}
          </h3>
        )}
        {showHead && (
          <div className="vars-row is-head" style={{ gridTemplateColumns: labelTemplate }}>
            <div />
            <div className="vars-head">Name</div>
          </div>
        )}
        </div>
        {block.rows.map((row, index) => (
          <div
            key={row.name || row.label}
            style={{ gridTemplateColumns: labelTemplate }}
            // The row is what gets measured and dragged; the hook already leaves
            // fields and buttons inside it alone, so a drag can start anywhere on
            // the label that is not one.
            {...reorder.rowProps(index)}
            {...rowProps(index)}
          >
            <span className="vars-grip" title="Drag to reorder">
              <DragIcon size={11} />
            </span>
            <div className="vars-name" title={row.name || row.label}>
              <VariableTypeIcon kind={(row.cells.find(Boolean) || {}).kind} />
              <EditableName
                className="vars-name-text"
                value={row.label}
                title={row.name || row.label}
                onRename={(next) => onRename?.(rowRenames(block, row, next))}
              />
            </div>
          </div>
        ))}
        {/* Also the drop slot for the end of this group — see Sheet. */}
        <NewVariable
          block={block}
          columns={columns}
          onAdd={onAdd}
          template={labelTemplate}
          slotProps={rowsDrag.slotProps(slotOffset + block.rows.length)}
          dropping={rowsDrag.dropIndex === slotOffset + block.rows.length}
        />
      </div>

      <div className="vars-scroll">
        {/* The headings sit outside the horizontal scroller and are kept level
            with it by hand. They have to: a box that scrolls in x is a scroll
            container in both axes, and `position: sticky` inside one resolves
            against that box rather than the sheet — so a heading in here rode
            the rows out of sight instead of staying put. Out here it sticks to
            the sheet, and its own scrollLeft is matched to the rows below so
            the columns still line up.

            Empty counterparts to the label side's heading and head rows: they
            carry the same height and the same rule, so the two stacks stay in
            step and each line runs across both. */}
        <div className="vars-scroll-head" ref={headRef}>
        {block.title && (
          // The heading's counterpart carries the same tracks as the rows
          // below it, or it measures the width of the scroller instead of the
          // width of its contents — and its rule stops at the visible edge
          // while every other line runs the full scroll.
          <div
            className="vars-row vars-section"
            style={{ gridTemplateColumns: valueTemplate }}
            aria-hidden="true"
          />
        )}
        {showHead && (
          <div className="vars-row is-head" style={{ gridTemplateColumns: valueTemplate }}>
            {columns.map((column) => (
              <div key={column.id} className="vars-head" title={column.selector || column.label}>
                {single && group.kind === 'single' ? 'Value' : column.label}
              </div>
            ))}
          </div>
        )}
        </div>
        <div
          className="vars-scroll-rows"
          ref={rowsRef}
          onScroll={(e) => {
            const { scrollLeft } = e.currentTarget;
            if (headRef.current) headRef.current.scrollLeft = scrollLeft;
            scrollSync?.broadcast(columns.length, e.currentTarget, scrollLeft);
          }}
        >
        {block.rows.map((row, index) => (
          <div
            key={row.name || row.label}
            style={{ gridTemplateColumns: valueTemplate }}
            {...rowProps(index)}
          >
            {columns.map((column, at) => (
              <Cell
                key={column.id}
                cell={row.cells[at]}
                onSave={onSave}
                fluidOf={fluidOf}
                onDraft={onDraft}
              />
            ))}
          </div>
        ))}
        </div>
        {/* No counterpart to the add row here: the scroller's own scrollbar
            stands in for it. Given one, the bar was pushed a row below the
            button and read as belonging to whatever came next; without one it
            sits on the same line, which is also the line it scrolls. */}
      </div>
    </div>
  );
}
