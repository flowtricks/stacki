import { useLayoutEffect, useRef } from 'react';
import type { MutableRefObject } from 'react';
import { basicSetup } from 'codemirror';
import { Annotation, EditorState, StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView } from '@codemirror/view';
import { invertedEffects, isolateHistory } from '@codemirror/commands';
import { codeIndentExtensions, codeIndentStyleFor } from '../../ui/codeEditorIndent';
import { BOUNDARY_LIMITS } from '../../../shared/core/boundary';
import { assert } from '../../../shared/core/assert';
import { appTheme, appHighlight, externalChange, codeEditorLanguage } from '../../ui/CodeEditor';
import { astroHighlight } from '../../ui/astroHighlight';
import { editConflictDraft } from './conflictDraft';
import type { ConflictDraft } from './conflictDraft';
import type { Clash } from './gitConflictModel';
import { conflictHighlights } from './conflictHighlights';
import { languageFor } from '../../ui/codeHighlight';
import { useTranslate } from '../../lib/i18n/useTranslate';
import type { Translator } from '../../lib/i18n/localeContext';

interface MergeEditorProps {
  readonly path: string;
  readonly draft: ConflictDraft;
  readonly clashes: readonly Clash[];
  readonly active: number;
  readonly busy: boolean;
  readonly ours: string;
  readonly theirs: string;
  readonly onEdit: (draft: ConflictDraft) => void;
  readonly onSelect: (index: number) => void;
}
const external = Annotation.define<boolean>();
const draftEffect = StateEffect.define<ConflictDraft>();
const draftField = StateField.define<ConflictDraft>({
  create: () => {
    throw new Error('Merge editor: draft initializer required');
  },
  update: (value, transaction) => {
    const restored = transaction.effects.find((effect) => effect.is(draftEffect));
    return restored?.value ?? (transaction.docChanged ? editConflictDraft(value, transaction.changes) : value);
  },
});
const marks = StateEffect.define<ReturnType<typeof Decoration.set>>();
const markField = StateField.define({
  create: () => Decoration.none,
  update: (value, transaction) => transaction.effects.find((effect) => effect.is(marks))?.value ?? value.map(transaction.changes),
  provide: (field) => EditorView.decorations.from(field),
});

export default function MergeResultEditor(props: MergeEditorProps) {
  const translate = useTranslate();
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView | undefined>(undefined);
  const latest = useRef(props);
  latest.current = props;
  useLayoutEffect(() => {
    assert(host.current !== null, 'Merge editor: mounted host exists');
    const view = createMergeEditor(host.current, latest, translate);
    editor.current = view;
    return () => {
      view.destroy();
      editor.current = undefined;
    };
  }, [props.path, translate]);
  useLayoutEffect(() => {
    const view = editor.current;
    if (view === undefined) {
      return;
    }
    const change = externalChange(view.state.doc.toString(), props.draft.text);
    if (change !== undefined) {
      view.dispatch({
        changes: change,
        effects: draftEffect.of(props.draft),
        annotations: [external.of(true), isolateHistory.of('full')],
      });
    }
    view.dispatch({ effects: [draftEffect.of(props.draft), marks.of(mergeEditorMarks(props, translate))] });
  }, [props, translate]);
  useLayoutEffect(() => {
    const view = editor.current;
    const region = latest.current.draft.regions[props.active];
    if (view !== undefined && region !== undefined) {
      view.dispatch({ effects: EditorView.scrollIntoView(region.from, { y: 'center' }) });
    }
  }, [props.active, props.path]);
  return <div className="merge-result-editor" ref={host} />;
}

function createMergeEditor(parent: HTMLDivElement, latest: MutableRefObject<MergeEditorProps>, translate: Translator) {
  const language = languageFor(latest.current.path);
  return new EditorView({
    parent,
    state: EditorState.create({
      doc: latest.current.draft.text,
      extensions: [
        basicSetup,
        codeIndentExtensions(codeIndentStyleFor(latest.current.path)),
        appTheme,
        codeEditorLanguage(language),
        language === 'astro' ? astroHighlight : appHighlight,
        EditorState.lineSeparator.of('\n'),
        markField,
        draftField.init(() => latest.current.draft),
        invertedEffects.of((transaction) => (transaction.docChanged ? [draftEffect.of(transaction.startState.field(draftField))] : [])),
        EditorView.contentAttributes.of({ 'aria-label': translate('git.conflict.finalMerged') }),
        EditorState.transactionFilter.of((transaction) => {
          if (transaction.annotation(external)) {
            return transaction;
          }
          if (latest.current.busy && transaction.docChanged) {
            return [];
          }
          return transaction.newDoc.length <= BOUNDARY_LIMITS.textLengthMax ? transaction : [];
        }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged && !update.transactions.some((item) => item.annotation(external))) {
            latest.current.onEdit(update.state.field(draftField));
          }
        }),
        mergeEditorInteractions(latest),
      ],
    }),
  });
}

function mergeEditorMarks(props: MergeEditorProps, translate: Translator) {
  const ranges = conflictHighlights(props.draft, props.clashes)
    .filter((range) => range.to > range.from)
    .map((range) =>
      Decoration.mark({
        class: `merge-code-${range.source}`,
        attributes: {
          title:
            range.source === 'custom'
              ? translate('git.conflict.yourEdit')
              : translate('git.conflict.from', { branch: range.source === 'ours' ? props.ours : props.theirs }),
        },
      }).range(range.from, range.to),
    );
  const selected = props.draft.regions[props.active];
  if (selected !== undefined && selected.from < selected.to) {
    ranges.push(Decoration.mark({ class: 'merge-code-active' }).range(selected.from, selected.to));
  }
  return Decoration.set(ranges, true);
}

function mergeEditorInteractions(latest: MutableRefObject<MergeEditorProps>) {
  return EditorView.domEventHandlers({
    click: (event, view) => {
      const position = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (position !== null) {
        const index = latest.current.draft.regions.findIndex((region) => region.from <= position && position <= region.to);
        if (index >= 0) {
          latest.current.onSelect(index);
        }
      }
      return false;
    },
  });
}
