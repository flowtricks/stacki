import Popup from '../../../ui/Popup';
// Media and container queries — picking one, adding and editing it — and the
// style card's CSS code view (EmbedEditor.tsx).

import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import { CodeEditor } from '../components/CssCodeEditor';
import SegmentedControl from '../components/SegmentedControl';
import { type MatchedRule, type RuleModel } from '../model/cascade';
import { cssTokens } from '../model/cssCode';
import { buildCssRuleView, type CssRuleRange, type CssRuleView } from '../model/cssRuleView';
import { selectorsMatch, type ContextInfo, type ContextKey, type MatchedSelector, type ResolvedStyle, type StyleContext } from '../model/resolved';
import type { ElementSnapshot, ParsedRule } from '../model/styleTypes';
import { type LiveSetProp } from './EditorBasics';
import { type SourceOption, type SelectorSuggestion } from './LayoutRows';
import { useHighlightInView, QUERY_MODES, type QuerySuggestion, type QueryComboProps } from './SelectorPicker';

export function QueryCombo(props: QueryComboProps) {
  const { draft, setDraft, onSubmit, onCancel, suggestions, ariaLabel } = props;
  const { initial = '', selectOnFocus = false } = props;
  const [open, setOpen] = useState(true);
  const [highlight, setHighlight] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  useFocusOnMount({ inputRef, selectOnFocus });

  const filtered = useMemo(() => filteredQueries(suggestions, draft, initial), [suggestions, draft, initial]);
  const showList = open && filtered.length > 0;
  useHighlightInView({ listRef, highlight, showList });

  const submit = (text: string) => {
    const trimmed = text.trim();
    if (trimmed && trimmed !== '@') {
      onSubmit(trimmed);
    }
  };
  const combo = { draft, setDraft, open, setOpen, highlight, setHighlight, filtered, showList };

  return (
    <div className="embed-editor_add-query-field">
      <input
        ref={inputRef}
        className="u-input embed-editor_add-query-input"
        value={draft}
        placeholder="@media (width < 50em)"
        spellCheck={false}
        role="combobox"
        aria-expanded={showList}
        aria-autocomplete="list"
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onChange={(event) => {
          setDraft(event.target.value);
          setOpen(true);
          setHighlight(-1);
        }}
        onKeyDown={(event) => queryKeyDown(event, combo, { submit, onCancel })}
        aria-label={ariaLabel}
      />
      {showList ? (
        <QuerySuggestionList
          onClose={() => setOpen(false)}
          listRef={listRef}
          filtered={filtered}
          highlight={highlight}
          setHighlight={setHighlight}
          submit={submit}
        />
      ) : undefined}
    </div>
  );
}

// Focus the field on mount: select the whole value (editing), or park the caret at
// its end (adding).
export function useFocusOnMount({ inputRef, selectOnFocus }: { inputRef: React.RefObject<HTMLInputElement>; selectOnFocus: boolean }) {
  useEffect(() => {
    const input = inputRef.current;
    if (!input) {
      return;
    }
    input.focus();
    if (selectOnFocus) {
      input.select();
    } else {
      input.setSelectionRange(input.value.length, input.value.length);
    }
  }, [selectOnFocus, inputRef]);
}

export function QuerySuggestionList({
  onClose,
  listRef,
  filtered,
  highlight,
  setHighlight,
  submit,
}: {
  readonly onClose: () => void;
  listRef: React.RefObject<HTMLDivElement>;
  filtered: QuerySuggestion[];
  highlight: number;
  setHighlight: (index: number) => void;
  submit: (text: string) => void;
}) {
  return (
    <Popup mode="popover" portal={false} onClose={onClose} className="embed-editor_selector-suggest" ref={listRef} role="listbox" label="Query suggestions">
      {filtered.map((suggestion, i) => (
        <button
          key={`${suggestion.kind}:${suggestion.query}`}
          type="button"
          role="option"
          aria-selected={i === highlight}
          className={`embed-editor_suggest-item ${i === highlight ? 'is-active' : ''}`}
          onMouseDown={(event) => event.preventDefault()}
          onMouseMove={() => setHighlight(i)}
          onClick={() => submit(suggestion.query)}
        >
          <span className="embed-editor_suggest-sel">{suggestion.query}</span>
          <span className="embed-editor_suggest-kind">{suggestion.kind}</span>
        </button>
      ))}
    </Popup>
  );
}

