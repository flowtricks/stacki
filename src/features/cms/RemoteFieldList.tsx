// A connected-CMS item's fields, in order, with its slug kept in step with its
// name: while the sync button beside the slug is pressed, typing the name
// writes the slug it makes (slugSync.ts), saved with the same pause as typing.
// Unpressing it leaves the slug as it is, to be written by hand; pressing it
// again brings it back in step. It starts pressed unless the slug was already
// written by hand, so opening a document never rewrites a slug.
import { useRef, useState } from 'react';
import type { RemoteDocument, RemoteDocumentField } from '../../../shared/properties/cmsRemote';
import type { RemoteValue } from '../../../shared/properties/cmsRemoteSchema';
import { SyncIcon } from '../../ui/Icons';
import { RemoteFieldInput } from './RemoteFieldInput';
import type { RemoteEditContext } from './RemoteValueEditor';
import { slugInStep, slugify, slugPairOf, slugValue, type SlugPair } from './slugSync';

export function RemoteFieldList(props: {
  readonly document: RemoteDocument;
  readonly context: RemoteEditContext;
  readonly onSave: (field: RemoteDocumentField, value: RemoteValue | undefined) => void;
}) {
  const { document } = props;
  const pair = slugPairOf(document.fields);
  const sync = useSlugSync(document, pair);
  return document.fields.map((field) => {
    const input = (
      <RemoteFieldInput
        key={`${document.id}:${field.name}`}
        field={field}
        context={props.context}
        follow={field.name === pair?.slug ? sync.follow : undefined}
        onDraft={field.name === pair?.source ? sync.nameTyped : undefined}
        onSave={(value) => props.onSave(field, value)}
      />
    );
    if (field.name !== pair?.slug) {
      return input;
    }
    return (
      <div key={`${document.id}:${field.name}`} className="remote-cms-slug-sync">
        {input}
        <button
          type="button"
          className={`remote-cms-sync${sync.on ? ' on' : ''}`}
          aria-pressed={sync.on}
          title={sync.on ? 'Slug follows the name: click to edit it by hand' : 'Keep in step'}
          onClick={sync.toggle}
        >
          <SyncIcon size={12} />
        </button>
      </div>
    );
  });
}

// Whether the slug follows the name, and the slug it was last given.
function useSlugSync(document: RemoteDocument, pair: SlugPair | undefined) {
  const valueOf = (name: string | undefined) =>
    document.fields.find((field) => field.name === name)?.value;
  const [on, setOn] = useState(() =>
    pair === undefined ? false : slugInStep(valueOf(pair.source), valueOf(pair.slug)),
  );
  // Nothing is followed until the name is typed, so opening never writes.
  const [follow, setFollow] = useState<{ readonly value: RemoteValue | undefined }>();
  const name = useRef(valueOf(pair?.source));
  const follows = (text: RemoteValue | undefined) =>
    setFollow({ value: slugValue(slugify(typeof text === 'string' ? text : '')) });
  return {
    on,
    follow: on ? follow : undefined,
    nameTyped: (value: RemoteValue | undefined) => {
      name.current = value;
      if (on) {
        follows(value);
      }
    },
    toggle: () => {
      if (!on) {
        follows(name.current);
      }
      setOn(!on);
    },
  };
}
