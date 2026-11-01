import Popup from '../../ui/Popup';
import React, { useEffect, useRef, useState } from 'react';
import { useClassPopup } from './useClassPopup';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import { assert } from '../../../shared/core/assert';
import { LIMITS } from '../../../shared/core/limits';
import { CheckIcon } from '../../ui/Icons';

// Classes in a scale are named for it: gap-2 sits beside gap-1 and gap-4,
// margin-top-6 beside margin-top-2. Everything up to the last dash or
// underscore is the family; clicking a tag offers the rest of it.
const collator = new Intl.Collator(undefined, { numeric: true });

function familyPrefix(cls: string) {
  const cut = Math.max(cls.lastIndexOf('-'), cls.lastIndexOf('_'));
  return cut > 0 ? cls.slice(0, cut + 1) : undefined;
}

// Token editor for class-list props: each class renders as a tag, a text
// caret can sit between any two tags (click a tag to place the caret after
// it, Backspace removes the tag before the caret), and typing filters a
// suggestion list of every class used across the project.
interface ClassInputProps {
  readonly value?: string | undefined;
  readonly suggestions?: readonly string[];
  readonly onChange: (value: string, immediate: boolean) => void;
}
interface Family {
  readonly index: number;
  readonly options: readonly string[];
  readonly left: number;
  readonly top: number;
}
export default function ClassInput(props: ClassInputProps) {
  const state = useClassInput(props);
  const { wrapRef, focused, setCaret, tokens, inputRef } = state;
  return (
    <>
      <div
        ref={wrapRef}
        className={`class-input ${focused ? 'focused' : ''}`}
        onMouseDown={(event) => {
          if (event.target === wrapRef.current) {
            event.preventDefault();
            setCaret(tokens.length);
            inputRef.current?.focus();
          }
        }}
      >
        <ClassTokens state={state} />
      </div>
      <ClassSuggestions state={state} />
      <ClassFamilyMenu state={state} />
    </>
  );
}

