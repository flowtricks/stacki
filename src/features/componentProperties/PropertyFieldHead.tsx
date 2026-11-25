// The title row of a prop setting that can be set by conditions (Visibility,
// Default value, Tooltip), as every prop field's label row is
// (src/features/props/PropFieldLabel.tsx):
//
// - Set by conditions, the title is the blue reset label (ResetLabel.tsx): a
//   click opens its menu, whose Reset clears the conditions, as a set prop's
//   label resets its value.
// - Not set, the field shows the purple + on its top-left corner while it is
//   hovered (BindHandle); a click opens the shared data picker, whose one row
//   here is Create conditional, opening the Value conditions editor. A setting
//   reads no data, so the picker is only that row.
// - Visibility and Tooltip have the `{}` beside the title (PropertyCodeToggle)
//   that shows the TypeScript the setting writes, highlighted and read-only
//   (PropertyCodeView): what Default value's `{}` shows for its default.

import { useRef, useState, type ReactNode } from 'react';
import { assert } from '../../../shared/core/assert';
import { useTranslate } from '../../lib/i18n/useTranslate';
import { CodeBlock } from '../../ui/CodeBlock';
import { BracesIcon } from '../../ui/Icons';
import { ResetLabel } from '../../ui/ResetLabel';
import { BindHandle, FieldDataPicker, dataPickerPosition } from '../props/propBindings';

type PickerPosition = ReturnType<typeof dataPickerPosition>;

export function PropertyFieldHead(props: {
  readonly title: string;
  /** Set: how to clear it, which makes the title the blue reset label. */
  readonly onReset: (() => void) | undefined;
  /** Set, but not cleared from here: the blue label's Reset is shown disabled with this reason. */
  readonly resetRefusal?: string | undefined;
  /** Opens the Value conditions editor. Absent, there is no + (nothing to set the setting by, or it is set already). */
  readonly onConditional: (() => void) | undefined;
  /** The buttons after the title: the `{}` code view. */
  readonly children?: ReactNode;
}) {
  const [pickerAt, setPickerAt] = useState<PickerPosition | undefined>(undefined);
  const headRef = useRef<HTMLDivElement>(null);
  const { onConditional, onReset } = props;
  assert(props.title !== '', 'PropertyFieldHead: the setting has a title');
  return (
    <div className="property-default-title property-field-head" ref={headRef}>
      <ResetLabel
        label={props.title}
        active={onReset !== undefined || props.resetRefusal !== undefined}
        resetDisabledReason={props.resetRefusal}
        onReset={() => onReset?.()}
      />
      {props.children}
      {onConditional !== undefined && (
        <BindHandle
          active={pickerAt !== undefined}
          onOpen={() => {
            if (pickerAt !== undefined) {
              setPickerAt(undefined);
              return;
            }
            // Under the whole field, as a prop field's picker opens under its field.
            const field = headRef.current?.parentElement ?? undefined;
            if (field !== undefined) {
              setPickerAt(dataPickerPosition(field.getBoundingClientRect()));
            }
          }}
        />
      )}
      {pickerAt !== undefined && onConditional !== undefined && (
        <FieldDataPicker
          pos={pickerAt}
          rows="lead"
          onPick={() => setPickerAt(undefined)}
          onConditional={() => {
            setPickerAt(undefined);
            onConditional();
          }}
          onClose={() => setPickerAt(undefined)}
        />
      )}
    </div>
  );
}

/** The `{}` beside a setting's title: on, the field shows the code the setting writes. */
export function PropertyCodeToggle(props: { readonly open: boolean; readonly onToggle: () => void }) {
  const translate = useTranslate();
  const label = translate('componentProps.settings.viewCode');
  return (
    <button
      type="button"
      className={`prop-expr-toggle${props.open ? ' on' : ''}`}
      title={props.open ? translate('componentProps.settings.useControls') : label}
      aria-label={label}
      aria-pressed={props.open}
      onClick={props.onToggle}
    >
      <BracesIcon size={12} />
    </button>
  );
}

/** The code a setting writes, highlighted and read-only, in a field's fill. */
export function PropertyCodeView({ code }: { readonly code: string }) {
  const translate = useTranslate();
  assert(code.trim() !== '', 'PropertyCodeView: a setting always writes some code');
  return (
    <div className="property-readonly-code">
      <CodeBlock text={code} language="typescript" label={translate('componentProps.settings.viewCode')} />
    </div>
  );
}
