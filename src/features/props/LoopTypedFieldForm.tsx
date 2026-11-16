// The form that names a field the list's items are not known to have: its
// name, and what it holds (loopTypedField.ts). Used inside the Field menu and
// where a filter or sort starts with no field to pick.

import { useState } from 'react';
import Dropdown from '../../ui/Dropdown';
import { LOOP_QUERY_LIMITS } from '../../editor/loopQuery';
import { useTranslate } from '../../lib/i18n/useTranslate';
import type { CatalogField } from './loopCatalog';
import { TYPED_KINDS, typedField, typedPathOf, type TypedKind } from './loopTypedField';
import { EditorRow } from './LoopRows';

/** Where a list's fields may be typed: the loop's item name, which a typed path may lead with. */
export interface TypedFieldSupport {
  readonly item: string | undefined;
}

export function TypedFieldForm(props: { readonly item: string | undefined; readonly onUse: (field: CatalogField) => void }) {
  const translate = useTranslate();
  const [text, setText] = useState('');
  const [kind, setKind] = useState<TypedKind>('text');
  const [invalid, setInvalid] = useState(false);
  const use = (): void => {
    const path = typedPathOf(text, props.item);
    if (path.ok) {
      setInvalid(false);
      props.onUse(typedField(path.path, kind));
    } else {
      setInvalid(true);
    }
  };
  const labels: Readonly<Record<TypedKind, string>> = {
    text: translate('props.loop.typed.text'),
    number: translate('props.loop.typed.number'),
    date: translate('props.loop.typed.date'),
    boolean: translate('props.loop.typed.boolean'),
  };
  return (
    <div className="loop-settings-editor loop-typed-field">
      <EditorRow label={translate('props.loop.typed.path')}>
        <input
          type="text"
          value={text}
          aria-label={translate('props.loop.typed.path')}
          aria-invalid={invalid}
          placeholder={translate('props.loop.typed.placeholder')}
          maxLength={LOOP_QUERY_LIMITS.fieldPathCharsMax}
          spellCheck={false}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              use();
            }
          }}
        />
      </EditorRow>
      <EditorRow label={translate('props.loop.typed.type')}>
        <Dropdown<TypedKind>
          livePreview={false}
          value={kind}
          ariaLabel={translate('props.loop.typed.type')}
          options={TYPED_KINDS.map((option) => ({ value: option, label: labels[option] }))}
          onChange={setKind}
        />
      </EditorRow>
      {invalid && <div className="loop-lineage-note">{translate('props.loop.typed.invalid')}</div>}
      <button type="button" className="loop-settings-link" onClick={use}>
        {translate('props.loop.typed.use')}
      </button>
    </div>
  );
}
