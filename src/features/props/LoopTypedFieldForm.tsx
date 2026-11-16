// The form that names a field the list's items are not known to have: its
// name, and what it holds (loopTypedField.ts). Used inside the Field menu, as a
// quiet row that opens in place, and where a filter or sort starts with no
// field to pick. Its label column is as wide as its longest label, so no label
// is ever cut, and its controls shrink with the pop-up rather than run past it.

import { useState } from 'react';
import Dropdown from '../../ui/Dropdown';
import CodeTextField from './CodeTextField';
import { LOOP_QUERY_LIMITS } from '../../editor/loopQuery';
import { useTranslate } from '../../lib/i18n/useTranslate';
import type { CatalogField } from './loopCatalog';
import { TYPED_KINDS, typedField, typedPathOf, type TypedKind } from './loopTypedField';

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
    <div className="loop-typed-form">
      <span className="loop-typed-label">{translate('props.loop.typed.path')}</span>
      {/* The path is code (`card.title`), so it wears the code editor's colours; Enter, not leaving the field, uses it, since the type is still to be chosen. */}
      <div
        className="loop-typed-input"
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            use();
          }
        }}
      >
        <CodeTextField
          value={text}
          language="javascript"
          ariaLabel={translate('props.loop.typed.path')}
          placeholder={translate('props.loop.typed.placeholder')}
          onChange={(next) => setText(next.slice(0, LOOP_QUERY_LIMITS.fieldPathCharsMax))}
        />
      </div>
      <span className="loop-typed-label">{translate('props.loop.typed.type')}</span>
      <Dropdown<TypedKind>
        livePreview={false}
        value={kind}
        ariaLabel={translate('props.loop.typed.type')}
        options={TYPED_KINDS.map((option) => ({ value: option, label: labels[option] }))}
        onChange={setKind}
      />
      {invalid && <div className="loop-typed-note">{translate('props.loop.typed.invalid')}</div>}
      <div className="loop-typed-actions">
        <button type="button" className="primary" onClick={use}>
          {translate('props.loop.typed.use')}
        </button>
      </div>
    </div>
  );
}
