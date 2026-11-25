// The popover a component chip opens on click: the component's props as the Properties panel shows
// them for an instance (a labelled row with the panel's own control for the prop's type: a text field,
// the True/False switch, the custom dropdown, the number field), grouped as Props, Variants and Slots.
// Leaving a control alone calls nothing out; changing it adds or updates the member chip
// `prop:name=value` right after the component chip, and clearing it removes the chip. The dot at the
// start of a row is a checkbox: it says whether the prop is mentioned and toggles it (`prop:name` with no
// value). A slot is a checkbox row too. Keys: Up and Down move between the rows' checkboxes, Space toggles,
// Enter goes to the row's value field, Escape closes.
//
// The controls are the props panel's: this feature may not import that one (eslint.config.mjs, source
// layers), so the shell registers the panel's field through `registerMemberField` (src/app/shell/
// aiMemberField.tsx) and this file draws it through that adapter: a value in, a value out. Without one
// (a test of this file alone) a plain text field stands in.
//
// The popover only says what the person wants (`onWish`); the composer makes each wish one editor
// transaction, so undo takes back one change and the caret stays where it was. Tab moves between the
// controls; Escape closes and the composer puts focus back at its caret.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { assert } from '../../../../shared/core/assert';
import { useTranslate } from '../../../lib/i18n/useTranslate';
import Popup from '../../../ui/Popup';
import { placeMenu } from '../../../ui/menuModel';
import { CheckIcon, ElementSlotIcon } from '../../../ui/Icons';
import type { ComponentMemberChip } from '../../../../shared/properties/ai/mentions';
import type { MemberWish, MentionComponent, MentionComponentProp, PlacedMember } from './componentMentions';
import { memberTitle } from './mentionChips';
import './mentions.css';

const WIDTH_PX = 320;
/** A row's height for the first placement estimate, before the popover measures itself. */
const ROW_ESTIMATE_PX = 56;
const HEIGHT_ESTIMATE_MAX_PX = 420;
/** Past this many props the popover opens with a search field. */
export const MEMBER_SEARCH_PROPS_MIN = 12;

/** Draws one prop's control: the value the chip holds (undefined: not mentioned, the default shows dim) in, the new value out. */
export type MemberFieldRenderer = (props: {
  readonly prop: MentionComponentProp;
  readonly value: string | undefined;
  /**
   * `instance`: as on a placed instance, the default shows dim and choosing it counts as leaving the prop alone.
   * `explicit`: what is chosen is kept, the default included (one chip's own popover, where the chip already says the prop).
   */
  readonly policy: 'instance' | 'explicit';
  readonly onChange: (value: string | undefined) => void;
}) => ReactNode;

let memberField: MemberFieldRenderer | undefined;

/** Called once by the shell with the Properties panel's field; the popover draws every prop with it. */
export function registerMemberField(renderer: MemberFieldRenderer): void {
  memberField = renderer;
}

export interface ComponentMembersPopoverProps {
  readonly component: MentionComponent;
  /** The member chips now right after the component chip. */
  readonly selection: readonly PlacedMember[];
  /** The chip's box in viewport coordinates: the popover opens below it, or above when there is no room. */
  readonly anchorBox: { readonly left: number; readonly top: number; readonly width: number; readonly height: number };
  /** What the popover is stacked above (the composer). */
  readonly anchor: HTMLElement | undefined;
  readonly onWish: (wish: MemberWish) => void;
  readonly onClose: () => void;
}

