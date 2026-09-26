import { assert } from '../shared/assert';
import type { CodeWindowState, EditorNode } from './appTypes';

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
    return { targetId: 'frontmatter', title: 'Frontmatter', language: 'javascript' };
  }
  if (subject.kind === 'raw') {
    assert(subject.id.length > 0, 'raw node has an id');
    // The parser matches the tag case-insensitively but keeps it as written,
    // so `<STYLE>` arrives here as "STYLE".
    const language = RAW_CODE_LANGUAGES[subject.name.toLowerCase()];
    assert(language !== undefined, `raw node <${subject.name}> has no code language`);
    return { targetId: subject.id, title: `<${subject.name}>`, language };
  }
  return undefined;
}

// The parser keeps exactly these elements raw (`RAW_ELEMENTS` in
// electron/astroParser.ts), so they are the only ones with a code language.
const RAW_CODE_LANGUAGES: Readonly<Record<string, string>> = {
  script: 'javascript',
  style: 'css',
};
