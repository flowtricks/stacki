// The icon of each kind of field a collection's settings know, from the central icon set. One table serves the
// field list, the new-field picker, and every dropdown that chooses a kind (a list's items, a group's fields), so a
// kind looks the same wherever it is chosen or shown.
import type { ReactElement } from 'react';
import type { SettingsFieldKind } from '../../../shared/properties/collectionSettings';
import type { Translator } from '../../lib/i18n/localeContext';
import type { DropdownOption } from '../../ui/Dropdown';
import { ElementImageIcon, ElementLinkIcon, ElementListDefaultIcon, ElementSelectIcon, ElementVideoIcon } from '../../ui/ElementIcons';
import type { IconProps } from '../../ui/IconBase';
import {
  BracesIcon,
  CalendarIcon,
  CollectionIcon,
  DropletIcon,
  FieldNumberIcon,
  FieldSwitchIcon,
  MailIcon,
  ParagraphIcon,
  PaperclipIcon,
  PhoneIcon,
  TagIcon,
  TextIcon,
} from '../../ui/Icons';
import { KIND_LABELS } from './settingsKindLabels';

export const KIND_ICONS: Readonly<Record<SettingsFieldKind, (props: IconProps) => ReactElement>> = {
  text: TextIcon,
  richText: ParagraphIcon,
  image: ElementImageIcon,
  multiImage: ElementImageIcon,
  videoLink: ElementVideoIcon,
  link: ElementLinkIcon,
  email: MailIcon,
  phone: PhoneIcon,
  number: FieldNumberIcon,
  date: CalendarIcon,
  switch: FieldSwitchIcon,
  color: DropletIcon,
  option: ElementSelectIcon,
  file: PaperclipIcon,
  reference: CollectionIcon,
  multiReference: CollectionIcon,
  list: ElementListDefaultIcon,
  repeater: ElementListDefaultIcon,
  group: BracesIcon,
  keyValue: ElementListDefaultIcon,
  constant: TagIcon,
  any: BracesIcon,
  other: BracesIcon,
};

export function KindIcon(props: { readonly kind: SettingsFieldKind }) {
  const Icon = KIND_ICONS[props.kind];
  return (
    <span className="remote-cms-settings-icon">
      <Icon size={12} />
    </span>
  );
}

/** A dropdown's rows for `kinds`: the kind's icon at the start of each row, its name after it (the check sits at the end). */
export function kindOptions(kinds: readonly SettingsFieldKind[], translate: Translator): readonly DropdownOption<SettingsFieldKind>[] {
  return kinds.map((kind) => {
    const Icon = KIND_ICONS[kind];
    return { value: kind, label: translate(KIND_LABELS[kind]), icon: <Icon size={14} /> };
  });
}