export function ComponentMembersPopover(props: ComponentMembersPopoverProps) {
  const translate = useTranslate();
  const surface = useRef<HTMLDivElement | undefined>(undefined);
  const [query, setQuery] = useState('');
  const { component, selection } = props;
  const searchable = component.props.length > MEMBER_SEARCH_PROPS_MIN;
  const needle = query.trim().toLocaleLowerCase();
  const shown = component.props.filter((prop) => needle === '' || prop.name.toLocaleLowerCase().includes(needle));
  const slots = component.slots.filter((slot) => needle === '' || slot.toLocaleLowerCase().includes(needle));
  const groups = [
    { key: 'props', heading: translate('ai.mention.members.props'), props: shown.filter((prop) => !prop.variant) },
    { key: 'variants', heading: translate('ai.mention.members.variants'), props: shown.filter((prop) => prop.variant) },
  ];
  const rowCount = Math.max(1, component.props.length + component.slots.length);
  const estimate = placeMenu(
    props.anchorBox,
    { width: WIDTH_PX, height: Math.min(HEIGHT_ESTIMATE_MAX_PX, rowCount * ROW_ESTIMATE_PX + 12) },
    { width: window.innerWidth, height: window.innerHeight },
    'below-start',
  );
  // The first control takes focus once, so the keyboard can start right away.
  useEffect(() => {
    surface.current?.querySelector<HTMLElement>('input, button')?.focus();
  }, []);
  const empty = component.props.length === 0 && component.slots.length === 0;
  return (
    <Popup
      mode="popover"
      open
      onClose={props.onClose}
      anchor={props.anchor}
      keepOnScroll
      role="dialog"
      label={translate('ai.mention.members.label', { name: component.name })}
      className="component-members"
      style={{ position: 'fixed', left: estimate.left, top: estimate.top, width: WIDTH_PX }}
      onKeyDown={(event) => onRowKey(event, surface.current)}
      ref={(element) => {
        surface.current = element ?? undefined;
      }}
    >
      {empty && <div className="component-members-empty">{translate('ai.mention.members.none', { name: component.name })}</div>}
      {searchable && (
        <input
          type="search"
          className="component-members-search"
          aria-label={translate('ai.mention.members.search')}
          placeholder={translate('ai.mention.members.search')}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      )}
      {groups.map((group) =>
        group.props.length === 0 ? undefined : (
          <section key={group.key} className="component-members-group" aria-label={group.heading}>
            <div className="component-members-heading">
              {group.heading}
              <span className="component-members-count">{group.props.length}</span>
            </div>
            {group.props.map((prop) => (
              <PropRow key={prop.name} prop={prop} selection={selection} onWish={props.onWish} />
            ))}
          </section>
        ),
      )}
      {slots.length > 0 && (
        <section className="component-members-group" aria-label={translate('ai.mention.members.slots')}>
          <div className="component-members-heading">
            {translate('ai.mention.members.slots')}
            <span className="component-members-count">{slots.length}</span>
          </div>
          {slots.map((slot) => {
            const on = selection.some((entry) => entry.chip.role === 'slot' && entry.chip.name === slot);
            const label = translate('ai.mention.members.slotRow', { name: slot });
            return (
              <div key={slot} className={`component-members-slot${on ? ' is-on' : ''}`}>
                <CheckBox label={label} checked={on} onToggle={() => props.onWish({ role: 'slot', name: slot, value: undefined, on: !on })} />
                <ElementSlotIcon size={14} className="component-members-icon" />
                <span className="component-members-label">{label}</span>
              </div>
            );
          })}
        </section>
      )}
    </Popup>
  );
}

// One prop: the include dot, then the panel's control for its type.
function PropRow({
  prop,
  selection,
  onWish,
}: {
  readonly prop: MentionComponentProp;
  readonly selection: readonly PlacedMember[];
  readonly onWish: (wish: MemberWish) => void;
}) {
  const translate = useTranslate();
  const chip = selection.find((entry) => entry.chip.role === 'prop' && entry.chip.name === prop.name)?.chip;
  const on = chip !== undefined;
  const Field = memberField ?? PlainField;
  const include = translate('ai.mention.members.include', { name: prop.name });
  return (
    <div className={`component-members-prop${on ? ' is-on' : ''}`} data-member-prop={prop.name}>
      <CheckBox label={include} checked={on} onToggle={() => onWish({ role: 'prop', name: prop.name, value: chip?.value, on: !on })} />
      <div className="component-members-field">
        <Field
          prop={prop}
          value={chip?.value}
          policy="instance"
          // A value calls the prop out with it; a cleared control (or the default, which an instance omits) stops calling it out.
          onChange={(value) => onWish({ role: 'prop', name: prop.name, value, on: value !== undefined })}
        />
      </div>
    </div>
  );
}

/** The popover's checkbox: a square that fills blue with a check when on, never a ringed dot. One look for props and slots. */
function CheckBox(props: { readonly label: string; readonly checked: boolean; readonly onToggle: () => void }) {
  return (
    <button
      type="button"
      className="component-members-include"
      role="checkbox"
      aria-checked={props.checked}
      aria-label={props.label}
      title={props.label}
      onClick={props.onToggle}
    >
      <span className="component-members-box" aria-hidden="true">
        {props.checked && <CheckIcon size={12} />}
      </span>
    </button>
  );
}

