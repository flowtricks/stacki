import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CloseIcon, CheckIcon, DragIcon, PlusIcon } from '../ui/Icons.jsx';
import useListReorder from '../ui/useListReorder.js';
import VariableTypeIcon from '../ui/VariableTypeIcon.jsx';
import FluidBadge from '../ui/FluidBadge.jsx';
import { fluidCheck, resolveValue } from '../fluid.js';
import ColorSwatch from '../style-panel/components/ColorSwatch';
import VariableConnect from '../style-panel/VariableConnect';
import { setHost } from '../style-panel/lib/host';
import { popupBox, POPUP_GAP } from '../ui/Dropdown.jsx';
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
async function bridge(name, payload) {
  const call = window.avb?.[name];
  if (typeof call !== 'function') {
    return { ok: false, error: 'Stacki needs to be restarted before this can be used.' };
  }
  try {
    return (await call(payload)) || { ok: true };
  } catch (err) {
    return { ok: false, error: String(err?.message || err).replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '') };
  }
}

// Past this, a value is taken as too long for its column even when nothing can
// be measured — a headless render, or a field that has not been laid out yet.
// Measurement is the real test (see doesNotFit): what decides is whether the
// field can show the value, and a value drawn with chips in it runs wider than
// its own text, so counting characters alone let plenty of unreadable cells
// pass for readable.
const LONG_VALUE = 34;
const isLong = (value) => String(value).length > LONG_VALUE || String(value).includes('\n');

// One custom-value box at a time. Each cell owns its own, so the sheet holds a
// pointer to whichever is open: opening another calls this first, and it closes
// the same way pressing outside does, keeping what was typed. The press that
// opens the new one is stopped at its own cell (so the chip under it does
// nothing), and that stop is also what keeps it from reaching the open box's
// outside-press handler — hence this rather than relying on the press.
let closeOpenCustom = null;

/** Is the value wider than the field showing it? */
function doesNotFit(cell, value) {
  // The token editor first, and only then the input: with a code field the
  // input is always in the DOM, hidden behind the editor, and a comma selector
  // would have measured that one — the wrong element, and in the sheet always
  // the invisible one.
  const field =
    cell.querySelector('.embed-editor_varconnect-editor') || cell.querySelector('.var-input');
  // clientWidth is 0 before layout (and in jsdom); fall back to the count.
  if (!field || !field.clientWidth) return isLong(value);
  return field.scrollWidth > field.clientWidth + 1 || isLong(value);
}

