// The words being spoken, drawn where they will land (the end of the composer's text, or at the caret of a box that
// dictates there) as a draft: dimmer and italic, and
// pulsing while Whisper is decoding, so the box never looks frozen. It is a CodeMirror widget, not
// text: it is not in the document, so it never enters the message, the undo history or the cursor's
// reach. When the phrase ends, useDictation writes the final words as real text and the draft empties.
import { StateEffect, StateField, type Extension } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view';
import { assert } from '../../../../shared/core/assert';
import { DICTATION_LIMITS } from '../../../../shared/properties/voice/dictationLimits';

export interface DictationDraft {
  readonly text: string;
  /** A decode is running: the draft pulses. */
  readonly decoding: boolean;
  /** Where the words will land; the end of the text unless said. */
  readonly place?: 'end' | 'caret';
}

export const NO_DRAFT: DictationDraft = { text: '', decoding: false, place: 'end' };

const setDraft = StateEffect.define<DictationDraft>();

class DraftWidget extends WidgetType {
  constructor(
    private readonly draft: DictationDraft,
    private readonly previous: string,
  ) {
    super();
  }

  override eq(other: DraftWidget): boolean {
    return other.draft.text === this.draft.text && other.draft.decoding === this.draft.decoding && other.previous === this.previous;
  }

  override toDOM(view: EditorView): HTMLElement {
    const span = view.dom.ownerDocument.createElement('span');
    span.className = this.draft.decoding ? 'ai-dictation-draft is-decoding' : 'ai-dictation-draft';
    span.setAttribute('aria-live', 'polite');
    // A space when the text before it does not end in one, as the final words will be written.
    const gap = this.previous === '' || /\s/u.test(this.previous) ? '' : ' ';
    span.textContent = `${gap}${this.draft.text}`;
    return span;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

const draftField = StateField.define<{ readonly draft: DictationDraft; readonly decorations: DecorationSet }>({
  create: () => ({ draft: NO_DRAFT, decorations: Decoration.none }),
  update(value, transaction) {
    let draft = value.draft;
    for (const effect of transaction.effects) {
      if (effect.is(setDraft)) {
        draft = effect.value;
      }
    }
    const moved = draft.place === 'caret' && transaction.selection !== undefined;
    if (draft === value.draft && !transaction.docChanged && !moved) {
      return value;
    }
    const at = draft.place === 'caret' ? transaction.state.selection.main.head : transaction.state.doc.length;
    const previous = at === 0 ? '' : transaction.state.doc.sliceString(at - 1, at);
    // Only words are drawn: a decode with nothing to show yet pulses the microphone button instead, so the
    // editor never holds an empty element that could take a line of its own.
    const shown = draft.text !== '';
    const decorations = shown ? Decoration.set([Decoration.widget({ widget: new DraftWidget(draft, previous), side: 1 }).range(at)]) : Decoration.none;
    return { draft, decorations };
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
});

/** The editor extension that draws the draft. */
export const dictationDraftExtension: Extension = draftField;

/** Shows `draft` where its words will land; a draft without text and not decoding removes it. */
export function showDictationDraft(view: EditorView, draft: DictationDraft): void {
  assert(draft.text.length <= DICTATION_LIMITS.segmentCharsMax, 'showDictationDraft: a draft is one segment');
  const current = view.state.field(draftField).draft;
  if (current.text !== draft.text || current.decoding !== draft.decoding || current.place !== draft.place) {
    view.dispatch({ effects: setDraft.of(draft) });
  }
}
