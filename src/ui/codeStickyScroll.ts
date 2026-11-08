// Sticky scroll for a code editor: the opening lines of the blocks around the top
// of the view stay pinned there, so a long block never loses its selector.
// codeStickyLines.ts decides what pins; this file draws it.
//
// The stack lives inside CodeMirror's scroller as a sticky element. That is what
// keeps it right without any work per frame: horizontal scrolling moves the pinned
// code with the code below, the pinned gutter sticks to the left like the real one,
// and a wheel over the stack scrolls the editor, all on the browser's own scroll.
// JavaScript only runs to change which lines show or to slide one out.
//
// The lines are copies, not the editor's own: CodeMirror renders only the viewport,
// and a pinned line is by definition above it. So each is drawn from the syntax tree.

import { highlightingFor, syntaxTree } from '@codemirror/language';
import type { EditorState, Extension } from '@codemirror/state';
import { EditorView, ViewPlugin, type PluginValue, type ViewUpdate } from '@codemirror/view';
import { highlightTree } from '@lezer/highlight';
import { assert } from '../../shared/core/assert';
import {
  stickyBlocksAt,
  stickyHeaderPieces,
  stickyHeightAt,
  stickyRowsMax,
  stickyStack,
  type StickyBlock,
  type StickyRow,
  type StickyStack,
} from './codeStickyLines';

// A pinned line is a name, so a minified line need not be drawn in full.
const STICKY_LINE_CHARS_MAX = 2000;
// Above CodeMirror's gutters (200), so the stack covers them, and below its panels.
const STICKY_LAYER_Z_INDEX = 201;

interface StickyLineSpan {
  readonly from: number;
  readonly to: number;
  readonly className: string;
}

interface StickyGeometry {
  readonly lineHeight: number;
  readonly paddingTop: number;
  readonly rowsMax: number;
  readonly gutterWidth: number;
  readonly numbersWidth: number;
  readonly width: number;
  /** Room for code beside the gutter, which a joined header must fit in. */
  readonly codeWidth: number;
}

/** Colours a line from the syntax tree, with the classes the code below it has. */
function stickyTreeSpans(state: EditorState, from: number, to: number): readonly StickyLineSpan[] {
  assert(from <= to, 'stickyTreeSpans: the range keeps its order');
  const spans: StickyLineSpan[] = [];
  const highlighter = { style: (tags: Parameters<typeof highlightingFor>[1]) => highlightingFor(state, tags) };
  highlightTree(syntaxTree(state), highlighter, (spanFrom, spanTo, className) => spans.push({ from: spanFrom, to: spanTo, className }), from, to);
  return spans;
}

/** The extension: pinned lines, plus the scroll margin that keeps the caret clear of them. */
export function codeStickyScroll(): Extension {
  return [stickyPlugin, stickyMargins, stickyTheme];
}

class StickyScrollView implements PluginValue {
  private readonly root = document.createElement('div');
  private readonly stack = document.createElement('div');
  private rows = new Map<number, HTMLElement>();
  private geometry: StickyGeometry | undefined;
  private rowsStale = false;
  // A scroll draws straight away, in the same frame as the scroll itself. CodeMirror
  // has just measured by then, and it fires this after its own scroll handling.
  private readonly onScroll = (): void => {
    if (this.geometry !== undefined) {
      this.draw(this.stackAt(this.geometry), this.geometry);
    }
  };
  // CodeMirror allows layout reads only in `read`, so the stack is worked out there.
  private readonly measure = {
    key: this,
    read: (view: EditorView): { readonly geometry: StickyGeometry; readonly stack: StickyStack } => {
      const geometry = stickyGeometry(view);
      return { geometry, stack: this.stackAt(geometry) };
    },
    write: ({ geometry, stack }: { readonly geometry: StickyGeometry; readonly stack: StickyStack }): void => {
      if (this.rowsStale) {
        this.clearRows();
        this.rowsStale = false;
      }
      if (stickyGeometryChanged(this.geometry, geometry)) {
        this.clearRows();
        this.root.style.width = `${geometry.width}px`;
        this.root.style.marginRight = `${-geometry.width}px`;
      }
      this.geometry = geometry;
      this.draw(stack, geometry);
    },
  };

  constructor(private readonly view: EditorView) {
    this.root.className = 'cm-sticky-scroll';
    // These lines are copies of text a screen reader already reaches in the document.
    this.root.setAttribute('aria-hidden', 'true');
    this.root.style.zIndex = String(STICKY_LAYER_Z_INDEX);
    this.root.style.display = 'none';
    this.stack.className = 'cm-sticky-stack';
    this.root.appendChild(this.stack);
    // First in the scroller, so its row starts at the left edge with the gutter.
    view.scrollDOM.prepend(this.root);
    view.scrollDOM.addEventListener('scroll', this.onScroll, { passive: true });
    view.requestMeasure(this.measure);
  }

