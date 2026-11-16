// The editor of one plain value of a list, in the popup a row opens:
// `widths: number[]` shows the number icon and the normal number input, a list
// of words the text input, of yes/no a switch, of choices a dropdown
// (listItemType.ts maps the kind to its control). The control is PropField's
// own, so the item binds to data as any field does (the purple dot, the `{}`
// toggle), and a bound item shows as the chip any bound field shows. The list
// stays one array literal in the file (arrayValue.ts); this edits one item of it.

import { useState } from 'react';
import type { Attr } from '../../../shared/page/pageNode';
import type { Item } from './arrayValue';
import type { SourceContext } from './bindingTypes';
import { itemFieldOf, itemFieldValue } from './listItemShape';
import { itemRowDeclaration, itemRowField, type DeclaredItemType } from './listItemType';
import type { PropItemKind } from '../../../shared/properties/propSchema';
import PropField from './PropField';
import { PropPreviewContext } from './propPreviewContext';
import type { RichContext } from './RichContent';
import './listScalar.css';

export interface ListScalarItemProps {
  readonly item: Item;
  /** What the item is: the list's kind, or the item's own when the list has no one kind. */
  readonly kind: PropItemKind;
  readonly declared: DeclaredItemType | undefined;
  /** The quote the list's words are written in. */
  readonly quote: string;
  readonly bindContext: RichContext | undefined;
  readonly dataContext: SourceContext | undefined;
  readonly onChange: (item: Item) => void;
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
  const field = { key: name, keyQuote: undefined, text: String(item.text ?? ''), quote: item.quote };
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
          nodeKey="item:value"
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
