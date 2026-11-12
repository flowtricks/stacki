// The CodeMirror half of the chip editor: chips inside an editable text, as single atomic
// units. A chip is one placeholder character in the document drawn as a pill (a replace
// decoration with a widget), so the caret steps over it, Backspace and Delete remove it
// whole, selection and drag treat it as one character, and undo brings it back.
//
// It is generic and knows no product: `createChipEditor<Chip>` takes a `describe` function
// that says how a chip looks (label, tooltip, kind), and returns the extension to add to an
// editor plus the functions to put chips in and read the draft out as segments.
//
// Why a placeholder character and not a widget alone: positions, selection, history and
// IME composition all work on the document text, so a chip that is a character takes part
// in all of them for free. The cost is the invariant this file guards: every placeholder in
// the document has a chip, and no placeholder arrives any other way. A typed or pasted
// placeholder is refused (otherwise a chip with no payload could be sent), and undo/redo
// restore chips through `invertedEffects`, because history records text but not decorations.
import { invertedEffects } from '@codemirror/commands';
import { Annotation, EditorState, MapMode, StateEffect, StateField } from '@codemirror/state';
import type { Extension, TransactionSpec } from '@codemirror/state';
import { Decoration, EditorView, WidgetType } from '@codemirror/view';
import type { DecorationSet } from '@codemirror/view';
import { assert } from '../../../shared/core/assert';
import { CHIP_CHARACTER, CHIP_COUNT_MAX, documentToSegments, segmentsToDocument } from './chipModel';
import type { Segment } from './chipModel';

/** How a chip is drawn. */
export interface ChipLook {
  readonly label: string;
  /** Hover text and the accessible name when it says more than the label. */
  readonly title?: string;
  /** Becomes data-chip-kind on the pill, so a stylesheet can colour or mark each kind. */
  readonly kind?: string;
}

export interface ChipEditorOptions<Chip> {
  readonly describe: (chip: Chip) => ChipLook;
  /** Called when a pill is clicked; the editor does not move its caret for the click. */
  readonly onChipClick?: (chip: Chip, element: HTMLElement) => void;
  /** Adds anything to the pill beyond its label (an icon). Called once per drawn pill. */
  readonly decorate?: (chip: Chip, element: HTMLElement) => void;
}

export interface ChipEditor<Chip> {
  /** Add to the editor's extensions. */
  readonly extension: Extension;
  /** A transaction that puts `chip` where `range` was (default: the selection), or undefined when the draft already holds the most chips it may. */
  readonly insertChip: (state: EditorState, chip: Chip, options?: InsertOptions) => TransactionSpec | undefined;
  /** The draft as segments. */
  readonly readSegments: (state: EditorState) => readonly Segment<Chip>[];
  /** A state holding `segments`, with this editor's extension and the given `extensions`. */
  readonly createState: (segments: readonly Segment<Chip>[], extensions?: readonly Extension[]) => EditorState;
  /** A transaction that replaces the whole draft with `segments`. */
  readonly replaceSegments: (state: EditorState, segments: readonly Segment<Chip>[]) => TransactionSpec;
  readonly chipCount: (state: EditorState) => number;
}

export interface InsertOptions {
  readonly from?: number;
  readonly to?: number;
  /** Text typed after the chip; a space by default, so the next word does not touch it. */
  readonly trailing?: string;
}

// Marks a transaction that inserts placeholders on purpose.
const chipInsertion = Annotation.define<boolean>();

class ChipWidget<Chip> extends WidgetType {
  constructor(
    readonly chip: Chip,
    private readonly look: ChipLook,
    private readonly options: ChipEditorOptions<Chip>,
  ) {
    super();
  }

  override eq(other: ChipWidget<Chip>): boolean {
    return other.chip === this.chip && other.look.label === this.look.label && other.look.title === this.look.title && other.look.kind === this.look.kind;
  }