  update(update: ViewUpdate): void {
    // Any transaction can change a line's text or its colours, and highlighting
    // arrives on its own. A selection change is the only frequent one, and redrawing
    // at most six short lines is cheaper than deciding it was not needed.
    if (update.transactions.length > 0) {
      this.rowsStale = true;
    }
    this.view.requestMeasure(this.measure);
  }

  destroy(): void {
    this.view.scrollDOM.removeEventListener('scroll', this.onScroll);
    this.root.remove();
  }

  heightAt(position: number): number {
    const { geometry, view } = this;
    if (geometry === undefined) {
      return 0;
    }
    return stickyHeightAt(view.state, position, geometry);
  }

  private stackAt(geometry: StickyGeometry): StickyStack {
    const { state, scrollDOM } = this.view;
    return stickyStack({
      scrollTop: scrollDOM.scrollTop - geometry.paddingTop,
      lineHeight: geometry.lineHeight,
      rowsMax: geometry.rowsMax,
      lines: this.view,
      blocksAt: (position) => stickyBlocksAt(state, position),
    });
  }

  private draw(stack: StickyStack, geometry: StickyGeometry): void {
    if (stack.rows.length === 0) {
      this.root.style.display = 'none';
      this.clearRows();
      return;
    }
    this.root.style.display = '';
    this.stack.style.height = `${stack.heightPx}px`;
    this.placeRows(stack.rows, geometry);
  }

  // Rows stay in the DOM while they stay pinned, so scrolling usually moves nothing
  // and a slide only changes a transform.
  private placeRows(rows: readonly StickyRow[], geometry: StickyGeometry): void {
    const next = new Map<number, HTMLElement>();
    rows.forEach((row, index) => {
      const { headerFrom } = row.block;
      const element = this.rows.get(headerFrom) ?? this.createRow(row.block, geometry);
      element.style.transform = `translateY(${row.offsetPx}px)`;
      element.style.zIndex = String(rows.length - index);
      next.set(headerFrom, element);
    });
    for (const [headerFrom, element] of this.rows) {
      if (!next.has(headerFrom)) {
        element.remove();
      }
    }
    this.rows = next;
  }

  private clearRows(): void {
    this.stack.replaceChildren();
    this.rows = new Map();
  }

  private createRow(block: StickyBlock, geometry: StickyGeometry): HTMLElement {
    const { state } = this.view;
    const row = document.createElement('div');
    row.className = 'cm-sticky-row';
    row.style.height = `${geometry.lineHeight}px`;
    row.append(stickyGutter(state.doc.lineAt(block.headerFrom).number, geometry), stickyCode(state, block, geometry));
    // The caret stays where it is and the editor keeps focus: this is navigation.
    row.addEventListener('mousedown', (event) => event.preventDefault());
    row.addEventListener('click', () => this.jump(block.headerFrom));
    this.stack.appendChild(row);
    return row;
  }

  // The line lands directly below the lines that stay pinned above it.
  private jump(position: number): void {
    const { geometry, view } = this;
    assert(geometry !== undefined, 'StickyScrollView.jump: a row was drawn from a measured editor');
    view.scrollDOM.scrollTop = view.lineBlockAt(position).top + geometry.paddingTop - this.heightAt(position);
  }
}

const stickyPlugin = ViewPlugin.fromClass(StickyScrollView);

// The margin is worked out for the line the caret is on, not from what is pinned
// now: scrolling to the caret changes what pins, so today's height would be wrong by
// the time the scroll lands. What pins with that line at the top is known exactly.
const stickyMargins = EditorView.scrollMargins.of((view) => {
  const plugin = view.plugin(stickyPlugin);
  return plugin === null ? {} : { top: plugin.heightAt(view.state.selection.main.head) };
});

