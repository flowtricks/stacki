import { assert } from '../../shared/core/assert';
import { CANVAS_TEXT_LIMIT } from '../../shared/properties/canvasText';
import { selectRunsOffsets, type TextOffsets, type TextSpace } from './frameTextSelection';

interface TextState {
  readonly texts: readonly string[];
  readonly selection: TextOffsets;
}

/** A run whose words differ from the ones it opened with. */
export interface TextRunChange {
  readonly run: number;
  readonly value: string;
}

export function createTextBuffer(root: HTMLElement, space: TextSpace, changed: (value: string) => void = () => {}) {
  assert(space.runs[space.primary] !== undefined, 'The opened run is one of the editor runs');
  const nodes = space.runs.flat();
  const structure = captureStructure(root, nodes);
  if (!structure) {
    return undefined;
  }
  const seams = seamsOf(space);
  const original = nodes.map((node) => node.data);
  let rendered: readonly string[] = original;
  let history: readonly TextState[] = [{ texts: original, selection: { start: 0, end: 0 } }];
  let index = 0;
  const intact = () => structure.intact() && nodes.every((node, position) => node.data === rendered[position]);
  const write = (texts: readonly string[]) => {
    writeTexts(nodes, texts);
    rendered = texts;
  };
  const primaryText = () => runTexts(space, rendered)[space.primary] ?? '';
  const changes = (): readonly TextRunChange[] => {
    const before = runTexts(space, original);
    return runTexts(space, rendered).flatMap((value, run) => (value === before[run] ? [] : [{ run, value }]));
  };
  const remember = (selection: TextOffsets) => {
    // Bound per-session undo memory: 64 text snapshots of at most 10,000 characters.
    history = [...history.slice(0, index + 1), { texts: rendered, selection }].slice(-64);
    index = history.length - 1;
  };
  return {
    intact,
    changes,
    // Words changed outside the opened run: a save of that run alone would lose them.
    spread: () => changes().some((change) => change.run !== space.primary),
    // Where the opened run lies, for select all.
    primaryRange: () => runRanges(space, rendered)[space.primary] ?? { start: 0, end: 0 },
    crosses: (range: TextOffsets) => runWords(space, rendered, range) === undefined,
    // The source's own words in a range inside one run; undefined across runs.
    words: (range: TextOffsets) => runWords(space, rendered, range),
    // The original words back; `keep` shows the typed ones again once a save is checked.
    restore: () => closeTextBuffer(original, rendered, { intact, write }),
    replace: (range: TextOffsets, text: string) => {
      if (!intact()) {
        return;
      }
      const next = replaceText(rendered, seams, range, text);
      // Deleting across only a seam changes no words: a <br> is not text to delete.
      if (next.join('').length > CANVAS_TEXT_LIMIT || next.every((value, position) => value === rendered[position])) {
        return;
      }
      history = history.map((entry, position) => (position === index ? { texts: entry.texts, selection: range } : entry));
      write(next);
      const selection = { start: range.start + text.length, end: range.start + text.length };
      remember(selection);
      selectRunsOffsets(space.runs, selection);
      changed(primaryText());
    },
    composition: () => {
      const texts = nodes.map((node) => node.data);
      if (!structure.intact() || texts.join('').length > CANVAS_TEXT_LIMIT) {
        return false;
      }
      rendered = texts;
      changed(primaryText());
      return true;
    },
    remember,
    rollbackNative: () => {
      structure.restore();
      write(rendered);
    },
    history: (direction: 'undo' | 'redo') => {
      const next = index + (direction === 'undo' ? -1 : 1);
      const state = history[next];
      if (intact() && state) {
        index = next;
        write(state.texts);
        selectRunsOffsets(space.runs, state.selection);
        changed(primaryText());
      }
    },
  };
}

function closeTextBuffer(
  original: readonly string[],
  typed: readonly string[],
  buffer: { readonly intact: () => boolean; readonly write: (texts: readonly string[]) => void },
) {
  const restored = restoreTextBuffer(original, buffer.intact, buffer.write);
  assert(!restored || buffer.intact(), 'A restored buffer is intact');
  return { restored, keep: () => void restoreTextBuffer(typed, buffer.intact, buffer.write) };
}

