import { centralIcon } from '../../ui/central/CentralIcon';
import { droplet as centralDroplet, font as centralFont, number as centralNumber, scale as centralScale } from '../../ui/central/centralGeometry';
import type { IconProps } from '../../ui/IconBase';

const sizeType = { Icon: centralIcon(centralScale), label: 'Size' };
const TYPES: ReadonlyMap<string, typeof sizeType> = new Map([
  ['color', { Icon: centralIcon(centralDroplet), label: 'Colour' }],
  ['number', { Icon: centralIcon(centralNumber), label: 'Number' }],
  ['font', { Icon: centralIcon(centralFont), label: 'Text' }],
]);

export default function VariableTypeIcon({ kind = 'size', size, className }: Pick<IconProps, 'size' | 'className'> & { readonly kind?: string }) {
  const { Icon, label } = TYPES.get(kind) ?? sizeType;
  return <Icon size={size} className={className} title={label} />;
}
