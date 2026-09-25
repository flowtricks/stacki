import type { ComponentProperty } from '../../shared/component-properties';
import { HelpCircleIcon } from '../ui/Icons';

// Declaration locations are metadata, not runtime value bindings.
export function PropertyDeclarationInfo({ property }: { readonly property: ComponentProperty }) {
  const origin = property.origin;
  const sources = origin?.declarations ?? [];
  const details = sources.map(
    (source) => `${source.label} (line ${source.line}): ${source.expression}`
  );
  if (origin?.defaultValue) {
    details.push(`Default (line ${origin.defaultValue.line}): ${origin.defaultValue.expression}`);
  }
  if (details.length === 0) {
    return null;
  }
  return (
    <button
      type="button"
      className="property-declaration-info"
      aria-label="Declaration details"
      title={details.join('\n')}
    >
      <HelpCircleIcon size={12} />
    </button>
  );
}

export function PropertyConditions({ property }: { readonly property: ComponentProperty }) {
  if (!property.conditions?.length) {
    return null;
  }
  return (
    <div className="property-conditions">
      <strong>Variant rules</strong>
      <ul>
        {property.conditions.map((condition, index) => (
          <li key={index}>{condition}</li>
        ))}
      </ul>
    </div>
  );
}
