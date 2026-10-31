// What each kind of connected-CMS field is called and the icon beside its name,
// so a field's type reads at a glance before its value does.
import type { ReactElement } from 'react';
import type { RemoteType } from '../../../shared/properties/cmsRemoteSchema';
import type { IconProps } from '../../ui/IconBase';
import {
  BracesIcon,
  CalendarIcon,
  CollectionIcon,
  FieldNumberIcon,
  FieldSwitchIcon,
  MailIcon,
  MapPinIcon,
  PaperclipIcon,
  ParagraphIcon,
  TagIcon,
  TextIcon,
} from '../../ui/Icons';
import {
  ElementImageIcon,
  ElementLinkIcon,
  ElementListDefaultIcon,
  ElementSelectIcon,
} from '../../ui/ElementIcons';

type Icon = (props: IconProps) => ReactElement;

/** The icon and name for a field of this type. */
export function fieldTypeOf(type: RemoteType): { readonly icon: Icon; readonly label: string } {
  switch (type.kind) {
    case 'string':
      return type.options.length > 0
        ? { icon: ElementSelectIcon, label: 'Option' }
        : { icon: TextIcon, label: 'Plain text' };
    case 'text':
      return { icon: TextIcon, label: 'Long text' };
    case 'url':
      return { icon: ElementLinkIcon, label: 'Link' };
    case 'email':
      return { icon: MailIcon, label: 'Email' };
    case 'number':
      return { icon: FieldNumberIcon, label: 'Number' };
    case 'boolean':
      return { icon: FieldSwitchIcon, label: 'Switch' };
    case 'date':
      return { icon: CalendarIcon, label: 'Date' };
    case 'datetime':
      return { icon: CalendarIcon, label: 'Date/Time' };
    case 'slug':
      return { icon: TagIcon, label: 'Slug' };
    case 'geopoint':
      return { icon: MapPinIcon, label: 'Location' };
    case 'object':
      return { icon: BracesIcon, label: 'Group' };
    case 'image':
      return { icon: ElementImageIcon, label: 'Image' };
    case 'file':
      return { icon: PaperclipIcon, label: 'File' };
    case 'reference':
      return { icon: CollectionIcon, label: 'Reference' };
    case 'richText':
      return { icon: ParagraphIcon, label: 'Rich text' };
    case 'array':
      return listTypeOf(type.of);
    default: {
      const exhaustive: never = type;
      return exhaustive;
    }
  }
}

// A list of one kind is named for it, as a CMS names a multi-image or a
// multi-reference field; a mixed list is a list.
function listTypeOf(of: readonly RemoteType[]): { readonly icon: Icon; readonly label: string } {
  const kinds = new Set(of.map((member) => member.kind));
  const only = kinds.size === 1 ? of[0]?.kind : undefined;
  if (only === 'image') {
    return { icon: ElementImageIcon, label: 'Multi-image' };
  }
  if (only === 'reference') {
    return { icon: CollectionIcon, label: 'Multi-reference' };
  }
  return { icon: ElementListDefaultIcon, label: 'List' };
}
