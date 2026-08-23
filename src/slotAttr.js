// What a `slot=` still means once the node carrying it has been moved.
//
// `slot="column2"` is not a property of the element. It is a word addressed to
// the component the element sits inside — "put me in the slot you call
// column2" — and nobody else is listening. Drag that element out into a plain
// <div>, or into a component with no such slot, and the attribute is a note to
// a reader who has left: Astro renders the element in the default slot, or
// nowhere at all, and the markup says something that is no longer true.
//
// So the question on a move is not "did the parent change" but "is there still
// something here that this word means anything to".

/**
 * @param {object} where
 * @param {string|null} where.slotName   the slot the node asks for, or null when
 *                                       it asks for nothing (or asks in code,
 *                                       which this cannot read)
 * @param {object|null} where.host       the component the node has landed
 *                                       inside, or null for none
 * @param {object|null} where.definition what is known about that component —
 *                                       null when the project has no scan of it
 * @returns {boolean} whether to keep the attribute
 */
export function keepsSlot({ slotName, host, definition }) {
  // Nothing to decide: no slot asked for, or one asked for in an expression,
  // whose value this cannot know.
  if (!slotName) return true;
  // Out in the open. Whatever it was addressed to, it is not here.
  if (!host) return false;
  // A component nobody scanned might well have that slot. Silence is not a
  // denial, and throwing the attribute away on it would lose something the
  // person wrote and cannot see the reason for.
  if (!definition) return true;
  return (definition.slots || []).includes(slotName);
}
