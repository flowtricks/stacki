// Astro's official editor support is a TextMate grammar with embedded TSX,
// TypeScript, CSS and JSON grammars. Shiki is the small adapter that runs that
// grammar in the browser; a hand-written approximation would drift from the
// Astro VS Code extension whenever Astro adds syntax.

import type { GrammarState } from '@shikijs/core';
import { StateEffect, StateField, type Extension, type Range, type Text } from '@codemirror/state';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { LIMITS } from '../../shared/core/limits';
import { assert } from '../../shared/core/assert';
import type { CodeLine, CodeTokenStyle } from './codeHighlight';
import { lineSlices, nextDocumentLineSlice, yieldToEventLoop } from './codeSlices';

const highlightDelayMs = 60;
// How long a new Astro editor stays hidden waiting for the grammar, rather than
// painting grey text that recolours a moment later. Past it, the text shows plain.
const highlightWaitMsMax = 150;
const fontItalic = 1;
const fontBold = 2;
const fontUnderline = 4;
const fontStrikethrough = 8;
const colorPattern = /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i;
const mutedColorReplacements = {
  '#0db9d7': '#7FA6B8',
  '#41a6b5': '#7FA6B8',
  '#449dab': '#789AAA',
  '#61bdf2': '#86AFC5',
  '#6d91de': '#8799BE',
  '#73daca': '#83ADB3',
  '#7aa2f7': '#879DC4',
  '#7dcfff': '#8CB3C8',
  '#89ddff': '#91B5C6',
  '#914c54': '#927386',
  '#9abdf5': '#94AAC8',
  '#9d7cd8': '#A18EBE',
  '#9ece6a': '#C09B78',
  '#b267e6': '#A586BE',
  '#b4f9f8': '#A6C0C5',
  '#ba3c97': '#AE789F',
  '#bb9af7': '#AA94C0',
  '#db4b4b': '#B17E9B',
  '#de5971': '#B4829B',
  '#e0af68': '#C19D73',
  '#f7768e': '#BF8AA3',
  '#fc7b7b': '#BF8AA3',
  '#ff5370': '#BF8AA3',
  '#ff9e64': '#C99470',
  '#ffdb69': '#C3A477',
} as const;

// One slice of colours: the decorations of `[from, to]` replace whatever that
// stretch of the document held, and the rest of the set is left alone, so a
// page of any length is coloured slice by slice without rebuilding the set.
interface AstroSlice {
  readonly from: number;
  readonly to: number;
  readonly ranges: readonly Range<Decoration>[];
}

