// The kinds of field a project's own CMS collection holds: what each is called,
// its icon, and a word on what it is for. Settings offers them when a field is
// made; a field shows its icon beside its name (CmsField.tsx).
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
import { ElementImageIcon, ElementLinkIcon, ElementListDefaultIcon } from '../../ui/ElementIcons';

export const FIELD_TYPES = [
  { value: 'text', label: 'Text', Icon: VariableTextSizeIcon, hint: 'A short line' },
  { value: 'longtext', label: 'Long text', Icon: ParagraphIcon, hint: 'A paragraph' },
  { value: 'number', label: 'Number', Icon: FieldNumberIcon, hint: 'A figure' },
  { value: 'boolean', label: 'Toggle', Icon: SwitchIcon, hint: 'On or off' },
  { value: 'image', label: 'Image', Icon: ElementImageIcon, hint: 'From your assets' },
  { value: 'date', label: 'Date', Icon: CalendarIcon, hint: 'A calendar date' },
  { value: 'link', label: 'Link', Icon: ElementLinkIcon, hint: 'A web address' },
  { value: 'email', label: 'Email', Icon: MailIcon, hint: 'An address' },
  { value: 'phone', label: 'Phone', Icon: PhoneCallIcon, hint: 'A number to call' },
  { value: 'color', label: 'Color', Icon: DropletIcon, hint: 'A hex value' },
  { value: 'list', label: 'List of text', Icon: ElementListDefaultIcon, hint: 'Tags, bullets' },
  { value: 'object', label: 'Group', Icon: BracesIcon, hint: 'Fields kept together' },
  { value: 'objects', label: 'Repeating items', Icon: RepeatIcon, hint: 'A list of entries' },
  // Not offered when creating a field: a value is code because the file says
  // so, never because someone picked it from a list.
  { value: 'code', label: 'Code', Icon: CodeIcon, hint: 'A computed value' },
] as const;
