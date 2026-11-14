import { centralIcon } from '../../ui/central/CentralIcon';
import {
  droplet as centralDroplet,
  font as centralFont,
  number as centralNumber,
  pieChartOne as centralPieChartOne,
  ruler as centralRuler,
} from '../../ui/central/centralGeometry';
import type { IconProps } from '../../ui/IconBase';
import type { MessageKey } from '../../lib/i18n/localeContext';
import { useTranslate } from '../../lib/i18n/useTranslate';

interface TypeEntry {
  readonly Icon: ReturnType<typeof centralIcon>;
  readonly label: MessageKey;
}

const sizeType: TypeEntry = { Icon: centralIcon(centralRuler), label: 'variables.type.size' };
const TYPES: ReadonlyMap<string, TypeEntry> = new Map([
  ['color', { Icon: centralIcon(centralDroplet), label: 'variables.type.color' }],
  ['number', { Icon: centralIcon(centralNumber), label: 'variables.type.number' }],
  // Titled Size: a percentage is a size in CSS, and the panel has no separate type name for it.
  ['percentage', { Icon: centralIcon(centralPieChartOne), label: 'variables.type.size' }],
  ['font', { Icon: centralIcon(centralFont), label: 'variables.type.text' }],
]);

export default function VariableTypeIcon({ kind = 'size', size, className }: Pick<IconProps, 'size' | 'className'> & { readonly kind?: string }) {
  const translate = useTranslate();
  const { Icon, label } = TYPES.get(kind) ?? sizeType;
  return <Icon size={size} className={className} title={translate(label)} />;
}
