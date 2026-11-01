import { codeWindowFor, FRONTMATTER_SUBJECT } from '../../../vendor/stacki/src/features/code/codeWindowTarget';
import { parsePageNode } from '../../../vendor/stacki/shared/page/pageNode';
import { flatten, parsePage, applyEdits } from '../source/source';
import { frontmatterEdit, nodeTextEdit } from '../settings/settingsEdits';
import { frontmatterRange } from '../source/frontmatter';

export function codeWindowSource(source: string, id: string) {
  if (id === 'frontmatter') {
    return {
      ...codeWindowFor(FRONTMATTER_SUBJECT),
      value: frontmatterRange(source)?.value ?? '',
    };
  }
  const parsed = parsePage(source, { locs: true });
  const node = parsed.editable ? flatten(parsed.model.nodes).find((node) => node.id === id) : undefined;
  if (node?.kind !== 'raw') {
    return undefined;
  }
  return { ...codeWindowFor(parsePageNode(node)), value: node.inner };
}

export function codeWindowEdit(source: string, id: string, expected: string, value: string) {
  const current = codeWindowSource(source, id);
  if (!current || current.value !== expected) {
    throw new Error('This code changed. Review the latest text before editing again.');
  }
  const edit = id === 'frontmatter' ? frontmatterEdit(source, value) : nodeTextEdit(source, id, value);
  return applyEdits(source, [edit]);
}
