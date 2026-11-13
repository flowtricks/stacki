import type { ComponentProperty } from '../../../shared/properties/propertyEditing';
import { useTranslate, useTranslateDescribed } from '../../lib/i18n/useTranslate';
import { CodeBlock } from '../../ui/CodeBlock';

export default function PropertyReadOnlyFields({ property }: { readonly property: ComponentProperty }) {
  const translate = useTranslate();
  const translateDescribed = useTranslateDescribed();
  const editing = property.editing;
  const reason =
    editing?.kind === 'restricted'
      ? translateDescribed({ message: editing.reason, messageRef: editing.reasonRef })
      : translate('componentProps.readOnly.editInSource');
  return (
    <div className="property-readonly-fields">
      <p className="property-help">{reason}</p>
      <ReadOnlyField label={translate('componentProps.readOnly.name')} value={property.name} />
      <ReadOnlyCode label={translate('componentProps.readOnly.codeType')} value={property.type} />
      <div className="property-flags">
        <label>
          <input type="checkbox" checked={property.required} disabled />
          {translate('componentProps.readOnly.required')}
        </label>
      </div>
      <ReadOnlyCode label={translate('componentProps.readOnly.defaultValue')} value={property.defaultValue} />
      <ReadOnlyField label={translate('componentProps.readOnly.tooltip')} value={property.description} rows={3} />
    </div>
  );
}

function ReadOnlyCode({ label, value }: { readonly label: string; readonly value: string }) {
  const translate = useTranslate();
  return (
    <div className="property-readonly-code">
      {label}
      {value === '' ? (
        <CodeBlock label={label} text={translate('componentProps.readOnly.notSpecified')} />
      ) : (
        <CodeBlock label={label} language="typescript" text={value} />
      )}
    </div>
  );
}

function ReadOnlyField({ label, value, rows = 1 }: { readonly label: string; readonly value: string; readonly rows?: number }) {
  const translate = useTranslate();
  return (
    <label>
      {label}
      <textarea readOnly value={value} rows={rows} aria-label={label} placeholder={translate('componentProps.readOnly.notSpecified')} />
    </label>
  );
}
