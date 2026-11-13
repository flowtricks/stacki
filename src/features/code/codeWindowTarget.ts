import { assert } from '../../../shared/core/assert';
import type { EditorNode } from '../../editor/pageView';
import type { CodeEditorIndentation } from '../../ui/CodeEditor';
import { codeIndentStyleFor } from '../../ui/codeIndentStyle';

export interface CodeWindowState {
  readonly kind?: 'file';
  readonly area?: 'src';
  readonly targetId?: string;
  readonly rel?: string;
  readonly title: string;
  readonly language: string;
  /** How the editor shows it: the inside of a tag is a block, a file that forbids tabs is
   *  spaces, anything else a document. */
  readonly indentation?: CodeEditorIndentation;
  readonly revealLine?: number;
}

/** The page frontmatter: selectable like a node, but it is not one. */
export interface FrontmatterSubject {
  readonly id: 'frontmatter';
  readonly kind: 'frontmatter';
}

export type CodeSubject = EditorNode | FrontmatterSubject;

export const FRONTMATTER_SUBJECT: FrontmatterSubject = { id: 'frontmatter', kind: 'frontmatter' };

// What the floating code editor opens for a subject. Enter, the "Edit code"
// button and a navigator double-click all ask this one rule, so they cannot
// disagree on the title or the language. Markup has no editor of its own: the
// answer is `undefined`, and Enter is left unhandled.
export function codeWindowFor(subject: CodeSubject): CodeWindowState | undefined {
  if (subject.kind === 'frontmatter') {
    // i18n-ignore: `frontmatter` is the Astro term and stays English in every language (docs/i18n-playbook.md, glossary).
    return { targetId: 'frontmatter', title: 'Frontmatter', language: 'javascript' };
  }
  if (subject.kind === 'raw') {
    assert(subject.id.length > 0, 'raw node has an id');
    // The parser matches the tag case-insensitively but keeps it as written,
    // so `<STYLE>` arrives here as "STYLE".
    const language = RAW_CODE_LANGUAGES[subject.name.toLowerCase()];
    assert(language !== undefined, `raw node <${subject.name}> has no code language`);
    return { targetId: subject.id, title: `<${subject.name}>`, language, indentation: 'block' };
  }
  return undefined;
}

// The parser keeps exactly these elements raw (`RAW_ELEMENTS` in
// electron/parse/astroParser.ts), so they are the only ones with a code language.
const RAW_CODE_LANGUAGES: Readonly<Record<string, string>> = {
  script: 'javascript',
  style: 'css',
};

/** The indentation a project file's window edits with: YAML forbids tabs, and a Tab
 *  pressed in a flat file there would write one. */
export function fileWindowIndentation(path: string): Pick<CodeWindowState, 'indentation'> {
  assert(path.length > 0, 'fileWindowIndentation: a file window has a path');
  return codeIndentStyleFor(path) === 'spaces' ? { indentation: 'spaces' } : {};
}
