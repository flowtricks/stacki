// A field's caption row as a <label> that holds buttons of its own (a {} toggle, a bind handle, an (i) hint): the
// field's name, and controls beside it, over a control drawn elsewhere.
//
// Why: a <label> without `for` takes its first labelable descendant as its control, and the browser forwards the
// label's hover and presses to it. In a caption row that is the first small button, so hovering anywhere on the name
// lit up the {} toggle and a press on the name could press it. An empty `for` names no element, so the caption
// controls nothing and only the button under the pointer is hovered or pressed. A caption over one real input names
// that input with its own id instead (`htmlFor={id}`), which keeps "press the name to focus the field".
export const CAPTION_LABEL_FOR = '';
