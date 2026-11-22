// The Properties panel's own prop field, lent to the AI composer's component-chip popover
// (src/features/ai/mentions/ComponentMembersPopover.tsx). The AI feature may not import the props
// feature (eslint.config.mjs, source layers), so the shell, which may import both, registers the
// adapter once at load: a chip's value in as the attribute the field edits, the field's new attribute
// out as the value the chip names. Nothing is written to a file: the value only becomes `prop:name=value`.
//
// In the component's popover, as for a placed instance (policy "instance"): an unset prop shows the
// component's default dim, and choosing the default is the same as leaving the prop alone, so it is not
// called out. In one chip's own popover ("explicit") the choice is kept, the default included. Code access and
// the canvas hover preview are off: the composer has no page, node or bindings to give the field.
import type { Attr } from '../../../shared/page/pageNodeTypes';
import { registerMemberField, type MemberFieldRenderer } from '../../features/ai/mentions/ComponentMembersPopover';
import PropField from '../../features/props/PropField';
import { PropHoverPreviewContext, PropValuePolicyContext } from '../../features/props/propValuePolicy';
import { CodeAccess } from '../../ui/CodeAccess';

/** The attribute a chip's value stands for: numbers and switches are code in a prop, everything else a string. */
export function memberAttr(type: string, value: string | undefined): Attr | undefined {
  if (value === undefined) {
    return undefined;
  }
  return type === 'number' || type === 'boolean' ? { type: 'expr', value } : { type: 'string', value };
}

/** The value a chip names for what the field wrote; an empty, bare or spread attribute names none. */
export function memberValue(attr: Attr | undefined): string | undefined {
  if (attr === undefined || attr.type === 'bare' || attr.type === 'spread') {
    return undefined;
  }
  const text = attr.value.trim();
  return text === '' ? undefined : attr.value;
}

const MemberField: MemberFieldRenderer = ({ prop, value, policy, onChange }) => (
  // "defaults" is the panel's policy for a recipe: what is chosen stays chosen, the default included.
  <PropValuePolicyContext.Provider value={policy === 'instance' ? 'instance' : 'defaults'}>
    <CodeAccess.Provider value={false}>
      <PropHoverPreviewContext.Provider value={false}>
        <PropField field={prop.field} value={memberAttr(prop.field.type, value)} onChange={(next) => onChange(memberValue(next))} />
      </PropHoverPreviewContext.Provider>
    </CodeAccess.Provider>
  </PropValuePolicyContext.Provider>
);

registerMemberField(MemberField);