  override toDOM(): HTMLElement {
    const element = document.createElement('span');
    element.className = 'chip-editor-chip';
    element.setAttribute('contenteditable', 'false');
    element.setAttribute('aria-label', this.look.title ?? this.look.label);
    if (this.look.title !== undefined) {
      element.title = this.look.title;
    }
    if (this.look.kind !== undefined) {
      element.dataset['chipKind'] = this.look.kind;
    }
    this.options.decorate?.(this.chip, element);
    const label = document.createElement('span');
    label.className = 'chip-editor-chip-label';
    label.textContent = this.look.label;
    element.append(label);
    const { onChipClick } = this.options;
    if (onChipClick !== undefined) {
      element.setAttribute('role', 'button');
      element.addEventListener('click', (event) => {
        event.preventDefault();
        onChipClick(this.chip, element);
      });
    }
    return element;
  }

  // Clicks reach the pill's own listener; the editor must not also move the caret into it.
  override ignoreEvent(): boolean {
    return true;
  }
}

export function createChipEditor<Chip>(options: ChipEditorOptions<Chip>): ChipEditor<Chip> {
  const addChip = StateEffect.define<{ readonly pos: number; readonly chip: Chip }>({
    map: (value, changes) => ({ pos: changes.mapPos(value.pos), chip: value.chip }),
  });
  // Which chip a decoration stands for. Mapping a decoration set through changes keeps the
  // same Decoration objects, so this finds the payload without reading untyped decoration specs.
  const chipOfDecoration = new WeakMap<Decoration, Chip>();
  const decorationFor = (chip: Chip): Decoration => {
    const decoration = Decoration.replace({ widget: new ChipWidget(chip, options.describe(chip), options) });
    chipOfDecoration.set(decoration, chip);
    return decoration;
  };
  const chipField = StateField.define<DecorationSet>({
    create: () => Decoration.none,
    update(decorations, transaction) {
      // A decoration survives only while it still covers exactly one placeholder: a deleted
      // chip must not leave a pill over some other character.
      let next = decorations.map(transaction.changes).update({
        filter: (from, to) => to - from === 1 && transaction.newDoc.sliceString(from, to) === CHIP_CHARACTER,
      });
      for (const effect of transaction.effects) {
        // An undo that spans several edits (a chip inserted, then the space after it and the chip deleted within one
        // history group) carries a restore effect for a chip the whole group ends without: it must not decorate whatever
        // character now sits at that position, or a pill would stand over text and the draft would claim a chip it does not hold.
        if (effect.is(addChip) && transaction.newDoc.sliceString(effect.value.pos, effect.value.pos + 1) === CHIP_CHARACTER) {
          next = next.update({ add: [decorationFor(effect.value.chip).range(effect.value.pos, effect.value.pos + 1)] });
        }
      }
      return next;
    },
    provide: (field) => [EditorView.decorations.from(field), EditorView.atomicRanges.of((view) => view.state.field(field))],
  });

  const chipsOf = (state: EditorState): { readonly from: number; readonly chip: Chip }[] => {
    const found: { from: number; chip: Chip }[] = [];
    state.field(chipField).between(0, state.doc.length, (from, _to, decoration) => {
      if (chipOfDecoration.has(decoration)) {
        const chip = chipOfDecoration.get(decoration);
        assert(chip !== undefined, 'chip editor: a decoration without its chip');
        found.push({ from, chip });
      }
    });
    return found;
  };

  // Typing, pasting or dropping a placeholder would create a chip with no payload.
  const refuseStrayPlaceholders = EditorState.transactionFilter.of((transaction) => {
    if (!transaction.docChanged || transaction.annotation(chipInsertion) === true) {
      return transaction;
    }
    // Undo and redo restore chips through invertedEffects, so their placeholders are genuine.
    if (transaction.isUserEvent('undo') || transaction.isUserEvent('redo')) {
      return transaction;
    }
    let stray = false;
    transaction.changes.iterChanges((_replacedFrom, _replacedTo, _insertedFrom, _insertedTo, inserted) => {
      if (inserted.toString().includes(CHIP_CHARACTER)) {
        stray = true;
      }
    });
    return stray ? [] : transaction;
  });

  const restoreOnUndo = invertedEffects.of((transaction) => {
    const restored: StateEffect<{ readonly pos: number; readonly chip: Chip }>[] = [];
    for (const { from, chip } of chipsOf(transaction.startState)) {
      // TrackAfter maps to nothing exactly when the character after the position is deleted.
      if (transaction.changes.mapPos(from, 1, MapMode.TrackAfter) === null) {
        restored.push(addChip.of({ pos: from, chip }));
      }
    }
    return restored;
  });

  // Copying a selection that holds chips puts their labels on the clipboard, not placeholders.
  const copyLabels = EditorView.clipboardOutputFilter.of((text, state) => {
    if (!text.includes(CHIP_CHARACTER)) {
      return text;
    }
    const selected = chipsOf(state).filter(({ from }) => state.selection.ranges.some((range) => range.from <= from && from < range.to));
    const pieces = text.split(CHIP_CHARACTER);
    if (pieces.length - 1 !== selected.length) {
      return pieces.join('');
    }
    return pieces.map((piece, index) => piece + (selected[index] === undefined ? '' : options.describe(selected[index].chip).label)).join('');
  });

  const readSegments = (state: EditorState): readonly Segment<Chip>[] => {
    const chips = chipsOf(state).map((entry) => entry.chip);
    const text = state.doc.toString();
    assert(text.split(CHIP_CHARACTER).length - 1 === chips.length, 'chip editor: every placeholder has a chip');
    return documentToSegments({ text, chips });
  };

  const extension: Extension = [chipField, refuseStrayPlaceholders, restoreOnUndo, copyLabels];

  const createState = (segments: readonly Segment<Chip>[], extensions: readonly Extension[] = []): EditorState => {
    const draft = segmentsToDocument(segments);
    const base = EditorState.create({ doc: draft.text, extensions: [extension, ...extensions] });
    const effects: StateEffect<{ readonly pos: number; readonly chip: Chip }>[] = [];
    let chipIndex = 0;
    for (let position = 0; position < draft.text.length; position += 1) {
      if (draft.text.charAt(position) === CHIP_CHARACTER) {
        const chip = draft.chips[chipIndex];
        assert(chip !== undefined, 'chip editor: a chip for every placeholder');
        effects.push(addChip.of({ pos: position, chip }));
        chipIndex += 1;
      }
    }
    return base.update({ effects, annotations: chipInsertion.of(true) }).state;
  };

  return {
    extension,
    readSegments,
    createState,
    chipCount: (state) => chipsOf(state).length,
    insertChip: (state, chip, insertOptions = {}) => {
      if (chipsOf(state).length >= CHIP_COUNT_MAX) {
        return undefined;
      }
      const main = state.selection.main;
      const from = insertOptions.from ?? main.from;
      const to = insertOptions.to ?? main.to;
      assert(from <= to, 'insertChip: the range runs forward');
      assert(to <= state.doc.length, 'insertChip: the range is inside the document');
      const trailing = insertOptions.trailing ?? ' ';
      return {
        changes: { from, to, insert: CHIP_CHARACTER + trailing },
        effects: addChip.of({ pos: from, chip }),
        selection: { anchor: from + 1 + trailing.length },
        annotations: [chipInsertion.of(true)],
        userEvent: 'input',
        scrollIntoView: true,
      };
    },
    replaceSegments: (state, segments) => {
      const draft = segmentsToDocument(segments);
      const effects: StateEffect<{ readonly pos: number; readonly chip: Chip }>[] = [];
      let chipIndex = 0;
      for (let position = 0; position < draft.text.length; position += 1) {
        if (draft.text.charAt(position) === CHIP_CHARACTER) {
          const chip = draft.chips[chipIndex];
          assert(chip !== undefined, 'chip editor: a chip for every placeholder');
          effects.push(addChip.of({ pos: position, chip }));
          chipIndex += 1;
        }
      }
      return {
        changes: { from: 0, to: state.doc.length, insert: draft.text },
        effects,
        selection: { anchor: draft.text.length },
        annotations: [chipInsertion.of(true)],
      };
    },
  };
}
