// Design mode (experimental, removable: docs/design-mode/REMOVE.md): a live preview's report, applied to the shown
// frame's document (electron/preload/designMode/designLiveMirror.ts): restyled in place, so hovering a value or
// scrubbing a number shows in the frame as it does on the editor's own canvas, with nothing saved.
import { DESIGN_ID_ATTRIBUTE, type DesignCanvasMessage } from '../../../shared/ipc/designSnapshot';

type LiveReport = Extract<DesignCanvasMessage, { readonly type: 'stacki:design-live' }>;

const VARIABLES_ID = 'dm-live-variables';
const FONT_FACE = /@font-face\s*\{[^}]*\}/g;

export function applyLiveReport(document: Document, report: LiveReport): void {
  for (const sheet of report.sheets) {
    const owner = document.querySelector(`style[${DESIGN_ID_ATTRIBUTE}="${String(sheet.id)}"]`);
    if (owner !== null) {
      // The snapshot's fonts carry their bytes, which the page's own rules do not: those blocks are kept.
      const fonts = (owner.textContent ?? '').match(FONT_FACE) ?? [];
      owner.textContent = fonts.length === 0 ? sheet.css : `${fonts.join('\n')}\n${sheet.css.replace(FONT_FACE, '')}`;
    }
  }
  for (const element of report.elements) {
    const target = document.querySelector(`[${DESIGN_ID_ATTRIBUTE}="${String(element.id)}"]`);
    if (target === null || target.tagName === 'STYLE') {
      continue;
    }
    setOrRemove(target, 'style', element.style);
    setOrRemove(target, 'class', element.className);
  }
  let variables = document.getElementById(VARIABLES_ID) ?? undefined;
  if (variables === undefined && report.variables !== '') {
    variables = document.createElement('style');
    variables.id = VARIABLES_ID;
    document.head.appendChild(variables);
  }
  if (variables !== undefined) {
    variables.textContent = report.variables;
  }
}

function setOrRemove(element: Element, attribute: string, value: string | undefined): void {
  if (value === undefined) {
    element.removeAttribute(attribute);
  } else if (element.getAttribute(attribute) !== value) {
    element.setAttribute(attribute, value);
  }
}
