import { runsOf, elementsWithPath } from '../../../vendor/stacki/electron/preload/frameRegions';
import { record, string } from '../../shared/validation';
import { renderedText } from './renderedText';
interface TextChange {
  readonly text: string;
  readonly before: string;
  readonly previous: string;
  readonly parent: string;
}
const pending = new Map<string, TextChange>();
function decodeText(text: string) {
  const textarea = document.createElement('textarea');
  textarea.innerHTML = text.replaceAll('<', '&lt;');
  return textarea.value;
}
export function receiveLiveText(input: unknown) {
  try {
    const data = record(input);
    if (data['type'] !== 'studio:live-text' || !Array.isArray(data['changes'])) {
      return;
    }
    if (data['reset'] === true) {
      pending.clear();
    }
    for (const input of data['changes'].slice(0, 500)) {
      const change = record(input);
      const path = string(change['path'], 1000);
      if (pending.size < 500 || pending.has(path)) {
        pending.set(path, {
          text: decodeText(string(change['text'], 100_000)),
          before: pending.get(path)?.before ?? decodeText(string(change['before'], 100_000)),
          previous: decodeText(string(change['before'], 100_000)),
          parent: string(change['parent'], 1000),
        });
      }
    }
    applyLiveText();
  } catch {
    /* Invalid preview messages cannot modify the page. */
  }
}
export function applyLiveText(rendered?: Document) {
  const confirmed = rendered ? renderedText(rendered) : undefined;
  for (const [path, change] of pending) {
    const { text } = change;
    const serverText = confirmed?.has(path) ? confirmed.get(path) : confirmed?.get(change.parent);
    if (serverText !== undefined && serverText === text.trim()) {
      pending.delete(path);
      continue;
    }
    const mapped = runsOf(path);
    const runs = mapped?.length ? mapped : literalRuns(change);
    if (!runs?.length) {
      continue;
    }
    for (const run of runs) {
      const texts = run.filter((node): node is Text => node instanceof Text);
      // Never rewrite a component's DOM or an expression. Only a region
      // containing one literal text node is eligible for this fast path.
      if (texts.length !== 1 || run.some((node) => node instanceof Element)) {
        continue;
      }
      const node = texts[0];
      if (node && node.data !== text) {
        node.data = text;
      }
    }
  }
}

function literalRuns(change: TextChange): Node[][] {
  if (!change.parent) {
    return [];
  }
  return elementsWithPath(change.parent).flatMap((element) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const matches: Text[] = [];
    let node: Node | null;
    let count = 0;
    while ((node = walker.nextNode()) && count++ < 1000) {
      if (node instanceof Text) {
        const current = node.data.trim();
        if ([change.before, change.previous, change.text].some((text) => current === text.trim())) {
          matches.push(node);
        }
      }
    }
    return matches.length === 1 ? [matches] : [];
  });
}
