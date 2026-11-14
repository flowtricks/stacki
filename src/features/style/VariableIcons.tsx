import { centralIcon } from '../../ui/central/CentralIcon';
import {
  add as centralAdd,
  check as centralCheck,
  chevronRight as centralChevronRight,
  droplet as centralDroplet,
  font as centralFont,
  number as centralNumber,
  pieChartOne as centralPieChartOne,
  ruler as centralRuler,
} from '../../ui/central/centralGeometry';
// The glyphs the variable picker draws: a check, a plus, a chevron, and an
// icon per variable type (VariableConnect.tsx).

export const CheckIcon = centralIcon(centralCheck);

// The "connect to variable" affordance (Webflow's): a dot in the input's top-left
// corner, revealed on hover of the input. Hovering the dot grows it into a purple
// "+"; clicking opens a searchable, grouped variable picker. Picking one calls
// onPick with the `var(--…)` binding to write.

export const PlusIcon = centralIcon(centralAdd);

// Per-type variable glyphs (Webflow's), keyed by the variable's `type`; any other type
// (Size included) uses the Size glyph.
export const ColorTypeIcon = centralIcon(centralDroplet);
export const NumberTypeIcon = centralIcon(centralNumber);
export const PercentageTypeIcon = centralIcon(centralPieChartOne);
export const FontFamilyTypeIcon = centralIcon(centralFont);
export const SizeTypeIcon = centralIcon(centralRuler);
export function VariableTypeIcon({ type }: { type: string }) {
  switch (type) {
    case 'Color':
      return <ColorTypeIcon />;
    case 'Number':
      return <NumberTypeIcon />;
    case 'Percentage':
      return <PercentageTypeIcon />;
    case 'FontFamily':
      return <FontFamilyTypeIcon />;
    default:
      return <SizeTypeIcon />;
  }
}
export const ChevronRightIcon = centralIcon(centralChevronRight);