// Writes whole words back into the editor's text nodes, unless the page has
// replaced them since: the original on close, or the typed words after a save.
function restoreTextBuffer(texts: readonly string[], intact: () => boolean, write: (texts: readonly string[]) => void): boolean {
  if (!intact()) {
    return false;
  }
  write(texts);
  return true;
}

// The node positions that end a run, before the last: each is followed by a seam.
function seamsOf(space: TextSpace): ReadonlySet<number> {
  const seams = new Set<number>();
  let position = 0;
  for (const run of space.runs.slice(0, -1)) {
    position += run.length;
    seams.add(position - 1);
  }
  return seams;
}

function runTexts(space: TextSpace, texts: readonly string[]): readonly string[] {
  let position = 0;
  return space.runs.map((run) => {
    const start = position;
    position += run.length;
    return texts.slice(start, position).join('');
  });
}

function runRanges(space: TextSpace, texts: readonly string[]): readonly TextOffsets[] {
  let position = 0;
  return runTexts(space, texts).map((text) => {
    const start = position;
    position += text.length + 1;
    return { start, end: start + text.length };
  });
}

function runWords(space: TextSpace, texts: readonly string[], range: TextOffsets): string | undefined {
  const run = runRanges(space, texts).findIndex((entry) => entry.start <= range.start && range.end <= entry.end);
  const bounds = runRanges(space, texts)[run];
  return bounds && runTexts(space, texts)[run]?.slice(range.start - bounds.start, range.end - bounds.start);
}

function replaceText(texts: readonly string[], seams: ReadonlySet<number>, range: TextOffsets, insert: string): string[] {
  assert(Number.isSafeInteger(range.start), 'Text selection start must be an integer');
  assert(Number.isSafeInteger(range.end), 'Text selection end must be an integer');
  assert(range.start >= 0, 'Text selection start must not be negative');
  assert(range.end >= range.start, 'Text selection must be ordered');
  assert(range.end <= texts.join('').length + seams.size, 'Text selection must stay inside its segment');
  let position = 0;
  let inserted = false;
  return texts.map((text, node) => {
    const start = position;
    const end = start + text.length;
    position = end + (seams.has(node) ? 1 : 0);
    if (end < range.start || start > range.end) {
      return text;
    }
    const prefix = text.slice(0, Math.max(0, range.start - start));
    const suffix = text.slice(Math.max(0, range.end - start));
    const replacement = inserted ? '' : insert;
    inserted = true;
    return prefix + replacement + suffix;
  });
}

function captureStructure(root: HTMLElement, nodes: readonly Text[]) {
  assert(nodes.length > 0, 'Text editing requires a matched text node');
  assert(
    nodes.every((node) => root.contains(node)),
    'Text nodes must belong to the editor',
  );
  const pending: Node[] = [root];
  const structure: {
    readonly node: Node;
    readonly children: readonly ChildNode[];
    readonly text: string | undefined;
  }[] = [];
  for (let count = 0; pending.length && count < 1_000; count++) {
    const node = pending.pop();
    if (!node) {
      break;
    }
    if (node.childNodes.length + pending.length + structure.length > 1_000) {
      return undefined;
    }
    const children = Array.from(node.childNodes);
    structure.push({ node, children, text: node instanceof Text ? node.data : undefined });
    pending.push(...children);
  }
  if (pending.length) {
    return undefined;
  }
  return {
    intact: () =>
      structure.every(
        ({ node, children, text }) =>
          node.isConnected &&
          children.length === node.childNodes.length &&
          children.every((child, position) => node.childNodes[position] === child) &&
          (text === undefined || (node instanceof Text && nodes.includes(node)) || node.textContent === text),
      ),
    restore: () => {
      // Called only for a native composition input whose preceding beforeinput
      // validated this structure. Restore node identity instead of serializing HTML.
      for (const { node, children, text } of structure) {
        if (
          node instanceof Element &&
          (node.childNodes.length !== children.length || children.some((child, position) => node.childNodes[position] !== child))
        ) {
          node.replaceChildren(...children);
        }
        if (node instanceof Text && text !== undefined && !nodes.includes(node)) {
          node.data = text;
        }
      }
    },
  };
}

function writeTexts(nodes: readonly Text[], texts: readonly string[]) {
  for (const [position, node] of nodes.entries()) {
    const value = texts[position];
    if (value !== undefined && node.data !== value) {
      node.data = value;
    }
  }
}
