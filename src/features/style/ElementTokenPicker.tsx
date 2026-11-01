import { useMemo } from 'react';
import type { ElementSnapshot } from './model/styleTypes';
import { snapshotTokens } from './model/elementTokens';

/**
 * A read-only, monospace rendering of the selected element's identity as a CSS
 * selector — tag + `.class`es + `[attr]`/`[attr="value"]` (e.g.
 * `h2.hero_title.u-text-style-h2[data-x="1"]`). Just a reference; the actual
 * editable selectors live in the SelectorPicker below.
 */
export default function ElementTokenPicker({ snapshot }: { snapshot: ElementSnapshot | undefined }) {
  const tokens = useMemo(() => snapshotTokens(snapshot), [snapshot]);
  if (!tokens.length) {
    return undefined;
  }

  const selector = tokens
    .map((token) => {
      const name = token.label ?? '';
      if (token.kind === 'tag') {
        return name;
      }
      if (token.kind === 'class') {
        return `.${name}`;
      }
      const value = snapshot?.attributes[name] ?? '';
      return value ? `[${name}="${value}"]` : `[${name}]`;
    })
    .join('');

  return (
    <div className="embed-editor_element-id" title={selector}>
      {selector}
    </div>
  );
}