const replaceAstroSlice = StateEffect.define<AstroSlice>();
const astroHighlightField = StateField.define<DecorationSet>({
  // Once the grammar is loaded, a new editor's first slice is coloured in its first frame.
  create: (state) => initialAstroDecorations(state.doc),
  update: (decorations, transaction) => {
    let next = transaction.docChanged ? decorations.map(transaction.changes) : decorations;
    for (const effect of transaction.effects) {
      if (effect.is(replaceAstroSlice)) {
        next = next.update({ add: [...effect.value.ranges], filter: () => false, filterFrom: effect.value.from, filterTo: effect.value.to, sort: true });
      }
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

// Whether a new editor is waiting for the grammar. Held in state, not set on the
// DOM, because CodeMirror owns the editor element's class list.
const revealAstroText = StateEffect.define<undefined>();
const astroPendingField = StateField.define<boolean>({
  create: () => highlighterReady === undefined,
  update: (pending, transaction) => (transaction.effects.some((effect) => effect.is(revealAstroText)) ? false : pending),
  provide: (field) => EditorView.editorAttributes.from(field, (pending) => (pending ? { class: 'cm-astro-pending' } : {})),
});

const astroTokenOptions = { lang: 'astro', theme: 'tokyo-night', colorReplacements: mutedColorReplacements } as const;

type AstroToken = { readonly color?: string | undefined; readonly fontStyle?: number | undefined };
type AstroHighlighter = Awaited<ReturnType<typeof createAstroHighlighter>>;
let highlighterPromise: Promise<AstroHighlighter> | undefined;
// The loaded grammar, read synchronously so a first paint can be coloured.
let highlighterReady: AstroHighlighter | undefined;

export const astroHighlight: Extension = [
  // Keep text neutral while Shiki loads instead of flashing basicSetup's fallback colors.
  syntaxHighlighting(HighlightStyle.define([])),
  astroHighlightField,
  astroPendingField,
  EditorView.baseTheme({
    '.cm-astro-token, .cm-astro-token *': {
      color: 'var(--astro-token-color) !important',
    },
    '&.cm-astro-pending .cm-content': {
      visibility: 'hidden',
    },
  }),
  ViewPlugin.fromClass(
    class {
      private generation = 0;
      private timer: ReturnType<typeof setTimeout> | undefined;
      private readonly revealTimer: ReturnType<typeof setTimeout> | undefined;
      private destroyed = false;
      // The grammar's state at the start of some slices already coloured, so an
      // edit resumes from the slice before it instead of the top of the page.
      private checkpoints: Checkpoint[] = [{ offset: 0, state: undefined }];
      // Whether the page has not yet been coloured once from top to bottom: until then
      // a window past the colours has none, so the viewport is coloured out of order.
      private firstPass = true;

      constructor(private readonly view: EditorView) {
        const small = view.state.doc.length <= LIMITS.syntaxHighlightSliceCharsMax;
        if (!view.state.field(astroPendingField) && small) {
          // The grammar coloured the whole document as the state was created.
          this.revealTimer = undefined;
          this.firstPass = false;
          return;
        }
        // While the grammar is loading the text is held back for a bounded
        // wait instead of painting grey and recolouring a moment later.
        if (view.state.field(astroPendingField)) {
          this.revealTimer = setTimeout(() => this.reveal(), highlightWaitMsMax);
        }
        this.schedule(0);
      }

      update(update: ViewUpdate): void {
        if (update.docChanged) {
          let changeStart = update.startState.doc.length;
          update.changes.iterChangedRanges((changeFrom) => {
            changeStart = Math.min(changeStart, changeFrom);
          });
          // Text before the first change is unchanged, so the states saved before it still hold.
          this.checkpoints = this.checkpoints.filter((checkpoint) => checkpoint.offset <= changeStart);
          if (this.checkpoints.length === 0) {
            this.checkpoints = [{ offset: 0, state: undefined }];
          }
          this.schedule(highlightDelayMs);
        } else if (update.viewportChanged && this.firstPass && highlighterReady !== undefined) {
          // A view must not be updated from inside one of its updates.
          const generation = this.generation;
          queueMicrotask(() => this.colourViewport(generation));
        }
      }

      destroy(): void {
        this.destroyed = true;
        this.generation += 1;
        clearTimeout(this.timer);
        clearTimeout(this.revealTimer);
      }

      private reveal(): void {
        clearTimeout(this.revealTimer);
        if (this.destroyed) {
          return;
        }
        if (this.view.state.field(astroPendingField)) {
          this.view.dispatch({ effects: revealAstroText.of(undefined) });
        }
      }

      private schedule(delayMs: number): void {
        assert(delayMs >= 0, 'astroHighlight: a highlight is never scheduled in the past');
        assert(delayMs <= highlightDelayMs, 'astroHighlight: a highlight waits at most one typing pause');
        this.generation += 1;
        const generation = this.generation;
        clearTimeout(this.timer);
        this.timer = setTimeout(() => {
          void this.colourPage(generation)
            .catch((error: unknown) => {
              // Highlighting is presentation, so a grammar failure must not
              // take editing down with it. Keep the plain structural parser.
              console.error('Astro syntax highlighting failed', error);
            })
            .finally(() => this.reveal());
        }, delayMs);
      }

      // The viewport's colours, ahead of the top-to-bottom pass that is still
      // on its way there: the state at the window's first line is unknown, so
      // it starts from the grammar's initial state, and the pass overwrites it
      // with the exact colours when it arrives.
      private colourViewport(generation: number): void {
        const instance = highlighterReady;
        const reached = this.checkpoints.at(-1)?.offset ?? 0;
        if (instance === undefined || this.view.viewport.from <= reached) {
          return;
        }
        const document = this.view.state.doc;
        const start = document.lineAt(this.view.viewport.from).from;
        const slice = nextDocumentLineSlice(document, start, LIMITS.syntaxHighlightSliceCharsMax);
        const coloured = colourSlice(instance, document, slice, undefined);
        if (generation === this.generation && this.view.state.doc === document && this.firstPass && !this.destroyed) {
          this.view.dispatch({ effects: replaceAstroSlice.of(coloured.slice) });
        }
      }

      private async colourPage(generation: number): Promise<void> {
        const instance = await astroHighlighter();
        const document = this.view.state.doc;
        const resumeFrom = this.checkpoints.at(-1);
        assert(resumeFrom !== undefined, 'astroHighlight: a pass has a checkpoint to start from');
        let { offset, state } = resumeFrom;
        this.colourViewport(generation);
        // Each slice starts after the previous one's line break, so a pass makes
        // at most one slice per character of the document.
        for (let steps = 0; steps <= document.length + 1; steps++) {
          const slice = nextDocumentLineSlice(document, offset, LIMITS.syntaxHighlightSliceCharsMax);
          const coloured = colourSlice(instance, document, slice, state);
          if (generation !== this.generation || this.view.state.doc !== document) {
            return;
          }
          this.view.dispatch({ effects: replaceAstroSlice.of(coloured.slice) });
          if (slice.last) {
            this.firstPass = false;
            return;
          }
          offset = slice.end + 1;
          state = coloured.state;
          this.checkpoints.push({ offset, state });
          await yieldToEventLoop();
          if (generation !== this.generation) {
            return;
          }
        }
        assert(false, 'astroHighlight: the document ran out before the slices did');
      }
    },
  ),
];

/**
 * Astro source as lines of coloured tokens, for code that is shown rather than
 * edited: the same grammar and colours as the editor, so a page reads the same
 * in a preview as it does in the Code panel. Resolves once every line is coloured.
 */
export async function astroCodeLines(source: string): Promise<readonly CodeLine[]> {
  const lines: CodeLine[] = [];
  for await (const batch of astroCodeLineBatches(source)) {
    lines.push(...batch);
  }
  return lines;
}

/**
 * The same lines as consecutive batches, one slice of work each with the event
 * loop free between them (AGENTS.md section 10: a batch is bounded by
 * `syntaxHighlightSliceCharsMax`, never by the size of the page). The first
 * batch is the top of the page, so a huge file shows colour at once.
 */
export async function* astroCodeLineBatches(source: string): AsyncGenerator<readonly CodeLine[]> {
  const instance = await astroHighlighter();
  let state: GrammarState | undefined;
  for (const slice of lineSlices(source, 0, LIMITS.syntaxHighlightSliceCharsMax)) {
    const code = source.slice(slice.start, slice.end);
    const tokens = instance.codeToTokensBase(code, withGrammarState(state));
    state = slice.last ? undefined : instance.getLastGrammarState(tokens);
    yield tokens.map((line) => line.map((token) => ({ text: token.content, style: astroCodeStyle(token) })));
    if (!slice.last) {
      await yieldToEventLoop();
    }
  }
}

/**
 * The same lines at once when the grammar has already loaded and the text is
 * one slice or less, so a block's first paint is coloured; undefined while the
 * grammar is still loading, and for longer text, which arrives in batches.
 */
export function astroCodeLinesNow(source: string): readonly CodeLine[] | undefined {
  if (source.length > LIMITS.syntaxHighlightSliceCharsMax || highlighterReady === undefined) {
    return undefined;
  }
  return astroLinesOf(highlighterReady, source);
}

/**
 * Loads the Astro grammar ahead of the first Astro editor or block, so that
 * one paints coloured. Called when a project opens; a failure is reported
 * again, and handled, by the first highlight that needs the grammar.
 */
export async function prefetchAstroHighlighter(): Promise<void> {
  const instance = await astroHighlighter();
  assert(highlighterReady === instance, 'prefetchAstroHighlighter: the loaded grammar is ready to read');
}

function astroLinesOf(instance: AstroHighlighter, source: string): readonly CodeLine[] {
  const lines = instance.codeToTokensBase(source, astroTokenOptions);
  return lines.map((line) => line.map((token) => ({ text: token.content, style: astroCodeStyle(token) })));
}

// The grammar's state where a slice starts, so a slice is tokenised as the
// continuation of the lines before it (a comment or a string left open).
function withGrammarState(state: GrammarState | undefined) {
  return state === undefined ? astroTokenOptions : { ...astroTokenOptions, grammarState: state };
}

interface Checkpoint {
  readonly offset: number;
  readonly state: GrammarState | undefined;
}

// The colours of one slice of the document, and the state the next slice starts in.
function colourSlice(
  instance: AstroHighlighter,
  document: Text,
  slice: { readonly start: number; readonly end: number },
  state: GrammarState | undefined,
): { readonly slice: AstroSlice; readonly state: GrammarState | undefined } {
  const code = document.sliceString(slice.start, slice.end);
  const tokens = instance.codeToTokensBase(code, withGrammarState(state));
  const ranges = tokens.flatMap((line) =>
    line.flatMap((token) => {
      const style = astroTokenStyle(token);
      if (token.content.length === 0 || style.length === 0) {
        return [];
      }
      if (token.offset < 0 || token.offset + token.content.length > code.length) {
        throw new Error('Astro highlighter returned a token outside the document');
      }
      const from = slice.start + token.offset;
      return [Decoration.mark({ class: 'cm-astro-token', attributes: { style } }).range(from, from + token.content.length)];
    }),
  );
  return { slice: { from: slice.start, to: slice.end, ranges }, state: instance.getLastGrammarState(tokens) };
}

// A new editor's colours: none while the grammar loads (the view plugin waits
// for it), and a grammar failure leaves the text plain rather than refusing to
// open the editor. The first slice is coloured at once; the pass in the view
// plugin colours the rest.
function initialAstroDecorations(document: Text): DecorationSet {
  if (highlighterReady === undefined) {
    return Decoration.none;
  }
  try {
    const first = nextDocumentLineSlice(document, 0, LIMITS.syntaxHighlightSliceCharsMax);
    return Decoration.set([...colourSlice(highlighterReady, document, first, undefined).slice.ranges], true);
  } catch (error: unknown) {
    console.error('Astro syntax highlighting failed', error);
    return Decoration.none;
  }
}

function astroTokenStyle(token: AstroToken): string {
  const { color, fontStyle, fontWeight, textDecoration } = astroCodeStyle(token);
  const styles: string[] = [];
  if (color !== undefined) {
    styles.push(`--astro-token-color:${color};color:${color}`);
  }
  if (fontStyle !== undefined) {
    styles.push(`font-style:${fontStyle}`);
  }
  if (fontWeight !== undefined) {
    styles.push(`font-weight:${fontWeight}`);
  }
  if (textDecoration !== undefined) {
    styles.push(`text-decoration:${textDecoration}`);
  }
  return styles.join(';');
}

function astroCodeStyle(token: AstroToken): CodeTokenStyle {
  const flags = token.fontStyle ?? 0;
  const lines = [];
  if ((flags & fontUnderline) !== 0) {
    lines.push('underline');
  }
  if ((flags & fontStrikethrough) !== 0) {
    lines.push('line-through');
  }
  return {
    ...(token.color !== undefined && colorPattern.test(token.color) ? { color: token.color } : {}),
    ...((flags & fontItalic) !== 0 ? { fontStyle: 'italic' } : {}),
    ...((flags & fontBold) !== 0 ? { fontWeight: '700' } : {}),
    ...(lines.length > 0 ? { textDecoration: lines.join(' ') } : {}),
  };
}

function astroHighlighter(): Promise<AstroHighlighter> {
  if (highlighterPromise) {
    return highlighterPromise;
  }
  highlighterPromise = createAstroHighlighter().then(
    (instance) => {
      highlighterReady = instance;
      return instance;
    },
    (error: unknown) => {
      // A failed load is not remembered: the next editor asks again.
      highlighterPromise = undefined;
      throw error;
    },
  );
  return highlighterPromise;
}

async function createAstroHighlighter() {
  // Dynamic imports keep the grammar and regex compiler out of the initial
  // application bundle. They are paid for only when an Astro editor opens.
  const [core, engine, language, theme] = await Promise.all([
    import('@shikijs/core'),
    import('@shikijs/engine-javascript'),
    import('@shikijs/langs/astro'),
    import('@shikijs/themes/tokyo-night'),
  ]);
  return core.createHighlighterCore({
    langs: [language.default],
    themes: [theme.default],
    engine: engine.createJavaScriptRegexEngine(),
  });
}
