// A `class:list` value drawn as the classes it gives: a compact list (each
// class, and when it is given) that opens the Class list editor, where each
// row is a class (words, a prop, or words with props in them) given always or
// "only when" its conditions hold, built with the conditional editor's own
// condition rows. Rows are added, removed and dragged into order; the editor
// writes the array once, as it closes, as one undo step. A list in any other
// shape (an object, a spread, a nested array, a call) stays code.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { assert } from '../../../shared/core/assert';
import type { Attr } from '../../../shared/page/pageNode';
import { CLASS_LIST_LIMITS, type ClassListValue, type GroupMatch } from '../../editor/conditionalValue';
import Dropdown from '../../ui/Dropdown';
import useListReorder from '../../ui/useListReorder';
import { DropLine } from '../../ui/DropLine';
import { BranchIcon, CloseIcon, DragIcon, PlusIcon, TrashIcon } from '../../ui/Icons';
import { ConditionRow, ResultField, ResultWords, useConditionCatalog } from './ConditionalValue';
import {
  appliedClassList,
  classDraftOf,
  whenWords,
  withClassEntry,
  withClassEntryAdded,
  withClassEntryMoved,
  withClassEntryRemoved,
  withCondition,
  withWhenAdded,
  writeOptionsFor,
  type ClassListDraft,
  type ConditionProp,
} from './conditionalModel';
import { RowPopup } from './LoopRows';
import type { RichContext } from './RichContent';
import './conditionalValue.css';

const EDITOR_HEIGHT_PX_MAX = 640;
// Wide enough for a property, an operator and its values on one line; it slides left over the canvas to fit.
const EDITOR_WIDTH_PX_MIN = 520;

const MATCH_OPTIONS: readonly { readonly value: GroupMatch; readonly label: string }[] = [
  { value: 'all', label: 'all' },
  { value: 'any', label: 'any' },
];

export interface ClassListFieldProps {
  readonly model: ClassListValue;
  readonly value: Attr | undefined;
  readonly bindContext: RichContext | undefined;
  /** Writes the list, undefined leaving the attribute out: one undo step. */
  readonly onApply: (value: Attr | undefined) => void;
}

