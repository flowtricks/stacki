import type { CustomHosting } from '../../../shared/properties/publishConfig';

/** The custom host with an optional detail set, or left out when it is emptied. */
export function withDetail(custom: CustomHosting, key: 'hostName' | 'siteUrl', value: string): CustomHosting {
  const { [key]: previous, ...rest } = custom;
  void previous;
  return value === '' ? rest : { ...rest, [key]: value };
}
