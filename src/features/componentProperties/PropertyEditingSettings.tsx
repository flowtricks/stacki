// How a field of the component is typed in, set where its name and tooltip are: the last rows of a prop's settings
// form, and, for the component's slots (which have no prop of their own), a row each at the end of the list that opens
// the same rows. Allow line breaks makes Enter type a `<br>`; Allow rich text editing makes the field rich text (Enter
// starts a paragraph, a `+` changes the block, the Content field opens the rich text editor). Each row shows only where
// the field can take it (componentDefaults.ts editingOffered), and each checkbox writes .stacki/components.json at once.
import { createContext, useContext, useState } from 'react';
import { useTranslate } from '../../lib/i18n/useTranslate';
import type { MessageKey } from '../../lib/i18n/localeContext';
import type { EditingField, EditingSetting, EditingSettings } from '../../../shared/properties/componentDefaults';
import { assert } from '../../../shared/core/assert';
import TipAnchor from '../../ui/TipAnchor';
import Popup from '../../ui/Popup';
import { CloseIcon, ElementSlotIcon } from '../../ui/Icons';

/** What the host knows about the open component's fields and writes for them. Absent: no editing rows (Studio for now). */
export interface FieldEditingHost {
  /** The component's slots, `default` for the content between its tags. */
  readonly slots: readonly string[];
  readonly offered: (field: EditingField) => readonly EditingSetting[];
  readonly settings: (field: EditingField) => EditingSettings;
  readonly change: (field: EditingField, setting: EditingSetting, state: 'on' | 'off') => void;
}

export const FieldEditingContext = createContext<FieldEditingHost | undefined>(undefined);

const LABELS: Readonly<Record<EditingSetting, MessageKey>> = {
  lineBreaks: 'props.editing.lineBreaks',
  richText: 'props.editing.richText',
};
const TIPS: Readonly<Record<EditingSetting, MessageKey>> = {
  lineBreaks: 'props.editing.lineBreaksTip',
  richText: 'props.editing.richTextTip',
};

/** The switches a field can take, last in its settings; nothing for a field that takes neither. */
export function PropertyEditingSettings({ field }: { readonly field: EditingField | undefined }) {
  const host = useContext(FieldEditingContext);
  const translate = useTranslate();
  if (host === undefined || field === undefined || field === '') {
    return undefined;
  }
  const offered = host.offered(field);
  const settings = host.settings(field);
  assert(offered.length <= 2, 'A field takes at most the two editing settings');
  // The same checkboxes as Required (PropertySections.tsx PropertyFlagsFields), each explained in a tooltip.
  return (
    <div className="property-flags property-editing-flags">
      {offered.map((setting) => (
        <TipAnchor key={setting} text={translate(TIPS[setting])}>
          <label>
            <input
              type="checkbox"
              aria-label={translate(LABELS[setting])}
              checked={settings[setting] === true}
              onChange={(event) => host.change(field, setting, event.target.checked ? 'on' : 'off')}
            />
            {translate(LABELS[setting])}
          </label>
        </TipAnchor>
      ))}
    </div>
  );
}

/** A row per slot at the end of the property list, opening that slot's editing settings in the settings form's place. */
export function SlotEditingRows({ disabled }: { readonly disabled: boolean }) {
  const host = useContext(FieldEditingContext);
  const translate = useTranslate();
  const [open, setOpen] = useState<string>();
  if (host === undefined) {
    return undefined;
  }
  const slots = host.slots.filter((slot) => host.offered(`slot:${slot}`).length > 0);
  const label = (slot: string) => (slot === 'default' ? translate('props.element.content') : slot);
  return (
    <>
      {slots.map((slot) => (
        // A slot is not a prop: it has no grip to reorder and nothing to delete here, only its settings to open.
        <div key={slot} className="list-field-row property-row property-slot-row">
          <button type="button" className="list-field-text property-row-main" disabled={disabled} aria-expanded={open === slot} onClick={() => setOpen(slot)}>
            <span className="list-field-icon" aria-hidden="true">
              <ElementSlotIcon size={12} />
            </span>
            {label(slot)}
          </button>
        </div>
      ))}
      {open !== undefined && (
        <Popup mode="popover" portal={false} className="property-editor" label={label(open)} onClose={() => setOpen(undefined)} dismissible={true}>
          {({ close }) => (
            <>
              <header>
                <div className="property-editor-title">
                  <strong>{label(open)}</strong>
                </div>
                <button aria-label={translate('componentProps.dialog.close')} onClick={close}>
                  <CloseIcon size={12} />
                </button>
              </header>
              <PropertyEditingSettings field={`slot:${open}`} />
            </>
          )}
        </Popup>
      )}
    </>
  );
}