function useClassInput({ value, suggestions = [], onChange }: ClassInputProps) {
  assert((value?.length ?? 0) <= LIMITS.attrCharsMax, 'ClassInput: value limit exceeded');
  assert(suggestions.length <= 100_000, 'ClassInput: suggestion limit exceeded');
  const tokens = String(value || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const [caret, setCaret] = useState(tokens.length);
  const [draft, setDraft] = useState('');
  const [focused, setFocused] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const at = Math.min(caret, tokens.length);

  const tokenActions = classTokenActions({ tokens, at, setCaret, setDraft, onChange });
  const familyState = useClassFamily(tokens, onChange);
  const matches = classMatches(draft, suggestions, tokens);

  return {
    ...tokenActions,
    ...familyState,
    tokens,
    at,
    setCaret,
    draft,
    setDraft,
    focused,
    setFocused,
    highlight,
    setHighlight,
    wrapRef,
    inputRef,
    matches,
    suggestions,
  };
}

type ClassState = ReturnType<typeof useClassInput>;
function classTokenActions(options: {
  readonly tokens: readonly string[];
  readonly at: number;
  readonly setCaret: Dispatch<SetStateAction<number>>;
  readonly setDraft: Dispatch<SetStateAction<string>>;
  readonly onChange: ClassInputProps['onChange'];
}) {
  const { tokens, at, setCaret, setDraft, onChange } = options;
  const commit = (next: readonly string[]) => {
    const text = next.join(' ');
    onChange(text, true);
  };

  const addToken = (text: string | undefined) => {
    const token = (text ?? '').trim();
    setDraft('');
    if (!token) {
      return;
    }
    if (tokens.includes(token)) {
      setCaret(tokens.indexOf(token) + 1);
      return;
    }
    const next = [...tokens];
    next.splice(at, 0, token); // insert at the caret
    setCaret(at + 1);
    commit(next);
  };

  const removeAt = (i: number) => {
    if (i < 0 || i >= tokens.length) {
      return;
    }
    const next = tokens.filter((_, j) => j !== i);
    setCaret(Math.max(0, i));
    commit(next);
  };

  return { addToken, removeAt };
}
function useClassFamily(tokens: readonly string[], onChange: ClassInputProps['onChange']) {
  // The family menu: which tag was clicked, what it could become, and where
  // to draw the list. It previews like the prop dropdowns do — arrowing or
  // hovering an option applies it to the page, and closing without picking
  // puts the original back.
  const [family, setFamily] = useState<Family | undefined>(undefined);
  const [famHighlight, setFamHighlight] = useState(-1);
  const famOriginal = useRef(''); // the class that was there when it opened
  const famPreview = useRef<string | undefined>(undefined); // last previewed class, if any
  const famRef = useRef<HTMLDivElement>(null);

  const actions = classFamilyActions({
    tokens,
    onChange,
    family,
    famOriginal,
    famPreview,
    setFamily,
    setFamHighlight,
  });
  // Keep the arrowed option in view.
  useEffect(() => {
    if (!family || famHighlight < 0) {
      return;
    }
    famRef.current?.children[famHighlight]?.scrollIntoView({ block: 'nearest' });
  }, [family, famHighlight]);

  return {
    ...actions,
    family,
    setFamily,
    famHighlight,
    setFamHighlight,
    famOriginal,
    famPreview,
    famRef,
  };
}
function classFamilyActions(options: {
  readonly tokens: readonly string[];
  readonly onChange: ClassInputProps['onChange'];
  readonly family: Family | undefined;
  readonly famOriginal: MutableRefObject<string>;
  readonly famPreview: MutableRefObject<string | undefined>;
  readonly setFamily: Dispatch<SetStateAction<Family | undefined>>;
  readonly setFamHighlight: Dispatch<SetStateAction<number>>;
}) {
  const { tokens, onChange, family, famOriginal, famPreview, setFamily, setFamHighlight } = options;
  // One class swapped for another at a fixed position. Previews skip the
  // de-duplication: a transient repeat is invisible and never saved, while
  // collapsing the list mid-preview would shift every index under it.
  const closeFamily = ({ revert }: { readonly revert: boolean }) => {
    if (
      revert &&
      family &&
      famPreview.current !== undefined &&
      famPreview.current !== famOriginal.current
    ) {
      writeClassAt(
        tokens,
        family.index,
        famOriginal.current,
        { immediate: true, dedupe: false },
        onChange,
      );
    }
    famPreview.current = undefined;
    setFamily(undefined);
    setFamHighlight(-1);
  };

  const previewFamily = (index: number) => {
    if (!family) {
      return;
    }
    setFamHighlight(index);
    const cls = family.options[index];
    if (!cls) {
      return;
    }
    const applied = famPreview.current ?? famOriginal.current;
    if (cls === applied) {
      return;
    }
    famPreview.current = cls;
    // Immediate, like every other menu that previews on hover (the prop
    // dropdowns): a preview that waits out the typing debounce reads as lag.
    // Successive hovers still collapse into one save — each reschedules the
    // same timer — and into one undo step, which is keyed on the prop.
    writeClassAt(tokens, family.index, cls, { immediate: true, dedupe: false }, onChange);
  };

  const applyFamily = (index: number) => {
    if (!family) {
      return;
    }
    const cls = family.options[index];
    const i = family.index;
    famPreview.current = undefined;
    setFamily(undefined);
    setFamHighlight(-1);
    if (cls) {
      writeClassAt(tokens, i, cls, { immediate: true, dedupe: true }, onChange);
    }
  };

  return { closeFamily, previewFamily, applyFamily };
}
function writeClassAt(
  tokens: readonly string[],
  i: number,
  cls: string,
  { immediate, dedupe }: { readonly immediate: boolean; readonly dedupe: boolean },
  onChange: ClassInputProps['onChange'],
): void {
  let next = tokens.map((token, j) => (j === i ? cls : token));
  if (dedupe) {
    next = next.filter((token, j, all) => all.indexOf(token) === j);
  }
  onChange(next.join(' '), immediate);
}
// Everything sharing this class's prefix — the class itself included, so the
// menu says which one is on. Drawn from the project's classes plus the ones
// already on this element, which may not be used anywhere else yet.
function classFamilyOf(cls: string, suggestions: readonly string[], tokens: readonly string[]) {
  const prefix = familyPrefix(cls);
  if (!prefix) {
    return [];
  }
  const pool = new Set([...suggestions, ...tokens]);
  return [...pool].filter((name) => name.startsWith(prefix)).sort(collator.compare);
}
export function classMatches(
  draft: string,
  suggestions: readonly string[],
  tokens: readonly string[],
) {
  const query = draft.trim().toLowerCase();
  const matches = query
    ? suggestions
        .filter((name) => name.toLowerCase().includes(query) && !tokens.includes(name))
        .sort((left, right) => {
          // Prefix matches first, then shortest.
          const ap = left.toLowerCase().startsWith(query) ? 0 : 1;
          const bp = right.toLowerCase().startsWith(query) ? 0 : 1;
          return ap - bp || left.length - right.length;
        })
    : [];

  return matches;
}
function classInputKey(event: React.KeyboardEvent<HTMLInputElement>, state: ClassState): void {
  const {
    draft,
    removeAt,
    at,
    setCaret,
    tokens,
    matches,
    setHighlight,
    highlight,
    addToken,
    setDraft,
    inputRef,
  } = state;
  // While the family menu is up it owns the arrows and Enter: the caret and
  // the suggestion list are both idle behind it.
  if (classFamilyKey(event, state)) {
    return;
  }
  if (event.key === 'Backspace' && !draft) {
    event.preventDefault();
    removeAt(at - 1);
  } else if (event.key === 'Delete' && !draft) {
    event.preventDefault();
    removeAt(at);
  } else if (event.key === 'ArrowLeft' && !draft) {
    event.preventDefault();
    setCaret(Math.max(0, at - 1));
  } else if (event.key === 'ArrowRight' && !draft) {
    event.preventDefault();
    setCaret(Math.min(tokens.length, at + 1));
  } else if (event.key === 'ArrowDown' && matches.length) {
    event.preventDefault();
    setHighlight((current) => Math.min(current + 1, matches.length - 1));
  } else if (event.key === 'ArrowUp' && matches.length) {
    event.preventDefault();
    setHighlight((current) => Math.max(current - 1, 0));
  } else if (event.key === 'Enter') {
    event.preventDefault();
    if (matches.length) {
      addToken(matches[Math.min(highlight, matches.length - 1)]);
    } else {
      addToken(draft);
    }
  } else if (event.key === ' ') {
    event.preventDefault();
    addToken(draft);
  } else if (event.key === 'Tab' && draft) {
    event.preventDefault();
    addToken(matches.length ? matches[Math.min(highlight, matches.length - 1)] : draft);
  } else if (event.key === 'Escape') {
    setDraft('');
    inputRef.current?.blur();
  }
}
function classFamilyKey(event: React.KeyboardEvent<HTMLInputElement>, state: ClassState): boolean {
  const { family, previewFamily, famHighlight, applyFamily, closeFamily } = state;
  if (family) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      previewFamily(Math.min(famHighlight + 1, family.options.length - 1));
      return true;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      previewFamily(Math.max(famHighlight - 1, 0));
      return true;
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault();
      applyFamily(famHighlight);
      return true;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      closeFamily({ revert: true });
      return true;
    }
  }
  return false;
}
function ClassCaret({ state }: { readonly state: ClassState }) {
  const { draft, tokens, inputRef, setDraft, setHighlight, setFocused, addToken } = state;
  // While empty the input is just a caret-width sliver, with negative
  // margins swallowing the flex gap on either side so tags don't spread
  // apart around the cursor.
  const emptyAmongTags = !draft && tokens.length > 0;
  return (
    <input
      key="caret"
      ref={inputRef}
      className={`class-input-field ${emptyAmongTags ? 'empty' : ''}`}
      value={draft}
      style={draft ? { width: `${draft.length + 1}ch` } : undefined}
      spellCheck={false}
      onChange={(event) => {
        setDraft(event.target.value);
        setHighlight(0);
      }}
      onKeyDown={(event) => classInputKey(event, state)}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false);
        if (draft.trim()) {
          addToken(draft);
        }
      }}
    />
  );
}
function ClassTokens({ state }: { readonly state: ClassState }) {
  const {
    tokens,
    at,
    family,
    suggestions,
    setCaret,
    inputRef,
    closeFamily,
    famOriginal,
    famPreview,
    setFamHighlight,
    setFamily,
  } = state;
  const inputElement = <ClassCaret key="caret" state={state} />;
  const items: React.ReactNode[] = [];
  tokens.forEach((token, i) => {
    if (i === at) {
      items.push(inputElement);
    }
    items.push(
      <span
        key={`${token}-${i}`}
        className={`class-tag${family?.index === i ? ' open' : ''}`}
        title={
          classFamilyOf(token, suggestions, tokens).length > 1
            ? 'Click to switch to a related class'
            : 'Click to place the caret after this class'
        }
        onMouseDown={(event) => {
          // preventDefault keeps the inline input from blurring.
          event.preventDefault();
          event.stopPropagation();
          setCaret(i + 1);
          inputRef.current?.focus();
          // Clicking the open tag again closes the menu, keeping whatever was
          // there before the preview.
          if (family?.index === i) {
            closeFamily({ revert: true });
            return;
          }
          closeFamily({ revert: true });
          const options = classFamilyOf(token, suggestions, tokens);
          if (options.length < 2) {
            return;
          }
          const rect = event.currentTarget.getBoundingClientRect();
          famOriginal.current = token;
          famPreview.current = undefined;
          setFamHighlight(options.indexOf(token));
          setFamily({ index: i, options, left: rect.left, top: rect.bottom + 5 });
        }}
      >
        {token}
      </span>,
    );
  });
  if (at >= tokens.length) {
    items.push(inputElement);
  }

  return items;
}
function ClassSuggestions({ state }: { readonly state: ClassState }) {
  const { matches, highlight, setHighlight, addToken, focused, wrapRef, draft } = state;
  const popupPosition = useClassPopup(wrapRef, matches.length, { open: focused });
  const popupRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    popupRef.current?.children[highlight]?.scrollIntoView({ block: 'nearest' });
  }, [highlight, matches.length, draft]);
  if (!popupPosition) {
    return undefined;
  }
  return (
    <Popup
      mode="popover"
      portal={true}
      onClose={() => state.setFocused(false)}
      ref={popupRef}
      className="dd-popup class-suggest"
      style={popupPosition}
    >
      {matches.map((suggestion, i) => (
        <div
          key={suggestion}
          className={`dd-option ${i === highlight ? 'highlight' : ''}`}
          onMouseDown={(event) => event.preventDefault()}
          onMouseEnter={() => setHighlight(i)}
          onClick={() => addToken(suggestion)}
        >
          <span className="dd-option-label">{suggestion}</span>
        </div>
      ))}
    </Popup>
  );
}
function ClassFamilyMenu({ state }: { readonly state: ClassState }) {
  const { family, famRef, famHighlight, famOriginal, previewFamily, applyFamily } = state;
  const position = useClassPopup(state.wrapRef, family?.options.length ?? 0, {
    open: !!family,
    matchWidth: false,
  });
  if (!family || !position) {
    return undefined;
  }
  return (
    <Popup
      mode="popover"
      portal={true}
      onClose={() => state.closeFamily({ revert: true })}
      ref={famRef}
      className="dd-popup class-family"
      style={position}
    >
      {family.options.map((option, i) => (
        <div
          key={option}
          className={`dd-option ${i === famHighlight ? 'highlight' : ''} ${
            option === famOriginal.current ? 'selected' : ''
          }`}
          onMouseDown={(event) => event.preventDefault()}
          onMouseEnter={() => previewFamily(i)}
          onClick={() => applyFamily(i)}
        >
          <span className="dd-option-label">{option}</span>
          <span className="dd-check">{option === famOriginal.current && <CheckIcon size={12} />}</span>
        </div>
      ))}
    </Popup>
  );
}
