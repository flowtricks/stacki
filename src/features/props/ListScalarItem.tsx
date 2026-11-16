// One row of a list of plain values, edited in place: `widths: number[]` shows
// number fields with the number icon, a list of words text fields, a list of
// yes/no switches, a list of choices a dropdown (listItemType.ts maps the kind
// to its control). The control is PropField's own, so the row binds to data as
// any field does (the purple dot at its left), and a bound item shows as the
// chip any bound field shows. The literal stays one array in the file
// (arrayValue.ts); this edits one item of it.

import { useState } from 'react';
import type { Attr } from '../../../shared/page/pageNode';
import type { ScalarItem } from './arrayValue';
import type { SourceContext } from './bindingTypes';
import { itemFieldOf, itemFieldValue } from './listItemShape';
import { itemRowDeclaration, itemRowField, type DeclaredItemType } from './listItemType';
import type { PropItemKind } from '../../../shared/properties/propSchema';
import PropField from './PropField';
import { PropPreviewContext } from './propPreviewContext';
import type { RichContext } from './RichContent';
import './listScalar.css';

export interface ListScalarItemProps {
  readonly item: ScalarItem;
  readonly index: number;
  /** What the row is: the list's kind, or the item's own when the list has no one kind. */
  readonly kind: PropItemKind;
  readonly declared: DeclaredItemType | undefined;
  /** The quote the list's words are written in. */
  readonly quote: string;
  readonly bindContext: RichContext | undefined;
  readonly dataContext: SourceContext | undefined;
  readonly onChange: (item: ScalarItem) => void;
}

// A number box that has been emptied, or holds a lone sign on its way to a
// number, is held as words until the next key: written as code it would be an
// invalid list, and left to PropField it would swap the box for the code field.
const NUMBER_UNDER_WAY = /^[-+]?\.?$/;
const NUMBER_TEXT = /^[-+]?(\d+\.?\d*|\.\d+)$/;

export default function ListScalarItem(props: ListScalarItemProps) {
  const { item, kind, declared, quote } = props;
  const [draft, setDraft] = useState<Attr | undefined>(undefined);
  // The key an item's field is written under in the shared reader (listItemShape.ts itemFieldOf), which wants a name.
  const name = 'value';
  const declaration = itemRowDeclaration(kind, name, declared);
  const field = { key: name, keyQuote: undefined, text: item.text, quote: item.quote };
  const write = (value: Attr | undefined): void => {
    if (value === undefined && kind === 'number') {
      // Empty is not a number: shown as such, and the list keeps the last valid one.
      setDraft({ type: 'string', value: '' });
      return;
    }
    const next = itemFieldOf(field, value, declaration, quote);
    if (next === undefined) {
      setDraft(heldNumber(value, kind));
      return;
    }
    setDraft(undefined);
    props.onChange({ text: next.text, quote: next.quote });
  };
  const shown = draft ?? itemFieldValue(field);
  const invalid = kind === 'number' && draft !== undefined && !NUMBER_TEXT.test(draft.type === 'bare' ? '' : draft.value.trim());
  return (
    <div className={`list-scalar-item${invalid ? ' is-invalid' : ''}`}>
      {/* No live canvas preview: this field is not a prop of the element, whatever its name. */}
      <PropPreviewContext.Provider value={undefined}>
        <PropField
          nodeKey={`item:${props.index}`}
          field={itemRowField(kind, name, declared)}
          value={shown}
          bindContext={props.bindContext}
          dataContext={props.dataContext}
          onChange={write}
        />
      </PropPreviewContext.Provider>
    </div>
  );
}

function heldNumber(value: Attr | undefined, kind: PropItemKind): Attr | undefined {
  if (value?.type === 'expr' && kind === 'number' && NUMBER_UNDER_WAY.test(value.value.trim())) {
    return { type: 'string', value: value.value };
  }
  return value;
}
