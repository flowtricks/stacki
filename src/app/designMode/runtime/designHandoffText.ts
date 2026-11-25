// The words of a hand-off, for the agent: one clause per change, and the note lines the pictures carry. English,
// like every word Stacki sends an agent; one line of at most 500 characters per note (shared/ipc/aiChat.ts, `note`).
import { SCREENSHOT_NOTE_CHARS_MAX } from '../../../../shared/ipc/aiChat';
import type { DesignChange, DescribedElement } from '../model/designChanges';
import type { DesignFrameRecord, DesignPage } from '../model/designTypes';

function styleClause(style: { readonly property: string; readonly before: string; readonly after: string }): string {
  if (style.after === '') {
    return `removed ${style.property}`;
  }
  return style.before === '' ? `${style.property}: ${style.after}` : `${style.property}: ${style.before} → ${style.after}`;
}

/** One change as a short clause for the agent. */
export function changeSentence(change: DesignChange): string {
  const name = (element: DescribedElement): string => (element.source === undefined ? element.label : `${element.label} (${element.source})`);
  switch (change.kind) {
    case 'moved':
      return `moved ${name(change.element)} into ${change.parent.label}${change.after === undefined ? ' as its first child' : ', after ' + change.after.label}`;
    case 'freed':
      return `placed ${name(change.element)} freely (position: absolute) ${change.box} inside ${change.parent.label}`;
    case 'restyled':
      return `${name(change.element)} styles: ${change.styles.map(styleClause).join('; ')}`;
    case 'text':
      return `changed the text of ${name(change.element)} to "${change.after}"`;
    case 'attribute':
      return `changed ${change.name} of ${name(change.element)} from "${change.before}" to "${change.after}"`;
    case 'removed':
      return `deleted ${name(change.element)}`;
    case 'hidden':
      return `hid ${name(change.element)}`;
    case 'shown':
      return `showed ${name(change.element)}`;
    case 'added':
      return `added ${change.what} inside ${change.parent.label}`;
    case 'props':
      return `set the props of ${name(change.element)}: ${change.props.map((prop) => `${prop.property} ${prop.before} → ${prop.after}`).join(', ')}`;
    case 'unlinked':
      return `detached ${name(change.element)} from its component (${change.component}); its look is the target, as plain markup or a new variant`;
    default: {
      const exhaustive: never = change;
      return exhaustive;
    }
  }
}

/** Text as one note line: no control characters, at most the note bound, cut with an ellipsis. */
export function noteLine(text: string): string {
  const flat = text
    .replace(/\p{Cc}+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length <= SCREENSHOT_NOTE_CHARS_MAX ? flat : flat.slice(0, SCREENSHOT_NOTE_CHARS_MAX - 1).trimEnd() + '…';
}

/** The overview's note: what the pictures are and what to do with them. */
export function overviewNote(page: DesignPage, frame: DesignFrameRecord, changeCount: number, closeUps: number): string {
  const where = page.file === undefined ? `the page at ${page.route}` : `${page.file} (route ${page.route})`;
  const changes =
    changeCount === 0
      ? 'No changes were made to the copy.'
      : `${String(changeCount)} changes${closeUps > 0 ? ', described with the close-ups that follow' : ''}.`;
  return noteLine(
    `Design mode mockup "${frame.name}" of ${where}, ${String(frame.widthPx)}px wide. It is a mockup; nothing was saved. ` +
      `Rebuild the page in source to look like this, with the project's components, props and classes; inline styles show the intended look. ${changes}`,
  );
}