// Filtering is for narrowing a query being typed. A field holding a WHOLE query — the
// one being renamed, or a suggestion just picked — has nothing left to narrow:
// matching it against itself leaves a list of one, hiding the very queries you opened
// the field to switch to. So a complete query shows them all.
export function filteredQueries(suggestions: QuerySuggestion[], draft: string, initial: string): QuerySuggestion[] {
  const query = draft.trim().toLowerCase();
  const whole = query === initial.trim().toLowerCase() || suggestions.some((suggestion) => suggestion.query.toLowerCase() === query);
  if (!query || query === '@' || whole) {
    return suggestions;
  }
  return suggestions.filter((suggestion) => suggestion.query.toLowerCase().includes(query));
}

// The query field's keys: ↓/↑ move the highlight (opening the list), Enter submits the
// highlighted suggestion or the typed query, Tab fills the highlighted (or first)
// suggestion in, Escape closes the list and then cancels the form.
export function queryKeyDown(
  event: ReactKeyboardEvent<HTMLInputElement>,
  combo: {
    draft: string;
    setDraft: (next: string) => void;
    open: boolean;
    setOpen: (open: boolean) => void;
    highlight: number;
    setHighlight: React.Dispatch<React.SetStateAction<number>>;
    filtered: QuerySuggestion[];
    showList: boolean;
  },
  actions: { submit: (text: string) => void; onCancel: () => void },
) {
  const { highlight, filtered, showList } = combo;
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    combo.setOpen(true);
    combo.setHighlight((previous) => Math.min(previous + 1, filtered.length - 1));
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    combo.setHighlight((previous) => Math.max(previous - 1, -1));
  } else if (event.key === 'Enter') {
    event.preventDefault();
    const highlighted = showList && highlight >= 0 ? filtered[highlight] : undefined;
    actions.submit(highlighted ? highlighted.query : combo.draft);
  } else if (event.key === 'Tab') {
    const pick = highlight >= 0 ? filtered[highlight] : filtered[0];
    if (showList && pick) {
      event.preventDefault();
      combo.setDraft(pick.query);
      combo.setHighlight(-1);
    }
  } else if (event.key === 'Escape') {
    event.preventDefault();
    if (combo.open && combo.draft.trim() !== '@') {
      combo.setOpen(false);
    } else {
      actions.onCancel();
    }
  }
}

