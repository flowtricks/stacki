// Astro's official editor support is a TextMate grammar with embedded TSX,
// TypeScript, CSS and JSON grammars. Shiki is the small adapter that runs that
// grammar in the browser; a hand-written approximation would drift from the
// Astro VS Code extension whenever Astro adds syntax.

import { StateEffect, StateField, type Extension } from '@codemirror/state';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { LIMITS } from '../../shared/core/limits';
import { assert } from '../../shared/core/assert';
import { plainCodeLines, type CodeLine, type CodeTokenStyle } from './codeHighlight';

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

const replaceAstroHighlight = StateEffect.define<DecorationSet>();
const astroHighlightField = StateField.define<DecorationSet>({
  // Once the grammar is loaded, a new editor is coloured in its first frame.
  create: (state) => initialAstroDecorations(state.doc.toString()),
  update: (decorations, transaction) => {
    const replacement = transaction.effects.find((effect) => effect.is(replaceAstroHighlight));
    return replacement ? replacement.value : decorations.map(transaction.changes);
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
      private revision = 0;
      private timer: ReturnType<typeof setTimeout> | undefined;
      private readonly revealTimer: ReturnType<typeof setTimeout> | undefined;
      private destroyed = false;

      constructor(private readonly view: EditorView) {
        if (!view.state.field(astroPendingField)) {
          // The grammar coloured the document as the state was created.
          this.revealTimer = undefined;
          return;
        }
        // The grammar is still loading: the text is held back for a bounded
        // wait instead of painting grey and recolouring a moment later.
        this.revealTimer = setTimeout(() => this.reveal(), highlightWaitMsMax);
        this.schedule(0);
      }

      update(update: ViewUpdate): void {
        if (update.docChanged) {
          this.schedule(highlightDelayMs);
        }
      }

      destroy(): void {
        this.destroyed = true;
        this.revision += 1;
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
        this.revision += 1;
        const revision = this.revision;
        clearTimeout(this.timer);
        this.timer = setTimeout(() => {
          void highlightAstro(this.view, revision, () => this.revision)
            .catch((error: unknown) => {
              // Highlighting is presentation, so a grammar failure must not
              // take editing down with it. Keep the plain structural parser.
              console.error('Astro syntax highlighting failed', error);
            })
            .finally(() => this.reveal());
        }, delayMs);
      }
    },
  ),
];

/**
 * Astro source as lines of coloured tokens, for code that is shown rather than
 * edited: the same grammar and colours as the editor, so a page reads the same
 * in a preview as it does in the Code panel.
 */
export async function astroCodeLines(source: string): Promise<readonly CodeLine[]> {
  if (source.length > LIMITS.syntaxHighlightCharsMax) {
    return plainCodeLines(source);
  }
  const instance = await astroHighlighter();
  return astroLinesOf(instance, source);
}

/**
 * The same lines at once when the grammar has already loaded, so a block's
 * first paint is coloured; undefined while it is still loading.
 */
export function astroCodeLinesNow(source: string): readonly CodeLine[] | undefined {
  if (source.length > LIMITS.syntaxHighlightCharsMax) {
    return plainCodeLines(source);
  }
  return highlighterReady === undefined ? undefined : astroLinesOf(highlighterReady, source);
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

async function highlightAstro(view: EditorView, revision: number, currentRevision: () => number): Promise<void> {
  const source = view.state.doc.toString();
  if (source.length > LIMITS.syntaxHighlightCharsMax) {
    replaceHighlight(view, Decoration.none, revision, source, currentRevision);
    return;
  }
  const instance = await astroHighlighter();
  replaceHighlight(view, astroDecorations(instance, source), revision, source, currentRevision);
}

// A new editor's colours: none while the grammar loads (the view plugin waits
// for it), and a grammar failure leaves the text plain rather than refusing to
// open the editor.
function initialAstroDecorations(source: string): DecorationSet {
  if (highlighterReady === undefined) {
    return Decoration.none;
  }
  try {
    return astroDecorations(highlighterReady, source);
  } catch (error: unknown) {
    console.error('Astro syntax highlighting failed', error);
    return Decoration.none;
  }
}

// The grammar's colours for `source`, as editor decorations.
function astroDecorations(instance: AstroHighlighter, source: string): DecorationSet {
  if (source.length > LIMITS.syntaxHighlightCharsMax) {
    return Decoration.none;
  }
  const lines = instance.codeToTokensBase(source, astroTokenOptions);
  const ranges = lines.flatMap((line) =>
    line.flatMap((token) => {
      const to = token.offset + token.content.length;
      const style = astroTokenStyle(token);
      if (token.content.length === 0 || style.length === 0) {
        return [];
      }
      if (token.offset < 0 || to > source.length) {
        throw new Error('Astro highlighter returned a token outside the document');
      }
      return [
        Decoration.mark({
          class: 'cm-astro-token',
          attributes: { style },
        }).range(token.offset, to),
      ];
    }),
  );
  return Decoration.set(ranges, true);
}

function replaceHighlight(view: EditorView, decorations: DecorationSet, revision: number, source: string, currentRevision: () => number): void {
  if (revision !== currentRevision()) {
    return;
  }
  if (view.state.doc.toString() !== source) {
    return;
  }
  view.dispatch({ effects: replaceAstroHighlight.of(decorations) });
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
