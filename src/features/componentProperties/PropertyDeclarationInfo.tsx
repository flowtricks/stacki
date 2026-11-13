import type { ComponentProperty } from '../../../shared/properties/propertyEditing';
import { useTranslate, useTranslateDescribed } from '../../lib/i18n/useTranslate';
import { HelpCircleIcon } from '../../ui/Icons';

// Declaration locations are metadata, not runtime value bindings.
export function PropertyDeclarationInfo({ property }: { readonly property: ComponentProperty }) {
  const translate = useTranslate();
  const origin = property.origin;
  const sources = origin?.declarations ?? [];
  const details = sources.map((source) =>
    translate('componentProps.declaration.source', { label: source.label, line: source.line, expression: source.expression }),
  );
  if (origin?.defaultValue) {
    details.push(translate('componentProps.declaration.default', { line: origin.defaultValue.line, expression: origin.defaultValue.expression }));
  }
  if (details.length === 0) {
    return undefined;
  }
  return (
    <button type="button" className="property-declaration-info" aria-label={translate('componentProps.declaration.details')} title={details.join('\n')}>
      <HelpCircleIcon size={12} />
    </button>
  );
}

export function PropertyConditions({ property }: { readonly property: ComponentProperty }) {
  const translate = useTranslate();
  const translateDescribed = useTranslateDescribed();
  if (!property.conditions?.length) {
    return undefined;
  }
  return (
    <div className="property-conditions">
      <strong>{translate('componentProps.declaration.variantRules')}</strong>
      <ul>
        {property.conditions.map((condition, index) => (
          <li key={index}>{translateDescribed({ message: condition, messageRef: property.conditionRefs?.[index] })}</li>
        ))}
      </ul>
    </div>
  );
}