// Inline form to add a custom query (@media/@container/@supports) to the current
// selector, choosing whether it WRAPS the selector (a new at-rule block) or NESTS
// inside the selector's existing rule (CSS nesting). Nesting needs a picked selector.
// The controls sit ABOVE the input so the suggestion list (opened below it) can't
// cover them; the input pre-fills `@` and offers project + common queries.
export function AddQueryForm({
  canNest,
  suggestions,
  onAdd,
  onCancel,
}: {
  canNest: boolean;
  suggestions: QuerySuggestion[];
  onAdd: (query: string, mode: 'wrap' | 'nest') => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState('@');
  const [mode, setMode] = useState<'wrap' | 'nest'>('nest');
  const submit = (text: string) => onAdd(text, canNest ? mode : 'wrap');

  return (
    <div className="embed-editor_add-query">
      <div className="embed-editor_add-query-controls">
        <SegmentedControl
          className="embed-editor_add-query-mode"
          options={QUERY_MODES}
          value={canNest ? mode : 'wrap'}
          onChange={setMode}
          ariaLabel="How to add the query"
          disabled={!canNest}
          widthMode="hug"
        />
        <div className="embed-editor_add-query-actions">
          <button type="button" className="u-button is-ghost is-small" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="u-button is-primary is-small" onClick={() => submit(draft)} disabled={draft.trim() === '' || draft.trim() === '@'}>
            Add
          </button>
        </div>
      </div>
      {!canNest ? <p className="embed-editor_add-query-note">Pick a selector to nest inside it.</p> : undefined}
      <QueryCombo draft={draft} setDraft={setDraft} onSubmit={submit} onCancel={onCancel} suggestions={suggestions} ariaLabel="Query to add" />
    </div>
  );
}

// Rename a query wherever this stylesheet spells it. A breakpoint is one idea
// written in several places — this component's four `@media (width >= 64rem)`
// blocks are one breakpoint — so editing it here rewrites every one of them, and
// the count says how many before you commit to it.
export function EditQueryForm({
  query,
  uses,
  sourceLabel,
  suggestions,
  onRename,
  onCancel,
}: {
  query: string;
  uses: number;
  sourceLabel: string;
  suggestions: QuerySuggestion[];
  onRename: (from: string, to: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(query);
  const changed = draft.trim() !== '' && draft.trim() !== '@' && draft.trim() !== query;
  const submit = (text: string) => {
    const trimmed = text.trim();
    if (trimmed && trimmed !== '@' && trimmed !== query) {
      onRename(query, trimmed);
    }
  };

  return (
    <div className="embed-editor_add-query is-rename">
      <div className="embed-editor_add-query-controls">
        <span className="embed-editor_add-query-count" title={`${uses === 1 ? '1 block' : `${uses} blocks`} in ${sourceLabel}`}>
          {uses === 1 ? '1 block' : `${uses} blocks`} in {sourceLabel}
        </span>
        <div className="embed-editor_add-query-actions">
          <button type="button" className="u-button is-ghost is-small" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="u-button is-primary is-small" onClick={() => submit(draft)} disabled={!changed}>
            Rename
          </button>
        </div>
      </div>
      <QueryCombo
        draft={draft}
        setDraft={setDraft}
        onSubmit={submit}
        onCancel={onCancel}
        suggestions={suggestions}
        ariaLabel="Query"
        initial={query}
        selectOnFocus
      />
    </div>
  );
}

export function cssRuleMatchesSelector(matched: MatchedRule, selector: string): boolean {
  if (selectorsMatch(matched.rule.selectorText, selector)) {
    return true;
  }
  return matched.matchedSelectors.some((entry) => selectorsMatch(entry.text, selector));
}

export function cssRuleMatchesVisibleSelector(matched: MatchedRule, visibleSelectors: readonly string[]): boolean {
  return visibleSelectors.some((selector) => cssRuleMatchesSelector(matched, selector));
}

export function cssSelectorLine(line: string, lineFrom: number, matchedRanges: readonly CssRuleRange[]): ReactNode {
  const segments: ReactNode[] = [];
  let cursor = 0;
  for (const range of matchedRanges) {
    const from = Math.max(0, range.from - lineFrom);
    const to = Math.min(line.length, range.to - lineFrom);
    if (to <= from) {
      continue;
    }
    if (from > cursor) {
      segments.push(
        <span key={`plain:${cursor}`} className="embed-editor_css-code-selector-unmatched">
          {line.slice(cursor, from)}
        </span>,
      );
    }
    segments.push(
      <span key={`matched:${from}`} className="embed-editor_css-code-selector">
        {line.slice(from, to)}
      </span>,
    );
    cursor = to;
  }
  if (cursor < line.length) {
    segments.push(
      <span key={`plain:${cursor}`} className="embed-editor_css-code-selector-unmatched">
        {line.slice(cursor)}
      </span>,
    );
  }
  return segments;
}

// A code line that is not part of a selector list: a declaration, a rule's opening
// line, or punctuation.
export function cssCodeLine(line: string): ReactNode {
  const declaration = line.match(/^(\s*)([-\w]+)(:\s*)(.*?)(;?)$/);
  if (declaration) {
    const [, spacing = '', property = '', colon = '', value = '', semicolon = ''] = declaration;
    return (
      <>
        {spacing}
        <span className="embed-editor_css-code-property">{property}</span>
        <span className="embed-editor_css-code-punctuation">{colon}</span>
        {cssTokens(value).map((token, index) => (
          <span key={`${index}:${token.kind}`} className={`cx-${token.kind}`}>
            {token.text}
          </span>
        ))}
        <span className="embed-editor_css-code-punctuation">{semicolon}</span>
      </>
    );
  }
  const brace = line.lastIndexOf('{');
  if (brace >= 0) {
    const selectorClass = line.trimStart().startsWith('@') ? 'embed-editor_css-code-context' : 'embed-editor_css-code-selector';
    return (
      <>
        <span className={selectorClass}>{line.slice(0, brace)}</span>
        <span className="embed-editor_css-code-punctuation">{'{'}</span>
      </>
    );
  }
  return <span className="embed-editor_css-code-punctuation">{line || ' '}</span>;
}

export function CssCodePreview({ view, ariaLabel }: { view: CssRuleView; ariaLabel: string }) {
  let offset = 0;
  return (
    <pre className="embed-editor_css-code-preview" aria-label={ariaLabel} tabIndex={0}>
      {view.code.split('\n').map((line, index) => {
        const from = offset;
        const to = from + line.length;
        offset = to + 1;
        const overridden = view.highlights.some((range) => range.from < to && range.to > from);
        const selectorList = view.selectorLists.some((range) => range.from < to && range.to > from);
        const matchedRanges = view.selectors.filter((range) => range.from < to && range.to > from);
        return (
          <span key={`${index}:${line}`} className={`embed-editor_css-code-line ${overridden ? 'is-overridden' : ''}`}>
            {selectorList ? cssSelectorLine(line, from, matchedRanges) : cssCodeLine(line)}
          </span>
        );
      })}
    </pre>
  );
}

export function EditableCssRule({
  rule,
  busy,
  onSave,
}: {
  readonly rule: ParsedRule;
  readonly busy: boolean;
  readonly onSave: (rule: ParsedRule, css: string) => void;
}) {
  const sourceCss = rule.node.toString();
  const [draft, setDraft] = useState(sourceCss);
  const attemptedDraftRef = useRef<string | undefined>(undefined);
  const previousSourceRef = useRef(sourceCss);

  // External style-panel edits replace a clean draft, while text currently being
  // authored stays untouched. After our own autosave, draft already equals sourceCss.
  useEffect(() => {
    setDraft((current) => (current === previousSourceRef.current ? sourceCss : current));
    previousSourceRef.current = sourceCss;
  }, [sourceCss]);

  // A short pause is the commit boundary. Busy saves serialize naturally: if a
  // newer draft arrives during one write, busy clearing schedules that latest text.
  useEffect(() => {
    if (draft === sourceCss) {
      attemptedDraftRef.current = undefined;
      return;
    }
    if (busy) {
      return;
    }
    if (draft === attemptedDraftRef.current) {
      return;
    }
    const timer = window.setTimeout(() => {
      attemptedDraftRef.current = draft;
      onSave(rule, draft);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [busy, draft, onSave, rule, sourceCss]);

  return (
    <CodeEditor
      value={draft}
      language="css"
      ariaLabel={`Editable CSS for ${rule.selectorText}; changes save automatically`}
      minHeight="100px"
      onChange={setDraft}
      className="embed-editor_css-code-editor"
    />
  );
}

export type CssCodeSectionProps = {
  readonly model: RuleModel;
  readonly activeSelector: string;
  readonly visibleSelectors: readonly string[];
  readonly editableRule: ParsedRule | undefined;
  readonly busy: boolean;
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly onSave: (rule: ParsedRule, css: string) => void;
};

export function CssCodeHeader({ open, sourceLabel, onToggle }: { readonly open: boolean; readonly sourceLabel: string; readonly onToggle: () => void }) {
  return (
    <button
      type="button"
      className="embed-editor_css-code-header embed-editor_css-code-toggle"
      aria-expanded={open}
      aria-label={`${open ? 'Collapse' : 'Expand'} CSS Code`}
      onClick={onToggle}
    >
      <span className="embed-editor_css-code-title">CSS Code</span>
      {sourceLabel ? (
        <span className="embed-editor_css-code-source" title={sourceLabel}>
          {sourceLabel}
        </span>
      ) : undefined}
      <span className="embed-editor_css-code-chevron" aria-hidden="true">
        <svg className="embed-editor_section-chevron" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M4.2 6.2 8 10l3.8-3.8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
    </button>
  );
}

export function CssCodeSection({ model, activeSelector, visibleSelectors, editableRule, busy, open, onToggle, onSave }: CssCodeSectionProps) {
  const rules = useMemo(() => {
    const visible = [...model.base, ...model.conditional].filter((rule) => cssRuleMatchesVisibleSelector(rule, visibleSelectors));
    if (!activeSelector) {
      return visible;
    }
    return visible.filter((rule) => cssRuleMatchesSelector(rule, activeSelector));
  }, [model, activeSelector, visibleSelectors]);
  const view = useMemo(() => buildCssRuleView(rules), [rules]);
  const sources = useMemo(() => [...new Set(rules.map((entry) => entry.rule.embedLabel))], [rules]);
  const sourceLabel = activeSelector ? (editableRule?.embedLabel ?? sources.join(', ')) : '';

  return (
    <section className={`embed-editor_css-code ${open ? 'is-open' : 'is-collapsed'}`}>
      <CssCodeHeader open={open} sourceLabel={sourceLabel} onToggle={onToggle} />
      {open ? (
        <div className="embed-editor_css-code-body">
          {activeSelector && editableRule ? (
            <EditableCssRule key={editableRule.ruleId} rule={editableRule} busy={busy} onSave={onSave} />
          ) : view.code ? (
            <CssCodePreview view={view} ariaLabel="CSS matching this element" />
          ) : (
            <p className="embed-editor_css-code-empty">No matching CSS rules.</p>
          )}
        </div>
      ) : undefined}
    </section>
  );
}

export type StyleCardProps = {
  snapshot: ElementSnapshot | undefined;
  selectedSelector: string;
  activePicked: boolean;
  cssCodeOpen: boolean;
  onToggleCssCode: () => void;
  model: RuleModel;
  resolved: ResolvedStyle;
  contexts: StyleContext[];
  contextInfos: ContextInfo[];
  context: ContextKey;
  onContext: (context: ContextKey) => void;
  onAddQuery: (query: string, mode: 'wrap' | 'nest') => void;
  onRenameQuery: (from: string, to: string) => void;
  /** How many blocks in the source stylesheet each query is written in — the
   *  queries it's possible to rename from here, and how much a rename touches. */
  queryUses: Map<string, number>;
  sourceLabel: string;
  querySuggestions: QuerySuggestion[];
  selectors: MatchedSelector[];
  suggestions: SelectorSuggestion[];
  activeSelector: string;
  onSelectActive: (selector: string) => void;
  onDeselect: () => void;
  onAddSelector: (selector: string) => void;
  sourceValue: string;
  sourceOptions: SourceOption[];
  onSourceChange: (value: string) => void;
  sourceNote: string | undefined;
  nativeStyleName: string | undefined;
  /** Still fetching embeds — show a spinner in place of the source picker. */
  loading: boolean;
  /** Still working out which selectors style this element — the well says so
   *  rather than reading as "none". */
  resolving: boolean;
  busy: boolean;
  pending: boolean;
  setProp: (prop: string, value: string, important: boolean) => void;
  clearProp: (prop: string | string[]) => void;
  liveSetProp: LiveSetProp;
  onSelectSelector: (selector: string, prop?: string) => void;
  onAdd: (prop: string, value: string, important: boolean) => void;
  onSaveCssRule: (rule: ParsedRule, css: string) => void;
  onRemoveRule: (rule: ParsedRule) => void;
};
