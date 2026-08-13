import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { CheckIcon } from './Icons.jsx';

// Classes in a scale are named for it: gap-2 sits beside gap-1 and gap-4,
// margin-top-6 beside margin-top-2. Everything up to the last dash or
// underscore is the family; clicking a tag offers the rest of it.
const collator = new Intl.Collator(undefined, { numeric: true });

function familyPrefix(cls) {
  const cut = Math.max(cls.lastIndexOf('-'), cls.lastIndexOf('_'));
  return cut > 0 ? cls.slice(0, cut + 1) : null;
}

// Token editor for class-list props: each class renders as a tag, a text
// caret can sit between any two tags (click a tag to place the caret after
// it, Backspace removes the tag before the caret), and typing filters a
// suggestion list of every class used across the project.
export default function ClassInput({ value, suggestions = [], onChange }) {
  const tokens = String(value || '').trim().split(/\s+/).filter(Boolean);
  const [caret, setCaret] = useState(tokens.length);
  const [draft, setDraft] = useState('');
  const [focused, setFocused] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [popupPos, setPopupPos] = useState(null);
  const wrapRef = useRef(null);
  const inputRef = useRef(null);

  const at = Math.min(caret, tokens.length);

  const commit = (next) => {
    const str = next.join(' ');
    onChange(str, true);
  };

  const addToken = (text) => {
    const t = text.trim();
    setDraft('');
    if (!t) return;
    if (tokens.includes(t)) {
      setCaret(tokens.indexOf(t) + 1);
      return;
    }
    const next = [...tokens];
    next.splice(at, 0, t); // insert at the caret
    setCaret(at + 1);
    commit(next);
  };

  const removeAt = (i) => {
    if (i < 0 || i >= tokens.length) return;
    const next = tokens.filter((_, j) => j !== i);
    setCaret(Math.max(0, i));
    commit(next);
  };

  // The family menu: which tag was clicked, what it could become, and where
  // to draw the list. It previews like the prop dropdowns do — arrowing or
  // hovering an option applies it to the page, and closing without picking
  // puts the original back.
  const [family, setFamily] = useState(null);
  const [famHighlight, setFamHighlight] = useState(-1);
  const famOriginal = useRef(null); // the class that was there when it opened
  const famPreview = useRef(null); // last previewed class, or null
  const famRef = useRef(null);

  // One class swapped for another at a fixed position. Previews skip the
  // de-duplication: a transient repeat is invisible and never saved, while
  // collapsing the list mid-preview would shift every index under it.
  const writeAt = (i, cls, { immediate, dedupe }) => {
    let next = tokens.map((t, j) => (j === i ? cls : t));
    if (dedupe) next = next.filter((t, j, all) => all.indexOf(t) === j);
    onChange(next.join(' '), immediate);
  };

  const closeFamily = (revert) => {
    if (
      revert &&
      family &&
      famPreview.current !== null &&
      famPreview.current !== famOriginal.current
    ) {
      writeAt(family.index, famOriginal.current, { immediate: true, dedupe: false });
    }
    famPreview.current = null;
    setFamily(null);
    setFamHighlight(-1);
  };

  const previewFamily = (n) => {
    if (!family) return;
    setFamHighlight(n);
    const cls = family.options[n];
    if (!cls) return;
    const applied = famPreview.current ?? famOriginal.current;
    if (cls === applied) return;
    famPreview.current = cls;
    // Immediate, like every other menu that previews on hover (the prop
    // dropdowns): a preview that waits out the typing debounce reads as lag.
    // Successive hovers still collapse into one save — each reschedules the
    // same timer — and into one undo step, which is keyed on the prop.
    writeAt(family.index, cls, { immediate: true, dedupe: false });
  };

  const applyFamily = (n) => {
    if (!family) return;
    const cls = family.options[n];
    const i = family.index;
    famPreview.current = null;
    setFamily(null);
    setFamHighlight(-1);
    if (cls) writeAt(i, cls, { immediate: true, dedupe: true });
  };

  useEffect(() => {
    if (!family) return undefined;
    const onDown = (e) => {
      if (!e.target.closest?.('.class-family')) closeFamily(true);
    };
    document.addEventListener('mousedown', onDown, true);
    return () => document.removeEventListener('mousedown', onDown, true);
  }); // no deps: the handler closes over the current preview refs

  // Keep the arrowed option in view.
  useEffect(() => {
    if (!family || famHighlight < 0) return;
    famRef.current?.children[famHighlight]?.scrollIntoView({ block: 'nearest' });
  }, [family, famHighlight]);

  // Everything sharing this class's prefix — the class itself included, so the
  // menu says which one is on. Drawn from the project's classes plus the ones
  // already on this element, which may not be used anywhere else yet.
  const familyOf = (cls) => {
    const prefix = familyPrefix(cls);
    if (!prefix) return [];
    const pool = new Set([...suggestions, ...tokens]);
    return [...pool].filter((s) => s.startsWith(prefix)).sort(collator.compare);
  };

  const query = draft.trim().toLowerCase();
  const matches = query
    ? suggestions
        .filter((s) => s.toLowerCase().includes(query) && !tokens.includes(s))
        .sort((a, b) => {
          // Prefix matches first, then shortest.
          const ap = a.toLowerCase().startsWith(query) ? 0 : 1;
          const bp = b.toLowerCase().startsWith(query) ? 0 : 1;
          return ap - bp || a.length - b.length;
        })
        .slice(0, 12)
    : [];

  useLayoutEffect(() => {
    if (!focused || !matches.length || !wrapRef.current) {
      setPopupPos(null);
      return;
    }
    const r = wrapRef.current.getBoundingClientRect();
    setPopupPos({ left: r.left, top: r.bottom + 4, width: r.width });
  }, [focused, matches.length, draft]); // eslint-disable-line react-hooks/exhaustive-deps

  const onKeyDown = (e) => {
    // While the family menu is up it owns the arrows and Enter: the caret and
    // the suggestion list are both idle behind it.
    if (family) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        previewFamily(Math.min(famHighlight + 1, family.options.length - 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        previewFamily(Math.max(famHighlight - 1, 0));
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        applyFamily(famHighlight);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        closeFamily(true);
        return;
      }
    }
    if (e.key === 'Backspace' && !draft) {
      e.preventDefault();
      removeAt(at - 1);
    } else if (e.key === 'Delete' && !draft) {
      e.preventDefault();
      removeAt(at);
    } else if (e.key === 'ArrowLeft' && !draft) {
      e.preventDefault();
      setCaret(Math.max(0, at - 1));
    } else if (e.key === 'ArrowRight' && !draft) {
      e.preventDefault();
      setCaret(Math.min(tokens.length, at + 1));
    } else if (e.key === 'ArrowDown' && matches.length) {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, matches.length - 1));
    } else if (e.key === 'ArrowUp' && matches.length) {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (matches.length) addToken(matches[Math.min(highlight, matches.length - 1)]);
      else addToken(draft);
    } else if (e.key === ' ') {
      e.preventDefault();
      addToken(draft);
    } else if (e.key === 'Tab' && draft) {
      e.preventDefault();
      addToken(matches.length ? matches[Math.min(highlight, matches.length - 1)] : draft);
    } else if (e.key === 'Escape') {
      setDraft('');
      inputRef.current?.blur();
    }
  };

  // While empty the input is just a caret-width sliver, with negative
  // margins swallowing the flex gap on either side so tags don't spread
  // apart around the cursor.
  const emptyAmongTags = !draft && tokens.length > 0;
  const inputEl = (
    <input
      key="caret"
      ref={inputRef}
      className={`class-input-field ${emptyAmongTags ? 'empty' : ''}`}
      value={draft}
      style={draft ? { width: `${draft.length + 1}ch` } : undefined}
      spellCheck={false}
      onChange={(e) => {
        setDraft(e.target.value);
        setHighlight(0);
      }}
      onKeyDown={onKeyDown}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false);
        if (draft.trim()) addToken(draft);
      }}
    />
  );

  const items = [];
  tokens.forEach((t, i) => {
    if (i === at) items.push(inputEl);
    items.push(
      <span
        key={`${t}-${i}`}
        className={`class-tag${family?.index === i ? ' open' : ''}`}
        title={
          familyOf(t).length > 1
            ? 'Click to switch to a related class'
            : 'Click to place the caret after this class'
        }
        onMouseDown={(e) => {
          // preventDefault keeps the inline input from blurring.
          e.preventDefault();
          e.stopPropagation();
          setCaret(i + 1);
          inputRef.current?.focus();
          // Clicking the open tag again closes the menu, keeping whatever was
          // there before the preview.
          if (family?.index === i) {
            closeFamily(true);
            return;
          }
          closeFamily(true);
          const options = familyOf(t);
          if (options.length < 2) return;
          const r = e.currentTarget.getBoundingClientRect();
          famOriginal.current = t;
          famPreview.current = null;
          setFamHighlight(options.indexOf(t));
          setFamily({ index: i, options, left: r.left, top: r.bottom + 5 });
        }}
      >
        {t}
      </span>
    );
  });
  if (at >= tokens.length) items.push(inputEl);

  return (
    <>
      <div
        ref={wrapRef}
        className={`class-input ${focused ? 'focused' : ''}`}
        onMouseDown={(e) => {
          if (e.target === wrapRef.current) {
            e.preventDefault();
            setCaret(tokens.length);
            inputRef.current?.focus();
          }
        }}
      >
        {items}
      </div>
      {popupPos && (
        <div
          className="dd-popup class-suggest"
          style={{ left: popupPos.left, top: popupPos.top, width: popupPos.width }}
        >
          {matches.map((s, i) => (
            <div
              key={s}
              className={`dd-option ${i === highlight ? 'highlight' : ''}`}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setHighlight(i)}
              onClick={() => addToken(s)}
            >
              <span className="dd-option-label">{s}</span>
            </div>
          ))}
        </div>
      )}
      {family && (
        <div
          ref={famRef}
          className="dd-popup class-family"
          style={{ left: family.left, top: family.top }}
        >
          {family.options.map((s, i) => (
            <div
              key={s}
              className={`dd-option ${i === famHighlight ? 'highlight' : ''} ${
                s === famOriginal.current ? 'selected' : ''
              }`}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => previewFamily(i)}
              onClick={() => applyFamily(i)}
            >
              <span className="dd-check">
                {s === famOriginal.current && <CheckIcon size={12} />}
              </span>
              <span className="dd-option-label">{s}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
