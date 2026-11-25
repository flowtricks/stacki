// The name of each kind of field a collection's settings know, as a key the
// caller translates where it is drawn. Shared by the field list, the new-field
// picker and the item editor of a list, so a kind is called one thing everywhere.
import type { SettingsFieldKind } from '../../../shared/properties/collectionSettings';
import type { MessageKey } from '../../lib/i18n/localeContext';

// The name of each kind of field, as a key translated where it is drawn.
export const KIND_LABELS: Readonly<Record<SettingsFieldKind, MessageKey>> = {
  text: 'cmsRemote.fieldType.plainText',
  richText: 'cmsRemote.fieldType.richText',
  image: 'cmsRemote.fieldType.image',
  multiImage: 'cmsRemote.fieldType.multiImage',
  videoLink: 'cmsRemote.fieldType.videoLink',
  link: 'cmsRemote.fieldType.link',
  email: 'cmsRemote.fieldType.email',
  phone: 'cmsRemote.fieldType.phone',
  number: 'cmsRemote.fieldType.number',
  date: 'cmsRemote.fieldType.dateTime',
  switch: 'cmsRemote.fieldType.switch',
  color: 'cmsRemote.fieldType.color',
  option: 'cmsRemote.fieldType.option',
  file: 'cmsRemote.fieldType.file',
  reference: 'cmsRemote.fieldType.reference',
  multiReference: 'cmsRemote.fieldType.multiReference',
  list: 'cmsRemote.fieldType.list',
  repeater: 'cmsRemote.fieldType.list',
  group: 'cmsRemote.fieldType.group',
  keyValue: 'cmsRemote.fieldType.keyValue',
  constant: 'cmsRemote.fieldType.constant',
  any: 'cmsRemote.fieldType.anyValue',
  other: 'cmsRemote.fieldType.custom',
};
