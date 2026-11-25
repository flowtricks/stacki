// Syntax colours for the code blocks inside the rich text editor, painted with
// the CSS Custom Highlight API: ranges over the text that is already there,
// coloured by `::highlight(...)` rules. Nothing is added to the editor's DOM, so
// the HTML the writer compares (markdownWrite.ts) is the HTML the reader made,
// and an unedited code block keeps its bytes. The colours are the app's one code
// palette (codeHighlight.ts). A runtime without the API (jsdom) shows plain code.
import { assert } from '../../../shared/core/assert';
import { CODE_TOKEN_RULES, codeTokenLines, languageNamed, type CodeTokenStyle } from '../../ui/codeHighlight';

/** Code blocks coloured per pass; a document past it shows the rest plain. */
const BLOCKS_MAX = 200;
/** Characters coloured per block, the same order as a preview's limit. */
const BLOCK_CHARS_MAX = 50_000;
const NAME_PREFIX = 'stacki-md-code-';

interface HighlightRegistry {
  set(name: string, highlight: unknown): void;
  delete(name: string): void;
}

// The API's two globals, found and typed here so the rest of the module never guesses.
function highlightApi(): { readonly registry: HighlightRegistry; readonly create: (ranges: readonly Range[]) => unknown } | undefined {
  const css: unknown = Reflect.get(globalThis, 'CSS');
  const Highlight: unknown = Reflect.get(globalThis, 'Highlight');
  if (typeof css !== 'object' || css === null || typeof Highlight !== 'function') {
    return undefined;
  }
  const registry: unknown = Reflect.get(css, 'highlights');
  if (typeof registry !== 'object' || registry === null) {
    return undefined;
  }
  const set: unknown = Reflect.get(registry, 'set');
  const remove: unknown = Reflect.get(registry, 'delete');
  if (typeof set !== 'function' || typeof remove !== 'function') {
    return undefined;
  }
  return {
    registry: {
      set: (name, highlight) => {
        Reflect.apply(set, registry, [name, highlight]);
      },
      delete: (name) => {
        Reflect.apply(remove, registry, [name]);
      },
    },
    create: (ranges) => {
      const highlight: unknown = Reflect.construct(Highlight, ranges);
      return highlight;
    },
  };
}

/** One `::highlight()` rule per palette entry, for the editor's stylesheet. */
export function codeHighlightRules(): string {
  return CODE_TOKEN_RULES.map((rule, index) => `::highlight(${NAME_PREFIX}${index}) { ${cssOf(rule.style)} }`).join('\n');
}

function cssOf(style: CodeTokenStyle): string {
  // Highlights may set colour and decoration only; weight and slant stay the text's own.
  const parts = [
    style.color === undefined ? '' : `color: ${style.color};`,
    style.textDecoration === undefined ? '' : `text-decoration: ${style.textDecoration};`,
  ];
  return parts.join(' ');
}

/** Colours every `pre > code` under `host`; returns the clean-up that removes the colours. */
export function paintCodeBlocks(host: HTMLElement, document: Document): () => void {
  const api = highlightApi();
  if (api === undefined) {
    return () => {};
  }
  const ranges = new Map<number, Range[]>();
  const blocks = [...host.querySelectorAll('pre > code')].slice(0, BLOCKS_MAX);
  for (const code of blocks) {
    const language = languageNamed(/(?:^|\s)language-([\w#+.-]+)/.exec(code.getAttribute('class') ?? '')?.[1] ?? '');
    const text = code.textContent ?? '';
    if (language === undefined || language === 'astro' || text.length > BLOCK_CHARS_MAX) {
      continue;
    }
    paintBlock(code, text, language, document, ranges);
  }
  const names: string[] = [];
  for (const [index, list] of ranges) {
    const name = `${NAME_PREFIX}${index}`;
    api.registry.set(name, api.create(list));
    names.push(name);
  }
  return () => {
    for (const name of names) {
      api.registry.delete(name);
    }
  };
}

function paintBlock(
  code: Element,
  text: string,
  language: Exclude<ReturnType<typeof languageNamed>, undefined | 'astro'>,
  document: Document,
  ranges: Map<number, Range[]>,
): void {
  const texts = textNodes(code, document);
  let offset = 0;
  for (const line of codeTokenLines(text, language)) {
    for (const token of line) {
      const rule = token.style === undefined ? -1 : CODE_TOKEN_RULES.findIndex((each) => each.style === token.style || sameStyle(each.style, token.style));
      if (rule >= 0 && token.text.trim() !== '') {
        const range = rangeAt(texts, offset, offset + token.text.length, document);
        if (range !== undefined) {
          const list = ranges.get(rule) ?? [];
          list.push(range);
          ranges.set(rule, list);
        }
      }
      offset += token.text.length;
    }
    offset += 1; // The line break between lines.
  }
  assert(offset >= text.length, 'Painting walks the whole block');
}

function sameStyle(left: CodeTokenStyle, right: CodeTokenStyle | undefined): boolean {
  return right !== undefined && left.color === right.color && left.fontStyle === right.fontStyle && left.fontWeight === right.fontWeight;
}

interface Placed {
  readonly node: Text;
  readonly start: number;
}

function textNodes(root: Element, document: Document): readonly Placed[] {
  const walker = document.createTreeWalker(root, 4);
  const placed: Placed[] = [];
  let start = 0;
  for (let node = walker.nextNode(); node !== null && placed.length < BLOCK_CHARS_MAX; node = walker.nextNode()) {
    if (node.nodeType === 3 && node instanceof Text) {
      placed.push({ node, start });
      start += node.data.length;
    }
  }
  return placed;
}

function rangeAt(texts: readonly Placed[], from: number, to: number, document: Document): Range | undefined {
  const first = texts.find((each) => from >= each.start && from < each.start + each.node.data.length);
  const last = texts.find((each) => to > each.start && to <= each.start + each.node.data.length);
  if (first === undefined || last === undefined) {
    return undefined;
  }
  const range = document.createRange();
  range.setStart(first.node, from - first.start);
  range.setEnd(last.node, to - last.start);
  return range;
}
