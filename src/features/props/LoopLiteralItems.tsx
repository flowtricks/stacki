// A custom list's items, typed in place: one row per item, as text. A row
// drags to a new place, the add button appends one, and the trash removes
// it. An edit is written when the row is left or Enter is pressed, not on
// every key, so typing a word is one undo step rather than one per letter.

import { useState } from 'react';
import useListReorder from '../../ui/useListReorder';
import { DragIcon, TrashIcon } from '../../ui/Icons';
import { assert } from '../../../shared/core/assert';
import { LOOP_LITERAL_LIMITS } from '../../editor/loopLiteral';
import { SectionHeader } from './LoopRows';
import { moved } from './LoopItems';

export function LiteralItemsSection(props: {
  readonly items: readonly string[];
  readonly onChange: (items: readonly string[]) => void;
}) {
  const { items } = props;
  const write = (next: readonly string[]): void => {
    assert(next.length <= LOOP_LITERAL_LIMITS.itemsMax, 'A typed list is bounded');
    props.onChange(next);
  };
  const reorder = useListReorder({
    count: items.length,
    onMove: (source, target) => write(moved(items, source, target)),
  });
  return (
    <div className="loop-settings-section">
      <SectionHeader
        title="Items"
        addable={items.length < LOOP_LITERAL_LIMITS.itemsMax}
        onAdd={() => write([...items, `Item ${items.length + 1}`])}
      />
      {items.length > 0 ? (
        <div className="loop-settings-list">
          {items.map((item, index) => (
            <div
              // Items may repeat, so a row is known by its place and its text.
              key={`${index}:${item}`}
              {...reorder.rowProps(index)}
              className={`loop-settings-item loop-settings-picked ${reorder.rowClass(index)}`}
            >
              <span className="loop-settings-item-drag" aria-hidden="true">
                <DragIcon size={12} />
              </span>
              <LiteralInput
                value={item}
                onCommit={(value) =>
                  write(items.map((entry, at) => (at === index ? value : entry)))
                }
              />
              <button
                type="button"
                className="loop-settings-item-remove"
                aria-label="Remove item"
                title="Remove"
                onClick={() => write(items.filter((_, at) => at !== index))}
              >
                <TrashIcon size={13} />
              </button>
            </div>
          ))}
        </div>
      ) : (
        <div className="loop-settings-empty">No items yet.</div>
      )}
    </div>
  );
}

// The draft is local until it is committed; Escape puts the saved text back.
function LiteralInput(props: {
  readonly value: string;
  readonly onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState(props.value);
  const commit = (): void => {
    if (draft === props.value) {
      return;
    }
    props.onCommit(draft);
  };
  return (
    <input
      className="loop-settings-literal-input"
      value={draft}
      maxLength={LOOP_LITERAL_LIMITS.itemCharsMax}
      spellCheck={false}
      aria-label="Item"
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.currentTarget.blur();
        } else if (event.key === 'Escape') {
          setDraft(props.value);
        }
      }}
    />
  );
}
