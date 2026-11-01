// What the connect wrapper reads off the field it wraps: its value and
// placeholder, the variable a binding names, and setting the field's value or
// ref the way React expects (VariableConnect.tsx).

import { isValidElement } from 'react';
import type { ReactElement, ReactNode, Ref, RefCallback } from 'react';

// Read the current value out of the wrapped <input> child, so callers don't have to
// thread it through — children IS the input element, and its `value` is the field draft.
export function childValue(children: ReactNode): string {
  return isValidElement<{ value?: unknown }>(children) && typeof children.props.value === 'string' ? children.props.value : '';
}
// The wrapped input's placeholder ("Auto", "0", …). The rich field replaces that
// input on screen, so it has to show the same hint when the value is empty.
export function childPlaceholder(children: ReactNode): string {
  const placeholder = isValidElement<{ placeholder?: unknown }>(children) ? children.props.placeholder : undefined;
  return typeof placeholder === 'string' ? placeholder : '';
}

// A binding's display name — parsed from the custom-property tail (…--<name> → <name>),
// used as the chip label until the exact variable name resolves from the loaded list.
export function bindingName(binding: string): string {
  const inner = (
    binding
      .replace(/^var\(\s*/i, '')
      .replace(/\s*\)\s*$/i, '')
      .split(',')[0] ?? ''
  ).trim();
  const parts = inner.split('--').filter(Boolean);
  return parts[parts.length - 1] ?? inner;
}

// Webflow can append a resolved value to size-variable names on either side of the
// bridge (`space/2 (12px)`). Keep both forms because some projects include that text
// in the variable's actual name while others add it only to the property readback.
export function nativeVariableNames(value: string): string[] {
  const exact = value.trim();
  const withoutResolved = exact.replace(/\s+\([^()]+\)\s*$/, '').trim();
  return withoutResolved && withoutResolved !== exact ? [exact, withoutResolved] : [exact];
}

// Update the hidden input's DOM value before invoking its controlled onChange handler.
// The handler is called directly by VariableConnect below; dispatching a native `input`
// event from inside the contentEditable's blur proved timing-sensitive in React.
// The native setter, so React's own tracker sees the change (assigning `.value`
// straight would be swallowed as "no change" on a controlled field). It has to be
// the setter for the element's OWN class: the big value editor wraps a <textarea>,
// and HTMLInputElement's setter refuses to run on one — it throws mid-commit, so
// everything typed into the rich field never reached the parent's draft.
export function setInputValue(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  // The element's OWN prototype, whichever it is — read off the element rather than
  // named, so this doesn't depend on the global being there.
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')?.set;
  setter?.call(input, value);
}

export type FieldElement = HTMLInputElement | HTMLTextAreaElement;
// What React's callback-ref protocol hands a ref: the element, or its own `null`
// on unmount.
export type FieldRefValue = Parameters<RefCallback<FieldElement>>[0];
export type ChildFieldProps = {
  readonly ref?: Ref<FieldElement>;
  readonly className?: string;
  readonly value?: unknown;
  readonly placeholder?: unknown;
  readonly onChange?: (event: unknown) => void;
  readonly onFocus?: (event: unknown) => void;
  readonly onBlur?: (event: unknown) => void;
  readonly onMouseEnter?: (event: unknown) => void;
  readonly onMouseLeave?: (event: unknown) => void;
};

export function isFieldRefCallback(value: unknown): value is RefCallback<FieldElement> {
  return typeof value === 'function';
}

export function updateChildRef(child: ReactElement<ChildFieldProps>, element: FieldRefValue): void {
  const childRef: unknown = Object.getOwnPropertyDescriptor(child, 'ref')?.value;
  if (isFieldRefCallback(childRef)) {
    childRef(element);
  } else if (childRef !== undefined && childRef !== null && typeof childRef === 'object') {
    if (!Reflect.set(childRef, 'current', element)) {
      throw new Error('Child field ref could not be updated');
    }
  }
}
