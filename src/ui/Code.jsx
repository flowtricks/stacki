import React, { useEffect, useRef } from 'react';
import { EditorView } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { javascript } from '@codemirror/lang-javascript';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { LanguageDescription } from '@codemirror/language';
import { appTheme, appHighlight } from './CodeEditor.jsx';

// Code, shown rather than edited.
//
// Anywhere the app puts source in front of someone — the two sides of a merge
// conflict, a file as it was at an old version — it should look the way code
// looks everywhere else in the app. Plain grey text in a <pre> is harder to
// read for exactly the reason highlighting exists, and next to the editor's
// own panes it reads as a different program's output.
//
// The same theme and the same colours as the editor, deliberately: this is
// CodeEditor with everything that makes it an editor taken away. Reusing its
// `appTheme` and `appHighlight` is what keeps a string green in a diff and
// green in the editor, without a second palette to keep in step.

/** The language for a path, by extension. */
export function languageFor(filePath) {
  const ext = String(filePath || '').toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  switch (ext) {
    case 'css':
    case 'scss':
    case 'sass':
    case 'less':
      return 'css';
    case 'md':
    case 'mdx':
      return 'markdown';
    case 'astro':
    case 'html':
    case 'svg':
    case 'vue':
      return 'html';
    case 'json':
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs':
    case 'ts':
    case 'tsx':
      return 'javascript';
    default:
      return null;
  }
}

function extensionFor(language) {
  if (language === 'css') return css();
  // An .astro file is markup with a fenced script at the top and expressions
  // inside it. The HTML parser is the one that gets the tags and attributes
  // right, which is the bulk of what is on screen in this editor's files.
  if (language === 'html') return html({ matchClosingTags: false });
  if (language === 'markdown') {
    return markdown({
      base: markdownLanguage,
      codeLanguages: [
        LanguageDescription.of({ name: 'css', extensions: ['css'], load: async () => css() }),
        LanguageDescription.of({
          name: 'javascript',
          alias: ['js', 'jsx', 'ts', 'tsx'],
          extensions: ['js', 'ts'],
          load: async () => javascript({ typescript: true, jsx: true }),
        }),
      ],
    });
  }
  if (language === 'javascript') return javascript({ typescript: true, jsx: true });
  return null;
}

/**
 * A highlighted, read-only block of code.
 *
 * `language` is given directly or worked out from `filename`. Text in no
 * language this knows still renders — uncoloured, but in the same type at the
 * same size, so a list of snippets does not jump around.
 */
export default function Code({ text, language, filename, maxHeight }) {
  const hostRef = useRef(null);
  const lang = language || languageFor(filename);

  useEffect(() => {
    const ext = extensionFor(lang);
    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({
        doc: String(text ?? ''),
        extensions: [
          // Read-only AND not editable: `readOnly` alone still takes focus and
          // shows a caret, which invites an edit that will not happen.
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          EditorView.lineWrapping,
          appTheme,
          appHighlight,
          ...(ext ? [ext] : []),
        ],
      }),
    });
    return () => view.destroy();
  }, [text, lang]);

  return (
    <div
      ref={hostRef}
      className="code-block"
      style={maxHeight ? { maxHeight, overflow: 'auto' } : undefined}
    />
  );
}