/** Up and Down step between the checkboxes; Enter on one goes to its row's value field. Everything else is the control's own. */
function onRowKey(event: { readonly key: string; readonly target: EventTarget; preventDefault: () => void }, surface: HTMLElement | undefined): void {
  const target = event.target;
  if (surface === undefined || !(target instanceof HTMLElement) || !target.matches('.component-members-include')) {
    return;
  }
  const boxes = [...surface.querySelectorAll<HTMLElement>('.component-members-include')];
  const index = boxes.indexOf(target);
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    boxes[Math.max(0, Math.min(boxes.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))]?.focus();
  } else if (event.key === 'Enter') {
    const field = target.closest('.component-members-prop')?.querySelector<HTMLElement>('.component-members-field input, .component-members-field button');
    if (field !== null && field !== undefined) {
      event.preventDefault();
      field.focus();
    }
  }
}

// The stand-in when no panel field is registered: the prop's name and a text field, committed as it is typed.
function PlainField({ prop, value, onChange }: Parameters<MemberFieldRenderer>[0]) {
  const translate = useTranslate();
  assert(prop.name !== '', 'PlainField: a prop has a name');
  return (
    <label className="component-members-plain">
      <span className="component-members-label">{prop.name}</span>
      <input
        type="text"
        aria-label={translate('ai.mention.members.valueLabel', { name: prop.name })}
        placeholder={prop.field.default === undefined ? '' : String(prop.field.default)}
        value={value ?? ''}
        onChange={(event) => onChange(event.target.value === '' ? undefined : event.target.value)}
      />
    </label>
  );
}

export interface MemberValuePopoverProps {
  readonly chip: ComponentMemberChip;
  /** The scan's prop for a prop chip of a known component; undefined for an attribute, text, or a prop the scan does not list. */
  readonly prop: MentionComponentProp | undefined;
  readonly anchorBox: { readonly left: number; readonly top: number; readonly width: number; readonly height: number };
  readonly anchor: HTMLElement | undefined;
  /** The chip names this value from now on (undefined: the member with no value). */
  readonly onValue: (value: string | undefined) => void;
  readonly onRemove: () => void;
  readonly onClose: () => void;
}

/**
 * One member chip's popover: the Properties panel's input for that one prop (an attribute or text gets the
 * panel's text field), so the value can be changed where the chip is, and a button that removes the chip.
 */
export function MemberValuePopover(props: MemberValuePopoverProps) {
  const translate = useTranslate();
  const surface = useRef<HTMLDivElement | undefined>(undefined);
  const { chip } = props;
  const Field = memberField ?? PlainField;
  const prop = props.prop ?? plainProp(chip.name);
  const estimate = placeMenu(
    props.anchorBox,
    { width: WIDTH_PX, height: ROW_ESTIMATE_PX + 48 },
    { width: window.innerWidth, height: window.innerHeight },
    'below-start',
  );
  useEffect(() => {
    surface.current?.querySelector<HTMLElement>('input, button')?.focus();
  }, []);
  return (
    <Popup
      mode="popover"
      open
      onClose={props.onClose}
      anchor={props.anchor}
      keepOnScroll
      role="dialog"
      label={memberTitle(chip, translate)}
      className="component-members is-single"
      style={{ position: 'fixed', left: estimate.left, top: estimate.top, width: WIDTH_PX }}
      ref={(element) => {
        surface.current = element ?? undefined;
      }}
    >
      {chip.role === 'slot' ? (
        <div className="component-members-slot is-on">
          <span className="component-members-label">{translate('ai.mention.members.slotRow', { name: chip.name })}</span>
        </div>
      ) : (
        <div className="component-members-field" data-member-prop={chip.name}>
          <Field prop={prop} value={chip.value} policy="explicit" onChange={props.onValue} />
        </div>
      )}
      <button type="button" className="component-members-remove" onClick={props.onRemove}>
        {translate('ai.mention.members.remove')}
      </button>
    </Popup>
  );
}

/** A prop the scan does not describe (an attribute, the text, an undeclared prop): the panel's plain text field. */
function plainProp(name: string): MentionComponentProp {
  return { name, type: 'string', values: [], field: { name, type: 'string', optional: true }, variant: false };
}