/** A class list, collapsed: its chip and one line per class, either opening the editor. */
export function ClassListField(props: ClassListFieldProps) {
  const catalog = useConditionCatalog(props.bindContext);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div className="conditional-field" ref={ref}>
      <button type="button" className="conditional-chip" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(!open)}>
        <BranchIcon size={11} />
        Class list
      </button>
      <button type="button" className="conditional-summary class-list-summary" title="Edit the classes" onClick={() => setOpen(true)}>
        <span className="conditional-lines">
          {props.model.entries.map((entry, index) => (
            <span key={index} className="conditional-line class-list-line">
              <ResultWords result={entry.value} language="text" />
              {entry.when.length > 0 && <span className="conditional-bullet-when">{whenWords(entry.when, entry.match, catalog)}</span>}
            </span>
          ))}
        </span>
      </button>
      {open && (
        <ClassListEditor
          anchorRef={ref}
          model={props.model}
          value={props.value}
          bindContext={props.bindContext}
          onApply={props.onApply}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}

export interface ClassListEditorProps {
  readonly anchorRef: RefObject<HTMLElement>;
  readonly model: ClassListValue;
  readonly value: Attr | undefined;
  readonly bindContext: RichContext | undefined;
  readonly onApply: (value: Attr | undefined) => void;
  readonly onClose: () => void;
}

/** The Class list pop-up, writing its draft once as it closes (as the Value conditions editor does). */
export function ClassListEditor(props: ClassListEditorProps) {
  const catalog = useConditionCatalog(props.bindContext);
  const [draft, setDraft] = useState<ClassListDraft>(() => classDraftOf(props.model));
  const written = useRef(false);
  const frontmatter = props.bindContext?.frontmatter ?? '';
  const latest = useRef({ draft, value: props.value, onApply: props.onApply, frontmatter });
  latest.current = { draft, value: props.value, onApply: props.onApply, frontmatter };
  const apply = (from: ClassListDraft): void => {
    if (written.current) {
      return;
    }
    written.current = true;
    const next = appliedClassList(from, latest.current.value, writeOptionsFor(latest.current.value, latest.current.frontmatter));
    if (next.kind === 'write') {
      latest.current.onApply(next.value);
    }
  };
  const applyRef = useRef(apply);
  applyRef.current = apply;
  useEffect(() => () => applyRef.current(latest.current.draft), []);
  const [anchor, setAnchor] = useState<HTMLElement | undefined>(undefined);
  const { anchorRef } = props;
  useLayoutEffect(() => setAnchor(anchorRef.current ?? undefined), [anchorRef]);
  const close = (): void => {
    apply(draft);
    props.onClose();
  };
  return (
    <RowPopup anchor={anchor} heightPxMax={EDITOR_HEIGHT_PX_MAX} widthPxMin={EDITOR_WIDTH_PX_MIN} label="Class list" onClose={close}>
      <div className="conditional-editor class-list-editor">
        <div className="loop-property-head">
          <span className="loop-bind-title">Class list</span>
          <button type="button" className="loop-settings-remove" aria-label="Close class list" title="Close" onClick={close}>
            <CloseIcon size={12} />
          </button>
        </div>
        <EntryList draft={draft} catalog={catalog} bindContext={props.bindContext} setDraft={setDraft} />
        <button
          type="button"
          className="conditional-add"
          disabled={draft.entries.length >= CLASS_LIST_LIMITS.entriesMax}
          onClick={() => setDraft((current) => withClassEntryAdded(current))}
        >
          <PlusIcon size={11} />
          Add class
        </button>
      </div>
    </RowPopup>
  );
}

// The classes in the order they are written, dragged by the grip each shows
// on hover or moved with Alt+↑ and Alt+↓ on a focused row (as the condition
// groups are, ConditionalValue.tsx).
function EntryList(props: {
  readonly draft: ClassListDraft;
  readonly catalog: readonly ConditionProp[];
  readonly bindContext: RichContext | undefined;
  readonly setDraft: (change: (draft: ClassListDraft) => ClassListDraft) => void;
}) {
  const { draft, setDraft, catalog } = props;
  const count = draft.entries.length;
  const move = (source: number, target: number): void => {
    if (target !== source && target !== source + 1) {
      setDraft((current) => withClassEntryMoved(current, source, target));
    }
  };
  const reorder = useListReorder({ count, onMove: move });
  const gap = reorder.dragIndex === undefined ? undefined : reorder.dropIndex;
  assert(gap === undefined || gap <= count, 'EntryList: the drop gap is within the list');
  return draft.entries.map((entry, index) => {
    const row = reorder.rowProps(index);
    const change = (next: (entry: ClassListDraft['entries'][number]) => ClassListDraft['entries'][number]): void =>
      setDraft((current) => withClassEntry(current, index, next));
    return (
      <div
        key={index}
        {...row}
        // Only the grip starts a drag: a press in a field is a caret, not a move.
        onPointerDown={(event) => {
          if (event.target instanceof Element && event.target.closest('.conditional-grip') !== null) {
            row.onPointerDown?.(event);
          }
        }}
        onKeyDown={(event) => {
          if (!event.altKey || event.target !== event.currentTarget) {
            return;
          }
          if (event.key === 'ArrowUp' && index > 0) {
            event.preventDefault();
            move(index, index - 1);
          } else if (event.key === 'ArrowDown' && index < count - 1) {
            event.preventDefault();
            move(index, index + 2);
          }
        }}
        className={`conditional-group class-list-entry${reorder.dragIndex === index ? ' is-dragging' : ''}`}
        role="group"
        tabIndex={0}
        aria-label={`Class ${index + 1}`}
      >
        {(gap === index || (gap === count && index === count - 1)) && (
          <span className={`conditional-gap is-${gap === index ? 'before' : 'after'}`}>
            <DropLine />
          </span>
        )}
        <div className="class-list-entry-head">
          <button type="button" className="conditional-grip" aria-label={`Drag to reorder class ${index + 1}`} data-drag-through tabIndex={-1}>
            <DragIcon size={12} />
          </button>
          <ResultField
            label="Class"
            placeholder="Class name"
            result={entry.value}
            bindContext={props.bindContext}
            language="text"
            onChange={(value) => change((current) => ({ ...current, value }))}
          />
          <button
            type="button"
            className="loop-settings-remove"
            aria-label="Remove class"
            title="Remove class"
            onClick={() => setDraft((current) => withClassEntryRemoved(current, index))}
          >
            <TrashIcon size={12} />
          </button>
        </div>
        {entry.when.length > 0 && (
          <div className="conditional-group-head">
            Only when
            <Dropdown
              ariaLabel="Match"
              className="conditional-match"
              value={entry.match}
              options={MATCH_OPTIONS}
              onChange={(match) => change((current) => ({ ...current, match }))}
            />
            <span className="conditional-phrase">conditions are true</span>
            {/* Takes the condition away, not the class: it is given always again. */}
            <button
              type="button"
              className="loop-settings-remove"
              aria-label="Remove condition"
              title="Remove condition"
              onClick={() => change((current) => ({ ...current, match: 'all', when: [] }))}
            >
              <TrashIcon size={12} />
            </button>
          </div>
        )}
        {entry.when.map((condition, conditionIndex) => (
          <ConditionRow
            key={conditionIndex}
            condition={condition}
            catalog={catalog}
            onChange={(next) =>
              change((current) => ({
                ...current,
                when: withCondition({ match: current.match, conditions: current.when, value: current.value }, conditionIndex, next).conditions,
              }))
            }
            onRemove={() => change((current) => ({ ...current, when: current.when.filter((_, at) => at !== conditionIndex) }))}
          />
        ))}
        <button
          type="button"
          className="conditional-add"
          disabled={entry.when.length >= CLASS_LIST_LIMITS.conditionsPerEntryMax}
          onClick={() => change((current) => withWhenAdded(current, catalog))}
        >
          <PlusIcon size={11} />
          {entry.when.length === 0 ? 'Only when' : 'New condition'}
        </button>
      </div>
    );
  });
}
