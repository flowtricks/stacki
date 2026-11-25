// How a field of the component is typed in, set where its name and tooltip are: the last rows of a prop's settings
// form, and, for the component's slots (which have no prop of their own), a row each at the top of the list that opens
// the same rows, first in the list. Allow line breaks makes Enter type a `<br>`; Allow rich text editing makes the field rich text (Enter
// starts a paragraph, a `+` changes the block, the Content field opens the rich text editor). Each row shows only where
// the field can take it (componentDefaults.ts editingOffered), and each checkbox writes .stacki/components.json at once.
import { createContext, useContext } from 'react';
import { useTranslate } from '../../lib/i18n/useTranslate';
import type { MessageKey } from '../../lib/i18n/localeContext';
import type { EditingField, EditingSetting, EditingSettings } from '../../../shared/properties/componentDefaults';
import { assert } from '../../../shared/core/assert';
import TipAnchor from '../../ui/TipAnchor';
import Popup from '../../ui/Popup';
import { CloseIcon, DragIcon, ElementSlotIcon } from '../../ui/Icons';

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

/**
 * A row per slot, first in the property list (the content between the tags is what a component is mostly for), drawn
 * as the prop rows are: the same columns, with the grip's place kept empty since a slot is not reordered or deleted.
 */
export function SlotEditingRows({ disabled, onOpen }: { readonly disabled: boolean; readonly onOpen: (slot: string) => void }) {
  const host = useContext(FieldEditingContext);
  const translate = useTranslate();
  if (host === undefined) {
    return undefined;
  }
  const slots = host.slots.filter((slot) => host.offered(`slot:${slot}`).length > 0);
  return (
    <>
      {slots.map((slot) => (
        <div key={slot} className="list-field-row property-row property-slot-row">
          <span className="list-field-grip property-grip-space" aria-hidden="true">
            <DragIcon size={12} />
          </span>
          <button type="button" className="list-field-text property-row-main" disabled={disabled} onClick={() => onOpen(slot)}>
            <span className="list-field-icon" aria-hidden="true">
              <ElementSlotIcon size={14} />
            </span>
            {slotLabel(slot, translate)}
          </button>
        </div>
      ))}
    </>
  );
}

function slotLabel(slot: string, translate: ReturnType<typeof useTranslate>): string {
  return slot === 'default' ? translate('props.element.content') : slot;
}

/** A slot's settings, opened in the list's place as a prop's settings form is. */
export function SlotEditingEditor({ slot, onClose }: { readonly slot: string; readonly onClose: () => void }) {
  const translate = useTranslate();
  const label = slotLabel(slot, translate);
  return (
    <Popup mode="popover" portal={false} className="property-editor" label={label} onClose={onClose} dismissible={true}>
      {({ close }) => (
        <>
          <header>
            <div className="property-editor-title">
              <strong>{label}</strong>
            </div>
            <button aria-label={translate('componentProps.dialog.close')} onClick={close}>
              <CloseIcon size={12} />
            </button>
          </header>
          <PropertyEditingSettings field={`slot:${slot}`} />
        </>
      )}
    </Popup>
  );
}
