// One top-level field of a connected-CMS document, drawn as a component prop
// field (RemoteField.tsx). Edits are held here and saved as one draft write of
// the whole field once typing pauses, or at once when focus leaves the field,
// so a sentence is one write, not one per keystroke. While an edit is pending
// or the field has focus, a reload of the document does not replace what is
// being typed.
import { useEffect, useRef, useState } from 'react';
import { assert } from '../../../shared/core/assert';
import type { RemoteValue } from '../../../shared/properties/cmsRemoteSchema';
import type { RemoteDocumentField } from '../../../shared/properties/cmsRemote';
import { RemoteField } from './RemoteField';
import type { RemoteEditContext } from './RemoteValueEditor';

// How long typing may pause before the field is saved.
const SAVE_PAUSE_MS = 800;

export function RemoteFieldInput(props: {
  readonly field: RemoteDocumentField;
  readonly context: RemoteEditContext;
  readonly onSave: (value: RemoteValue | undefined) => void;
}) {
  const { field } = props;
  const save = useDraftSave(field.value, props.onSave);
  return (
    <div
      className="remote-cms-field-save"
      onFocus={save.focus}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          save.blur();
        }
      }}
    >
      <RemoteField
        field={field}
        value={save.draft}
        context={props.context}
        onChange={save.change}
      />
    </div>
  );
}

function useDraftSave(
  saved: RemoteValue | undefined,
  onSave: (value: RemoteValue | undefined) => void,
) {
  const [draft, setDraft] = useState(saved);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const pending = useRef<{ readonly value: RemoteValue | undefined } | undefined>(undefined);
  const focused = useRef(false);
  const latest = useRef(onSave);
  latest.current = onSave;
  const flush = () => {
    clearTimeout(timer.current);
    const next = pending.current;
    pending.current = undefined;
    if (next !== undefined) {
      latest.current(next.value);
    }
  };
  // A reloaded document shows here unless the person is mid-edit.
  useEffect(() => {
    if (pending.current === undefined && !focused.current) {
      setDraft(saved);
    }
  }, [saved]);
  // A field closed mid-edit still saves what was typed.
  useEffect(() => flush, []);
  const change = (value: RemoteValue | undefined) => {
    setDraft(value);
    pending.current = { value };
    clearTimeout(timer.current);
    timer.current = setTimeout(flush, SAVE_PAUSE_MS);
    assert(pending.current !== undefined, 'A change is pending until it is saved');
  };
  return {
    draft,
    change,
    focus: () => {
      focused.current = true;
    },
    blur: () => {
      focused.current = false;
      flush();
    },
  };
}
