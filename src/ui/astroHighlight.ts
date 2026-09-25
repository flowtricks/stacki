// Astro's official editor support is a TextMate grammar with embedded TSX,
// TypeScript, CSS and JSON grammars. Shiki is the small adapter that runs that
// grammar in the browser; a hand-written approximation would drift from the
// Astro VS Code extension whenever Astro adds syntax.

import { StateEffect, StateField, type Extension } from '@codemirror/state';
import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';
import { LIMITS } from '../../shared/limits';

const highlightDelayMs = 60;
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
  create: () => Decoration.none,
  update: (decorations, transaction) => {
    const replacement = transaction.effects.find((effect) => effect.is(replaceAstroHighlight));
    return replacement ? replacement.value : decorations.map(transaction.changes);
  },
  provide: (field) => EditorView.decorations.from(field),
});

type AstroHighlighter = Awaited<ReturnType<typeof createAstroHighlighter>>;
let highlighterPromise: Promise<AstroHighlighter> | undefined;

export const astroHighlight: Extension = [
  astroHighlightField,
  EditorView.baseTheme({
    '.cm-astro-token, .cm-astro-token *': {
      color: 'var(--astro-token-color) !important',
    },
  }),
  ViewPlugin.fromClass(
    class {
      private revision = 0;
      private timer: ReturnType<typeof setTimeout> | undefined;

      constructor(private readonly view: EditorView) {
        this.schedule();
      }

      update(update: ViewUpdate): void {
        if (update.docChanged) {
          this.schedule();
        }
      }

      destroy(): void {
        this.revision += 1;
        clearTimeout(this.timer);
      }

      private schedule(): void {
        this.revision += 1;
        const revision = this.revision;
        clearTimeout(this.timer);
        this.timer = setTimeout(() => {
          void highlightAstro(this.view, revision, () => this.revision).catch((error: unknown) => {
            // Highlighting is presentation, so a grammar failure must not
            // take editing down with it. Keep the plain structural parser.
            console.error('Astro syntax highlighting failed', error);
          });
        }, highlightDelayMs);
      }
    }
  ),
];

async function highlightAstro(
  view: EditorView,
  revision: number,
  currentRevision: () => number
): Promise<void> {
  const source = view.state.doc.toString();
  if (source.length > LIMITS.syntaxHighlightCharsMax) {
    replaceHighlight(view, Decoration.none, revision, currentRevision, source);
    return;
  }
  const instance = await astroHighlighter();
  const lines = instance.codeToTokensBase(source, {
    lang: 'astro',
    theme: 'tokyo-night',
    colorReplacements: mutedColorReplacements,
  });
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
    })
  );
  replaceHighlight(view, Decoration.set(ranges, true), revision, currentRevision, source);
}

function replaceHighlight(
  view: EditorView,
  decorations: DecorationSet,
  revision: number,
  currentRevision: () => number,
  source: string
): void {
  if (revision !== currentRevision()) {
    return;
  }
  if (view.state.doc.toString() !== source) {
    return;
  }
  view.dispatch({ effects: replaceAstroHighlight.of(decorations) });
}

function astroTokenStyle(token: {
  readonly color?: string | undefined;
  readonly fontStyle?: number | undefined;
}): string {
  const styles: string[] = [];
  if (token.color && colorPattern.test(token.color)) {
    styles.push(`--astro-token-color:${token.color};color:${token.color}`);
  }
  const fontStyle = token.fontStyle ?? 0;
  if ((fontStyle & fontItalic) !== 0) {
    styles.push('font-style:italic');
  }
  if ((fontStyle & fontBold) !== 0) {
    styles.push('font-weight:700');
  }
  const lines = [];
  if ((fontStyle & fontUnderline) !== 0) {
    lines.push('underline');
  }
  if ((fontStyle & fontStrikethrough) !== 0) {
    lines.push('line-through');
  }
  if (lines.length > 0) {
    styles.push(`text-decoration:${lines.join(' ')}`);
  }
  return styles.join(';');
}

function astroHighlighter(): Promise<AstroHighlighter> {
  if (highlighterPromise) {
    return highlighterPromise;
  }
  highlighterPromise = createAstroHighlighter();
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
