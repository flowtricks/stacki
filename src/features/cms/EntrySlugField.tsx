// An Astro content entry's Slug field, first in its editor as a site builder
// puts it: the editable last segment of the entry's id (entrySlug.ts).
//
// What is typed is checked on every keystroke against the other slugs in the
// entry's folder, so "Another item already uses this slug" shows before focus
// leaves; text that is not already a slug says what it will be saved as. The
// rename is committed on Enter or blur, never per keystroke, because renaming an
// id moves a file and rewrites every reference to it. Escape puts the stored
// slug back. An id the panel cannot rename (a loader that builds ids in code)
// shows read-only, with why. What is typed belongs to one entry, so a form that
// moves to another entry gives this field a new key: the slugs beside an entry
// include the entry before it, and text carried over reads as already taken.
import { useContext, useEffect, useState } from 'react';
import { checkEntrySlug, ENTRY_SLUG_LIMITS, slugNote, slugProblem, type EntrySlug } from '../../../shared/properties/entrySlug';
import { TagIcon } from '../../ui/Icons';
import { CmsFieldFrame } from './CmsPropField';
import { committable } from './entrySlugDraft';
import { FieldChecksContext } from './remoteCmsShared';

const SLUG_HELP = 'The entry’s id: its file name, and what references and getEntry() calls name it by.';

export function EntrySlugField(props: {
  readonly slug: EntrySlug;
  /** The text shown; the stored slug when absent. A new item's slug is held by its form. */
  readonly text?: string | undefined;
  /** What the field says when it is empty; a new item is named for it when left so. */
  readonly placeholder?: string | undefined;
  readonly onType?: ((text: string) => void) | undefined;
  /** A slug that passed its check and differs from the stored one. */
  readonly onCommit: (slug: string) => void;
}) {
  const { slug } = props;
  const checks = useContext(FieldChecksContext);
  const [typed, setTyped] = useState(slug.value);
  // A stored slug that changed (a rename, a reload) replaces what was typed.
  useEffect(() => setTyped(slug.value), [slug.value]);
  const text = props.text ?? typed;
  if (slug.rename.kind === 'locked') {
    return (
      <div className="remote-cms-field entry-slug-field" data-kind="slug">
        <CmsFieldFrame name="Slug" help={`${SLUG_HELP} ${slug.rename.reason}`} icon={<TagIcon size={12} />} set={slug.value !== ''}>
          <div className="remote-cms-locked">{`${slug.folder}${slug.value}`}</div>
        </CmsFieldFrame>
        <span className="remote-cms-problem is-note">{slug.rename.reason}</span>
      </div>
    );
  }
  const check = checkEntrySlug(text, { taken: slug.taken });
  const blank = text === '' && props.placeholder !== undefined;
  // An entry only held on screen is not being edited, and its slug is not checked.
  const problem = blank || checks === 'held' ? undefined : slugProblem(check);
  const note = slugNote(check);
  const type = (next: string) => {
    setTyped(next);
    props.onType?.(next);
  };
  const commit = () => {
    const slugged = committable(check, slug.value);
    if (slugged !== undefined) {
      props.onCommit(slugged);
    }
  };
  return (
    <div className={`remote-cms-field entry-slug-field is-required${problem === undefined ? '' : ' is-invalid'}`} data-kind="slug">
      <CmsFieldFrame name="Slug" help={SLUG_HELP} icon={<TagIcon size={12} />} set={text !== ''}>
        <div className="entry-slug-input">
          {slug.folder !== '' && <span className="entry-slug-folder">{slug.folder}</span>}
          <input
            value={text}
            type="text"
            spellCheck={false}
            aria-invalid={problem !== undefined}
            placeholder={props.placeholder}
            // Room past the bound, so a slug that is too long can be seen and cut.
            maxLength={ENTRY_SLUG_LIMITS.charsMax * 2}
            onChange={(event) => type(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                commit();
              } else if (event.key === 'Escape') {
                type(slug.value);
              }
            }}
          />
        </div>
      </CmsFieldFrame>
      {problem !== undefined && <span className="remote-cms-problem is-error">{problem}</span>}
      {problem === undefined && note !== undefined && <span className="remote-cms-problem is-note">{note}</span>}
    </div>
  );
}
