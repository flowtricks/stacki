import { record, string } from '../../shared/validation';
import { queryAuthoredStyles } from '../../../vendor/stacki/electron/preload/frameStyleSources';
import { mapped } from '../../../vendor/stacki/electron/preload/frameRegions';
import { ownClasses } from '../../../vendor/stacki/electron/preload/frameMeasure';
import { styleElements, textStyleHost } from './styleQueryTargets';
import { renderedPageImage, renderedPageType } from '../../../vendor/stacki/electron/preload/framePageMetadata';
import { renderedPageText } from '../../../vendor/stacki/electron/preload/framePageText';

function values(input: unknown): string[] {
  if (!Array.isArray(input) || input.length > 1000) {
    return [];
  }
  return input.map((item: unknown) => string(item, 4000));
}
export function answerPreviewQuery(input: unknown, selectionCursor?: CSSStyleSheet): unknown {
  const data = record(input);
  const id = data['id'];
  if (typeof id !== 'number' || !Number.isSafeInteger(id)) {
    throw new Error('Invalid query');
  }
  if (data['pageMetadata'] === true) {
    return {
      type: 'avb:query-result',
      id,
      found: true,
      pageImage: renderedPageImage(document),
      pageType: renderedPageType(document),
    };
  }
  if (data['pageText'] === true) {
    return { type: 'avb:query-result', id, found: true, pageText: renderedPageText(document) };
  }
  const path = string(data['path'], 500);
  const elements = path ? styleElements(path) : [];
  const element = elements[0];
  const parent = data['textParentPath'];
  const styleHost = element ?? textStyleHost(path, parent === undefined ? undefined : string(parent, 500));
  const props = values(data['props']);
  const matched: Record<string, boolean> = {};
  for (const selector of values(data['selectors'])) {
    try {
      matched[selector] = elements.some((element) => element.matches(selector));
    } catch {
      /* Invalid selectors remain unanswered. */
    }
  }
  return {
    type: 'avb:query-result',
    id,
    ready: mapped,
    found: !!styleHost,
    identity: element
      ? {
          tag: element.tagName.toLowerCase(),
          id: element.id,
          classes: ownClasses(element),
          attributes: Object.fromEntries([...element.attributes].filter((attr) => !attr.name.startsWith('data-avb-')).map((attr) => [attr.name, attr.value])),
        }
      : undefined,
    matched,
    computedProps: styleHost ? computedProperties(styleHost, props, selectionCursor) : {},
    ...(styleHost ? queryAuthoredStyles(styleHost, props, element ? 'element' : 'text') : {}),
    computed: resolveColors(styleHost ?? document.documentElement, values(data['compute'])),
  };
}
function resolveColors(host: Element, values: readonly string[]) {
  if (!values.length) {
    return {};
  }
  const probe = document.createElement('span');
  probe.setAttribute('data-avb-probe', '');
  probe.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none;';
  host.append(probe);
  const result: Record<string, string> = {};
  for (const value of values) {
    probe.style.color = '';
    probe.style.color = value;
    if (probe.style.color) {
      result[value] = getComputedStyle(probe).color;
    }
  }
  probe.remove();
  return result;
}

function computedProperties(element: Element, props: readonly string[], selectionCursor?: CSSStyleSheet) {
  const design = document.getElementById('avb-design-style');
  const sheet = design instanceof HTMLStyleElement ? design : undefined;
  const disabled = sheet?.disabled ?? false;
  const cursorDisabled = selectionCursor?.disabled ?? false;
  try {
    if (selectionCursor) {
      selectionCursor.disabled = true;
    }
    if (sheet) {
      sheet.disabled = true;
    }
    const computed = getComputedStyle(element);
    return Object.fromEntries(props.map((prop) => [prop, computed.getPropertyValue(prop)]));
  } finally {
    if (selectionCursor) {
      selectionCursor.disabled = cursorDisabled;
    }
    if (sheet) {
      sheet.disabled = disabled;
    }
  }
}
