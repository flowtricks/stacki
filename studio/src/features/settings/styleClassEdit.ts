import { hasClass, withClass } from '../../../vendor/stacki/src/editor/classAttr';
import { classRemoval } from '../../../vendor/stacki/src/editor/selectorRemoval';
import { parsePageNode } from '../../../vendor/stacki/shared/page/pageNode';
import { applyEdits, attributeEdit, nodeAt } from '../source/source';
import { assert } from '../../../vendor/stacki/shared/core/assert';
import { setAttributes } from './settingsEdits';

export function addStyleClass(source: string, id: string, name: string): string {
  if (!name || name.length > 256 || /[\s"'`<>\\{}]/.test(name)) {
    throw new Error('Enter a single class name.');
  }
  const node = parsePageNode(nodeAt(source, id));
  if (!('props' in node)) {
    throw new Error('Select an element to add a class.');
  }
  if (hasClass(node.props, name)) {
    return source;
  }
  const edit = withClass(node.props, name);
  if (!edit) {
    throw new Error('Stacki couldn’t add this class. Check the class name and retry.');
  }
  if (edit.remove !== undefined) {
    assert(edit.key === 'class:list', 'Computed classes migrate to class:list');
    assert(edit.value.type === 'expr', 'A migrated class keeps its expression');
    const replaced = attributeEdit(source, id, edit.remove, edit.value.value, true);
    const text = `${edit.key}={${edit.value.value}}`;
    return applyEdits(source, [{ ...replaced, text }]);
  }
  return setAttributes(source, id, { [edit.key]: edit.value });
}

/** The page with every literal `name` taken off the element (class and class:list alike), or why not. */
export type StyleClassRemoval = { readonly tag: 'applied'; readonly source: string } | { readonly tag: 'refused'; readonly message: string };

// Desktop's own rule (src/editor/selectorRemoval.ts), written through Studio's
// attribute edits. The result is read back before it is offered: an edit that
// leaves the class on the element is refused rather than written.
export function removeStyleClass(source: string, id: string, name: string): StyleClassRemoval {
  if (!name || name.length > 256 || /[\s"'`<>\\{}]/.test(name)) {
    return { tag: 'refused', message: 'Enter a single class name.' };
  }
  const node = parsePageNode(nodeAt(source, id));
  if (!('props' in node)) {
    return { tag: 'refused', message: 'Select an element to remove a class.' };
  }
  const removal = classRemoval(node.props, name);
  if (removal.tag === 'refused') {
    return { tag: 'refused', message: removal.reason };
  }
  const next = setAttributes(source, id, removal.patch);
  assert(next !== source, 'removeStyleClass: an edit changes the page');
  const after = parsePageNode(nodeAt(next, id));
  assert('props' in after, 'removeStyleClass: the element is still an element');
  if (hasClass(after.props, name)) {
    return { tag: 'refused', message: `Stacki couldn’t take “${name}” off this element safely. Change it in code.` };
  }
  return { tag: 'applied', source: next };
}