const stickyTheme = EditorView.baseTheme({
  // Zero height, so it takes no room in the scroller's row and its sticky box never
  // runs out of scroller. The stack hangs from it.
  '.cm-sticky-scroll': {
    position: 'sticky',
    top: 0,
    flex: 'none',
    height: 0,
  },
  // `clip`, not `hidden`: a scroll container here would capture the sticky gutter.
  '.cm-sticky-stack': {
    position: 'absolute',
    top: 0,
    left: 0,
    width: '100%',
    overflow: 'clip',
    boxShadow: '0 2px 5px rgba(0, 0, 0, 0.3)',
  },
  '.cm-sticky-row': {
    position: 'absolute',
    top: 0,
    left: 0,
    display: 'flex',
    width: '100%',
    backgroundColor: 'var(--bg-panel)',
    cursor: 'pointer',
  },
  '.cm-sticky-row:hover .cm-sticky-code': { backgroundColor: 'rgba(255, 255, 255, 0.04)' },
  '.cm-gutters.cm-sticky-gutter': {
    position: 'sticky',
    left: 0,
    flex: 'none',
    display: 'block',
  },
  '.cm-sticky-code': {
    flex: '1 1 auto',
    minWidth: 0,
    boxSizing: 'border-box',
    whiteSpace: 'pre',
  },
  '.cm-sticky-code.cm-sticky-joined': {
    display: 'flex',
    flex: '0 1 auto',
  },
  '.cm-sticky-head': {
    flex: '0 1 auto',
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  '.cm-sticky-tail': { flex: 'none' },
});

function stickyGeometry(view: EditorView): StickyGeometry {
  const { contentDOM, scaleX, scrollDOM } = view;
  const lineHeight = view.defaultLineHeight;
  // Rectangles, not offsets: offsets round, and the code must line up to the subpixel.
  const contentBox = contentDOM.getBoundingClientRect();
  const left = scrollDOM.getBoundingClientRect().left - scrollDOM.scrollLeft * scaleX;
  const gutterWidth = (contentBox.left - left) / scaleX;
  const numbers = scrollDOM.querySelector<HTMLElement>(':scope > .cm-gutters .cm-lineNumbers');
  return {
    lineHeight,
    paddingTop: view.documentPadding.top,
    rowsMax: stickyRowsMax(scrollDOM.clientHeight, lineHeight),
    gutterWidth,
    // The fold gutter's column stays empty: a pinned line is not a place to fold from.
    numbersWidth: numbers === null ? gutterWidth : (numbers.getBoundingClientRect().right - left) / scaleX - scrollDOM.scrollLeft,
    // Not scrollWidth: the stack is part of that, so it could never shrink.
    width: gutterWidth + contentBox.width / scaleX,
    codeWidth: scrollDOM.clientWidth - gutterWidth,
  };
}

function stickyGeometryChanged(previous: StickyGeometry | undefined, next: StickyGeometry): boolean {
  return previous === undefined || stickyGeometryKey(previous) !== stickyGeometryKey(next);
}

function stickyGeometryKey(geometry: StickyGeometry): string {
  return [geometry.lineHeight, geometry.paddingTop, geometry.rowsMax, geometry.gutterWidth, geometry.numbersWidth, geometry.width, geometry.codeWidth].join(
    ' ',
  );
}

function stickyGutter(lineNumber: number, geometry: StickyGeometry): HTMLElement {
  const gutter = document.createElement('div');
  gutter.className = 'cm-gutters cm-sticky-gutter';
  gutter.style.width = `${geometry.gutterWidth}px`;
  const numbers = document.createElement('div');
  numbers.className = 'cm-lineNumbers';
  const number = document.createElement('div');
  number.className = 'cm-gutterElement';
  number.style.width = `${geometry.numbersWidth}px`;
  number.textContent = String(lineNumber);
  numbers.appendChild(number);
  gutter.appendChild(numbers);
  return gutter;
}

function stickyCode(state: EditorState, block: StickyBlock, geometry: StickyGeometry): HTMLElement {
  const code = document.createElement('div');
  // `cm-line` gives it the padding of the lines below, whatever the theme sets.
  code.className = 'cm-line cm-sticky-code';
  code.style.tabSize = String(state.tabSize);
  const pieces = stickyHeaderPieces(state, block);
  const final = pieces.at(-1);
  assert(final !== undefined, 'stickyCode: a header has a line');
  if (pieces.length === 1) {
    stickyAppendRange(code, state, final.from, Math.min(final.to, final.from + STICKY_LINE_CHARS_MAX));
    return code;
  }
  // A joined header has no line below it to scroll along with, so it fits the editor:
  // the text gives way to an ellipsis, and what opens the block stays at the end.
  code.classList.add('cm-sticky-joined');
  code.style.maxWidth = `${geometry.codeWidth}px`;
  const tailFrom = block.openTo - 1;
  assert(tailFrom >= final.from, 'stickyCode: what opens a block is on the last line of its opening');
  const head = document.createElement('span');
  head.className = 'cm-sticky-head';
  for (const piece of pieces) {
    head.append(piece.separator);
    stickyAppendRange(head, state, piece.from, piece === final ? tailFrom : Math.min(piece.to, piece.from + STICKY_LINE_CHARS_MAX));
  }
  const tail = document.createElement('span');
  tail.className = 'cm-sticky-tail';
  stickyAppendRange(tail, state, tailFrom, Math.min(final.to, tailFrom + STICKY_LINE_CHARS_MAX));
  code.append(head, tail);
  return code;
}

function stickyAppendRange(target: HTMLElement, state: EditorState, from: number, to: number): void {
  const spans = stickyTreeSpans(state, from, to);
  let position = from;
  for (const span of spans) {
    assert(span.from >= position, 'stickyAppendRange: spans run in order without overlap');
    assert(span.to <= to, 'stickyAppendRange: a span stays in its range');
    target.append(state.sliceDoc(position, span.from), stickySpan(state, span));
    position = span.to;
  }
  target.append(state.sliceDoc(position, to));
}

function stickySpan(state: EditorState, span: StickyLineSpan): HTMLElement {
  const element = document.createElement('span');
  element.className = span.className;
  element.textContent = state.sliceDoc(span.from, span.to);
  return element;
}
