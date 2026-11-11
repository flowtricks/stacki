// The CSS code section for a style attribute written as code (useInlineTarget.ts):
// which branch is edited, where the edit is written, and that branch's declarations
// in an editor. `${maxWidth}` shows as an atomic `{maxWidth}` token: the caret steps
// over it and a delete takes it whole, so it is moved or removed, never typed into.
// A short pause commits the branch, as the rule editor does.

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view';
import { RangeSetBuilder, type Extension } from '@codemirror/state';
import Dropdown from '../../../ui/Dropdown';
import { assert } from '../../../../shared/core/assert';
import { CodeEditor } from '../components/CssCodeEditor';
import {
  STYLE_BLOCK_PREFIX,
  STYLE_BLOCK_SUFFIX,
  declarationsFromDisplay,
  displayStyleDeclarations,
  interpolationRanges,
  type StyleBranch,
} from '../model/inlineBranches';

const COMMIT_PAUSE_MS = 300;

export interface InlineBranchView {
  readonly branches: readonly StyleBranch[];
  readonly selected: StyleBranch;
  readonly onSelect: (key: string) => void;
  readonly onCommit: (body: string) => void;
  /** `Edits Heading.astro · all instances`, when the style lives in a component. */
  readonly writesTo: string | undefined;
}

/** The branch picker, for the CSS code section's header. */
export function InlineBranchPicker({ view, busy }: { readonly view: InlineBranchView; readonly busy: boolean }): ReactNode {
  if (view.branches.length < 2) {
    return undefined;
  }
  return (
    <Dropdown
      className="embed-editor_inline-branch"
      ariaLabel="Branch of the style attribute to edit"
      disabled={busy}
      value={view.selected.key}
      options={view.branches.map((branch) => ({ value: branch.key, label: `Editing: ${branch.label}` }))}
      onChange={view.onSelect}
    />
  );
}

export function InlineBranchEditor({ view, busy }: { readonly view: InlineBranchView; readonly busy: boolean }): ReactNode {
  // The branch's text inside a locked `element.style { … }`, as dev tools show an
  // element's inline style; only the text between the edges is edited and written.
  const body = view.selected.body;
  const source = `${STYLE_BLOCK_PREFIX}${displayStyleDeclarations(body)}${STYLE_BLOCK_SUFFIX}`;
  const [draft, setDraft] = useState(source);
  const previousRef = useRef(source);
  const attemptedRef = useRef<string | undefined>(undefined);
  // An outside edit (the panel's controls, undo) replaces a clean draft only.
  useEffect(() => {
    setDraft((current) => (current === previousRef.current ? source : current));
    previousRef.current = source;
  }, [source]);
  const { onCommit } = view;
  useEffect(() => {
    if (draft === source) {
      attemptedRef.current = undefined;
      return undefined;
    }
    if (busy || draft === attemptedRef.current) {
      return undefined;
    }
    const timer = window.setTimeout(() => {
      attemptedRef.current = draft;
      if (draft.startsWith(STYLE_BLOCK_PREFIX) && draft.endsWith(STYLE_BLOCK_SUFFIX)) {
        // Back in the attribute's own formatting; nothing written when no declaration changed.
        const next = declarationsFromDisplay(draft.slice(STYLE_BLOCK_PREFIX.length, draft.length - STYLE_BLOCK_SUFFIX.length), body);
        if (next !== body) {
          onCommit(next);
        }
      }
    }, COMMIT_PAUSE_MS);
    return () => window.clearTimeout(timer);
  }, [body, busy, draft, onCommit, source]);
  const extensions = useMemo(() => [interpolationTokens()], []);
  return (
    <>
      {view.writesTo === undefined ? undefined : <p className="embed-editor_inline-writes-to">{view.writesTo}</p>}
      <CodeEditor
        key={view.selected.key}
        value={draft}
        language="css"
        ariaLabel={`Style declarations ${view.selected.label}; changes save automatically`}
        variables={{ kind: 'declarations' }}
        minHeight="64px"
        lineOverflow="wrap"
        extensions={extensions}
        lockedEdges={{ prefixLength: STYLE_BLOCK_PREFIX.length, suffixLength: STYLE_BLOCK_SUFFIX.length }}
        onChange={setDraft}
        className="embed-editor_css-code-editor"
      />
    </>
  );
}

// `{maxWidth}`, drawn over `${maxWidth}` in the text.
class InterpolationWidget extends WidgetType {
  constructor(private readonly code: string) {
    super();
  }
  override eq(other: InterpolationWidget): boolean {
    return other.code === this.code;
  }
  override toDOM(): HTMLElement {
    const token = document.createElement('span');
    token.className = 'embed-editor_inline-token';
    token.textContent = `{${this.code}}`;
    token.title = `${this.code}, from the component’s props`;
    return token;
  }
  override ignoreEvent(): boolean {
    return false;
  }
}

function tokenDecorations(text: string): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const range of interpolationRanges(text)) {
    assert(range.to > range.from, 'tokenDecorations: a token has text');
    const code = text.slice(range.from + 2, range.to - 1).trim();
    builder.add(range.from, range.to, Decoration.replace({ widget: new InterpolationWidget(code) }));
  }
  return builder.finish();
}

/** Each `${…}` as one atomic token: drawn as `{name}`, stepped over and deleted whole. */
export function interpolationTokens(): Extension {
  const decorations = EditorView.decorations.of((view) => tokenDecorations(view.state.doc.toString()));
  const atomic = EditorView.atomicRanges.of((view) => tokenDecorations(view.state.doc.toString()));
  return [decorations, atomic];
}
