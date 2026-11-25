// The kinds of field a project's own CMS collection holds: what each is called,
// its icon, and a word on what it is for. Settings offers them when a field is
// made; a field shows its icon beside its name (CmsField.tsx). `label` and `hint`
// are message keys, translated where they are drawn.
import type { ComponentType } from 'react';
import {
  BracesIcon,
  CalendarIcon,
  CodeIcon,
  DropletIcon,
  FieldNumberIcon,
  MailIcon,
  ParagraphIcon,
  PhoneCallIcon,
  RepeatIcon,
  SwitchIcon,
  VariableTextSizeIcon,
} from '../../ui/Icons';
import type { MessageKey } from '../../../shared/properties/i18n/messageRef';
import type { FieldType } from './cmsSchema';
import { ElementImageIcon, ElementLinkIcon, ElementListDefaultIcon } from '../../ui/ElementIcons';

export const FIELD_TYPES: readonly {
  readonly value: FieldType;
  readonly label: MessageKey;
  readonly Icon: ComponentType<{ readonly size?: number }>;
  readonly hint: MessageKey;
}[] = [
  { value: 'text', label: 'cms.fieldType.text.label', Icon: VariableTextSizeIcon, hint: 'cms.fieldType.text.hint' },
  { value: 'longtext', label: 'cms.fieldType.longtext.label', Icon: ParagraphIcon, hint: 'cms.fieldType.longtext.hint' },
  { value: 'number', label: 'cms.fieldType.number.label', Icon: FieldNumberIcon, hint: 'cms.fieldType.number.hint' },
  { value: 'boolean', label: 'cms.fieldType.boolean.label', Icon: SwitchIcon, hint: 'cms.fieldType.boolean.hint' },
  { value: 'image', label: 'cms.fieldType.image.label', Icon: ElementImageIcon, hint: 'cms.fieldType.image.hint' },
  { value: 'date', label: 'cms.fieldType.date.label', Icon: CalendarIcon, hint: 'cms.fieldType.date.hint' },
  { value: 'link', label: 'cms.fieldType.link.label', Icon: ElementLinkIcon, hint: 'cms.fieldType.link.hint' },
  { value: 'email', label: 'cms.fieldType.email.label', Icon: MailIcon, hint: 'cms.fieldType.email.hint' },
  { value: 'phone', label: 'cms.fieldType.phone.label', Icon: PhoneCallIcon, hint: 'cms.fieldType.phone.hint' },
  { value: 'color', label: 'cms.fieldType.color.label', Icon: DropletIcon, hint: 'cms.fieldType.color.hint' },
  { value: 'list', label: 'cms.fieldType.list.label', Icon: ElementListDefaultIcon, hint: 'cms.fieldType.list.hint' },
  { value: 'object', label: 'cms.fieldType.object.label', Icon: BracesIcon, hint: 'cms.fieldType.object.hint' },
  { value: 'objects', label: 'cms.fieldType.objects.label', Icon: RepeatIcon, hint: 'cms.fieldType.objects.hint' },
  // Not offered when creating a field: a value is code because the file says
  // so, never because someone picked it from a list.
  { value: 'code', label: 'cms.fieldType.code.label', Icon: CodeIcon, hint: 'cms.fieldType.code.hint' },
];
