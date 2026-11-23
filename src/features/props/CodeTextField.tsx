import { useCodeAccess } from '../../ui/CodeAccess';
import ExprInput from '../../ui/ExprInput';
import type { AttributeLanguage } from '../../ui/attributeLanguage';
import { propSyntax } from './propSyntax';

// A line of text that is code in its own right (a `sizes` list, a handler, a
// path's `d`), as the field a plain <input> was: the same value in, the same
// text out on every edit, one line, and the code editor's colours. Where code
// editors are not offered (CodeAccess), it is the plain input it replaces.

interface CodeTextFieldProps {
  readonly value: string;
  readonly language: AttributeLanguage;
  readonly onChange: (text: string) => void;
  readonly placeholder?: string | undefined;
  readonly ariaLabel?: string | undefined;
  readonly className?: string | undefined;
  readonly readOnly?: boolean | undefined;
  readonly onBlur?: (() => void) | undefined;
  // Takes the error look (a tinted fill, never a border) while its value is refused.
  readonly invalid?: boolean | undefined;
}

export default function CodeTextField(props: CodeTextFieldProps) {
  const { value, language, onChange, placeholder, ariaLabel, className, readOnly, onBlur, invalid } = props;
  const allowed = useCodeAccess();
  if (!allowed || readOnly === true) {
    return (
      <input
        className={className}
        value={value}
        placeholder={placeholder}
        aria-label={ariaLabel}
        readOnly={readOnly}
        aria-invalid={invalid === true ? true : undefined}
        spellCheck={false}
        onBlur={onBlur}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  }
  return (
    <ExprInput
      value={value}
      syncValue={value}
      syntax={propSyntax(language)}
      singleLine
      invalid={invalid === true}
      wrap
      className={className ?? ''}
      placeholder={placeholder ?? ''}
      {...(ariaLabel === undefined ? {} : { ariaLabel })}
      onChange={onChange}
      onCommit={() => onBlur?.()}
    />
  );
}