// The whole value, in a box big enough to read it. A long value is usually a
// long expression — a clamp() of four variables, a calc() of three — and the
// thing that makes it editable is seeing all of it at once, with the chips
// where they fall.
//
// The field inside is the same one the cell uses, so a chip is still a chip:
// click it to swap the variable, type around it. Opened by clicking a long
// value, or by pressing "=" in any field.
function CustomValue({ cell, anchor, onCancel, onSave }) {
  const [draft, setDraft] = useState(cell.value);
  const [pos, setPos] = useState(null);
  const boxRef = useRef(null);
  const fieldRef = useRef(null);

  useLayoutEffect(() => {
    if (!anchor) return;
    const wanted = boxRef.current?.offsetHeight || 190;
    const box = popupBox(anchor, wanted, window.innerHeight);
    setPos({
      left: Math.max(8, Math.min(anchor.left, window.innerWidth - 460)),
      top: box.top,
      bottom: box.bottom,
      maxHeight: box.maxHeight,
    });
  }, [anchor]);

  // Whatever is in the box right now, for the two ways it can be closed from
  // outside itself: another box opening, and a press elsewhere.
  const draftRef = useRef(draft);
  draftRef.current = draft;

  useEffect(() => {
    const close = () => onSave(draftRef.current);
    closeOpenCustom?.(); // never two at once
    closeOpenCustom = close;
    return () => {
      if (closeOpenCustom === close) closeOpenCustom = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Nothing behind the box moves while it is open. It is anchored to the cell
  // it came from, so a panel scrolling underneath would slide that cell out
  // from under it — and the box is where the editing is happening anyway.
  // Every scroller in the app is covered by refusing the gesture itself,
  // rather than by hunting down each one and locking its overflow.
  useEffect(() => {
    const onWheel = (e) => {
      if (!boxRef.current?.contains(e.target)) e.preventDefault();
    };
    document.addEventListener('wheel', onWheel, { passive: false, capture: true });
    document.addEventListener('touchmove', onWheel, { passive: false, capture: true });
    return () => {
      document.removeEventListener('wheel', onWheel, { capture: true });
      document.removeEventListener('touchmove', onWheel, { capture: true });
    };
  }, []);

  useEffect(() => {
    const onDown = (e) => {
      if (boxRef.current && !boxRef.current.contains(e.target)) onSave(draft);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [draft, onCancel, onSave]);

  // It opened because you meant to edit this value, so it arrives focused with
  // the caret at the end. The field you can see is the rich one — the textarea
  // behind it only carries the value — so focus THAT; selecting the hidden one
  // left the box looking focused while every keystroke went nowhere.
  //
  // Every render, not just on mount — but a no-op the moment the caret is
  // anywhere inside the popup, so it never fights the caret as you type. The
  // rich field is redrawn when the variables it names resolve, and a redrawn
  // node is a new node: focus put on the old one goes to the document, and the
  // popup that opened because you meant to type in it sits there taking
  // nothing.
  useEffect(() => {
    if (boxRef.current?.contains(document.activeElement)) return undefined;
    const t = setTimeout(() => {
      const rich = boxRef.current?.querySelector('.embed-editor_varconnect-editor');
      if (!rich) {
        fieldRef.current?.select();
        return;
      }
      rich.focus();
      const range = document.createRange();
      range.selectNodeContents(rich);
      range.collapse(false); // the end: a long expression is edited, not replaced
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    }, 0);
    return () => clearTimeout(t);
  });

  return createPortal(
    <div
      ref={boxRef}
      className="var-custom"
      style={{ left: pos?.left ?? -9999, top: pos?.top, bottom: pos?.bottom, maxHeight: pos?.maxHeight }}
    >
      <div className="var-custom-head">
        <span>Custom value</span>
        <span className="var-custom-name">{cell.name}</span>
      </div>
      <VariableConnect className="is-multiline" code onPick={(binding) => setDraft(withBinding(draft, binding))}>
        <textarea
          ref={fieldRef}
          className="var-custom-input"
          value={draft}
          spellCheck={false}
          rows={4}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // A CSS value has no need for a line break, so Enter is "done".
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              onSave(e.currentTarget.value);
            }
          }}
        />
      </VariableConnect>
      <div className="var-custom-foot">
        <span>Enter to save · Escape to cancel</span>
      </div>
    </div>,
    document.body
  );
}

// Swapping a variable keeps the expression around it: picking a new one inside
// `calc(var(--a) + 10px)` replaces the reference, not the calc.
function withBinding(value, binding) {
  const existing = String(value).match(/var\(\s*--[A-Za-z0-9_-]+[^)]*\)/i);
  return existing ? value.replace(existing[0], binding) : binding;
}

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
      {isColor && (
        <ColorSwatch
          value={cell.color || 'transparent'}
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
          cell={{ ...cell, value }}
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

export default function VariablesView({ project, selected, hidden, onClose, showToast }) {
  const [files, setFiles] = useState([]);
  const [values, setValues] = useState({});
  const [saved, setSaved] = useState(false);
  const [query, setQuery] = useState('');
  // What is being typed, by variable name, before it has been saved. A clamp()
  // is only as accessible as the numbers it references, and those are usually
  // three rows further down the same table — so the badge has to be recomputed
  // from the draft, not from the file.
  const [drafts, setDrafts] = useState({});

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

  const save = useCallback(
    async (cell, value) => {
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
        return;
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 1200);
      await refresh();
    },
    [project.path, refresh, showToast]
  );

  // Dragging a row moves the declaration inside its rule — a row in a table of
  // modes is one name in several rules, so it moves in each of them.
  const move = useCallback(
    async (rows, from, to) => {
      const target = to > from ? rows[to] : rows[to] ?? null; // land in front of this row
      const source = rows[from];
      if (!source || source === target) return;
      const moves = [];
      source.cells.forEach((cell, index) => {
        if (!cell) return;
        const landing = target ? target.cells[index] : null;
        moves.push({
          file: cell.file,
          selector: cell.selector,
          name: cell.name,
          // Moving down lands after the row it passed, which is the same as
          // landing in front of the one after it — or at the end.
          target: landing ? landing.name : null,
        });
      });
      if (!moves.length) return;
      const result = await bridge('moveCssVariables', { projectPath: project.path, moves });
      if (!result.ok) showToast?.(result.error || 'Could not move that.', 'error');
      await refresh();
    },
    [project.path, refresh, showToast]
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
      const result = await bridge('moveCssVariables', { projectPath: project.path, moves });
      if (!result.ok) showToast?.(result.error || 'Could not move that.', 'error');
      await refresh();
    },
    [project.path, refresh, showToast]
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
      const result = await bridge('addCssVariables', { projectPath: project.path, adds });
      if (!result.ok) showToast?.(result.error || 'Could not add that.', 'error');
      await refresh();
    },
    [project.path, refresh, showToast]
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

function Sheet({ blocks, group, onSave, onMove, onMoveGroup, onAdd, fluidOf, onDraft }) {
  const sections = useListReorder({
    count: blocks.length,
    onMove: (from, to) => onMoveGroup?.(blocks, from, to),
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
          sectionDrag={{ props: sections.rowProps(index), className: sections.rowClass(index) }}
          onAdd={onAdd}
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
function NewVariable({ block, columns, onAdd, template }) {
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
      <div className="vars-row vars-add" style={{ gridTemplateColumns: template }}>
        <span />
        <button className="vars-add-btn" onClick={() => setTyping(true)}>
          <PlusIcon size={11} /> New variable
        </button>
      </div>
    );
  }

  return (
    <div className="vars-row vars-add" style={{ gridTemplateColumns: template }}>
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

function Table({ block, group, onSave, onMove, onAdd, fluidOf, onDraft, sectionDrag, scrollSync, showHead = true }) {
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
  const reorder = useListReorder({
    count: block.rows.length,
    onMove: (from, to) => onMove?.(block.rows, from, to),
  });
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
            <span className="vars-section-text">{block.title}</span>
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
              <span className="vars-name-text">{row.label}</span>
            </div>
          </div>
        ))}
        <NewVariable block={block} columns={columns} onAdd={onAdd} template={labelTemplate} />
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
