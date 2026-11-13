// The Text panel's Content field (PropsPanel.tsx): a text node's words, with the
// purple dot every bindable field has. Picking data — a component prop, a CMS
// field — puts it into the text as `{path}`: the whole text when the dot is
// pressed from outside the field, at the caret (or over the selection) when it
// is pressed while typing. The nodes beside the text are never touched.
//
// The same panel shows the text once it is connected: the expression `{label}`
// is drawn as its chip, the label reads as set, and the label's menu
// disconnects it, which writes the words back — the prop's default when it is
// a plain string, the text it held before it was connected.

import { useTranslate } from '../../lib/i18n/useTranslate';
import React, { useState } from 'react';
import AutoTextarea from '../../ui/AutoTextarea';
import { ResetMenu } from '../../ui/ResetLabel';
import { VariableTextSizeIcon } from '../../ui/Icons';
import { assert } from '../../../shared/core/assert';
import { dataPickerPosition } from './dataPickerPosition';
import { BindHandle, FieldDataPicker, type FieldPickerAt, type FieldPosition } from './propBindings';
import type { RichContext } from './RichContent';
import { FIELD_UNFOCUSED } from './fieldFocus';
import { propNamed } from '../../editor/loopProps';
import { connectedPath, connectedPieces, disconnectedText, type TextPiece } from './textConnect';

export interface TextConnectFieldProps {
  /** The selected node: words, or an expression the panel shows as a connection. */
  readonly node: { readonly kind: 'text' | 'expr'; readonly id: string; readonly value: string };
  readonly bindContext: RichContext | undefined;
  readonly onSetText: (value: string) => void;
  /** Restates the node as these pieces; absent where the host cannot, which hides the dot. */
  readonly onSetTextPieces: ((pieces: readonly TextPiece[]) => void) | undefined;
}

/** Whether an expression node is drawn by this field as a connected text:
 * `{label}` in a component, where `label` is one of its props. Anything else —
 * a CMS field on a page, a call, a ternary — stays code in the Expression panel. */
export function isTextConnection(expression: string, context: RichContext | undefined): boolean {
  const path = connectedPath(expression);
  if (path === undefined || context?.newProp === undefined) {
    return false;
  }
  return propNamed(context.frontmatter ?? '', path) !== undefined;
}

export default function TextConnectField(props: TextConnectFieldProps) {
  const translate = useTranslate();
  const { node, bindContext, onSetText, onSetTextPieces } = props;
  const [picker, setPicker] = useState<FieldPickerAt | undefined>(undefined);
  const [menu, setMenu] = useState<FieldPosition | undefined>(undefined);
  const path = node.kind === 'expr' ? connectedPath(node.value) : undefined;
  assert(node.kind === 'text' || path !== undefined, 'TextConnectField: an expression it shows is a connection');
  const words = node.kind === 'text' ? node.value : '';
  const disconnect = () => {
    setMenu(undefined);
    if (path !== undefined && onSetTextPieces !== undefined) {
      onSetTextPieces([{ kind: 'text', value: disconnectedText(path, bindContext?.frontmatter ?? '') }]);
    }
  };
  const place = (picked: string) => {
    const focus = picker?.focus ?? FIELD_UNFOCUSED;
    setPicker(undefined);
    onSetTextPieces?.(connectedPieces(words, node.kind === 'text' ? focus : FIELD_UNFOCUSED, picked));
  };
  return (
    <div className="props-field" style={{ marginTop: 8 }}>
      <label onClick={(event) => event.preventDefault()}>
        <span
          className={`prop-label${path === undefined ? '' : ' set'}`}
          title={path === undefined ? undefined : translate('props.textConnect.disconnectHint')}
          onClick={(event) => {
            event.preventDefault();
            if (path === undefined) {
              return;
            }
            if (event.altKey) {
              disconnect();
              return;
            }
            const bounds = event.currentTarget.getBoundingClientRect();
            setMenu({ left: bounds.left, top: bounds.bottom + 4 });
          }}
        >
          <VariableTextSizeIcon size={12} className="prop-label-icon" />
          {translate('props.element.content')}
        </span>
        {onSetTextPieces !== undefined && (
          <BindHandle
            active={picker !== undefined}
            onOpen={(host, focus) => {
              if (picker !== undefined) {
                setPicker(undefined);
                return;
              }
              const bounds = host?.getBoundingClientRect();
              if (bounds !== undefined) {
                setPicker({ ...dataPickerPosition(bounds), focus });
              }
            }}
          />
        )}
      </label>
      {path === undefined ? (
        <AutoTextarea key={node.id} minRows={3} value={words} onChange={(event) => onSetText(event.target.value)} />
      ) : (
        <div className="bind-input text-connection" role="textbox" aria-readonly="true" aria-label={translate('props.element.content')}>
          <span className="expr-chip" data-expr={path}>
            {path}
          </span>
        </div>
      )}
      {picker && (
        <FieldDataPicker
          pos={picker}
          bindContext={bindContext}
          current={path}
          // A prop made for the text is read where a picked one would be: its words are the prop's default.
          // i18n-ignore: the label seeds a prop name (text), written as code.
          seed={{ fit: 'content', label: 'Text', value: words.trim() }}
          onBindNew={place}
          onPick={place}
          onClose={() => setPicker(undefined)}
        />
      )}
      {menu && (
        <ResetMenu
          position={menu}
          resetLabel={translate('props.attributesBinding.disconnect')}
          onReset={disconnect}
          unbindLabel=""
          onClose={() => setMenu(undefined)}
        />
      )}
    </div>
  );
}
