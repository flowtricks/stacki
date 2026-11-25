import { assert } from '../../shared/core/assert';
import { LIMITS } from '../../shared/core/limits';

// The order a tag's attributes are written in.
//
// It belongs to the file. The model keeps it as a list of names on the node —
// `attrOrder`, written down when the page is read — because an object only
// remembers the order its keys were added, and that stops being the file's
// order the moment a prop is taken out and put back. The writer follows the
// list: what the file had, where it had it, then anything added since.
//
// Which leaves the one edit that changes a name rather than a value. Renaming
// an attribute keeps the value and the slot; the list is by name, so the name
// has to change there too, or the prop leaves for the end of the tag on its
// way to being called something else.

// A prop renamed in place: the props and their order after the rename, or
// undefined when there is nothing to rename. A name the tag already had gives
// up its slot to the rename — that is what overwriting it means. Pure: the
// node is left as it was (plan §11.9 — the model is never edited in place).
// Values are opaque: renaming must retain all serializer metadata by identity.
export interface AttributeOwner<T> {
  readonly props?: Readonly<Record<string, T>> | undefined;
  readonly attrOrder?: readonly string[] | undefined;
}

export interface RenamedAttributes<T> {
  readonly props: Record<string, T>;
  readonly attrOrder?: string[];
}

export function renamedAttr<T>(node: AttributeOwner<T>, oldName: string, newName: string): RenamedAttributes<T> | undefined {
  const props = node.props;
  if (props === undefined || !Object.hasOwn(props, oldName)) {
    return undefined;
  }
  if (!newName || newName === oldName) {
    return undefined;
  }
  assert(Object.keys(props).length <= LIMITS.attrsPerNodeMax, 'Attribute count exceeds limit');
  assert(newName.length <= LIMITS.attrCharsMax, 'Attribute name exceeds limit');
  const next = Object.fromEntries(
    Object.entries(props).flatMap(([name, value]): [string, T][] => {
      if (name === oldName) {
        return [[newName, value]];
      }
      return name === newName ? [] : [[name, value]];
    }),
  );
  const order = node.attrOrder;
  if (order === undefined) {
    return { props: next };
  }
  const attrOrder = order.filter((name) => name !== newName).map((name) => (name === oldName ? newName : name));
  return { props: next, attrOrder };
}
