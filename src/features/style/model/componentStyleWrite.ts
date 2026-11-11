// Writing an instance's style where it lives: the component file whose template
// writes `style={…}` on the element the instance renders (Heading.astro). Every
// instance of the component takes the edit, which the panel says above the CSS code.
//
// One write is the file's next text, made from the text the cache holds for it, and
// one undo step that writes the old text back. The component source cache holds the new text at once,
// so the next edit builds on it before the watcher reports the change.

import { assert } from '../../../../shared/core/assert';
import { LIMITS } from '../../../../shared/core/limits';
import { styleTransport } from '../../../ipc/editorEnvironment';
import { rememberComponentSource } from './componentSourceCache';
import { getHost } from './host';

/** The component file's text with its style expression (at `start`–`end`) replaced. */
export function componentStyleText(source: { readonly text: string; readonly start: number; readonly end: number }, expression: string): string {
  assert(source.start <= source.end, 'componentStyleText: the span has an order');
  assert(source.end <= source.text.length, 'componentStyleText: the span is inside the file');
  assert(expression.length <= LIMITS.attrCharsMax, 'componentStyleText: an attribute is inside its bound');
  return source.text.slice(0, source.start) + expression + source.text.slice(source.end);
}

/** Write the component file from `before` to `after`, as one undo step. */
export async function writeComponentStyle(path: string, label: string, texts: { readonly before: string; readonly after: string }): Promise<void> {
  const { before, after } = texts;
  if (before === after) {
    return;
  }
  rememberComponentSource(path, after);
  try {
    await styleTransport.writeStyleFile({ filePath: path, css: after, base: before });
  } catch (error: unknown) {
    // Not written: the cache goes back to what the file still holds.
    rememberComponentSource(path, before);
    throw error;
  }
  getHost().recordUndo?.({
    label: `inline styles in ${label}`,
    undo: async () => {
      rememberComponentSource(path, before);
      await styleTransport.writeStyleFile({ filePath: path, css: before, base: after });
    },
    redo: async () => {
      rememberComponentSource(path, after);
      await styleTransport.writeStyleFile({ filePath: path, css: after, base: before });
    },
  });
}
