// A connected-CMS item's fields, in order, with its slug kept in step with its
// name: while the sync button beside the slug is pressed, typing the name
// writes the slug it makes (slugSync.ts), saved with the same pause as typing.
// Unpressing it leaves the slug as it is, to be written by hand; pressing it
// again brings it back in step. It starts pressed unless the slug was already
// written by hand, so opening a document never rewrites a slug.
//
// A document whose schema groups its fields shows them in tabs, as Sanity
// Studio does: all fields first, then each group. It opens on all fields; a
// chosen tab stays chosen for the next document shown that has it, so a run
// of edits to one group does not mean choosing it again on every item.
import { useLayoutEffect, useRef, useState } from 'react';
import type { RemoteDocument, RemoteDocumentField, RemoteFieldGroup } from '../../../shared/properties/cmsRemote';
import type { RemoteValue } from '../../../shared/properties/cmsRemoteSchema';
import { assert } from '../../../shared/core/assert';
import { SyncIcon } from '../../ui/Icons';
import { RemoteFieldInput } from './RemoteFieldInput';
import type { RemoteEditContext } from './RemoteValueEditor';
import { slugInStep, slugify, slugPairOf, slugValue, type SlugPair } from './slugSync';

export function RemoteFieldList(props: {
  readonly document: RemoteDocument;
  readonly context: RemoteEditContext;
  /** The required fields that say so while empty; none when absent. */
  readonly requiredShown?: ReadonlySet<string> | undefined;
  readonly onSave: (field: RemoteDocumentField, value: RemoteValue | undefined) => void;
}) {
  const { document } = props;
  const pair = slugPairOf(document.fields);
  const sync = useSlugSync(document, pair);
  const [chosen, setChosen] = useState<string | undefined>(undefined);
  const tab = shownTab(document.fieldGroups, chosen);
  const fields = tab === ALL_FIELDS ? document.fields : document.fields.filter((field) => field.groups?.includes(tab) === true);
  const inputs = fields.map((field) => {
    const input = (
      <RemoteFieldInput
        key={`${document.id}:${field.name}`}
        field={field}
        context={props.context}
        follow={field.name === pair?.slug ? sync.follow : undefined}
        onDraft={field.name === pair?.source ? sync.nameTyped : undefined}
        requiredShown={props.requiredShown?.has(field.name) === true}
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
  if (document.fieldGroups === undefined) {
    return inputs;
  }
  return (
    <>
      <FieldGroupTabs fieldGroups={document.fieldGroups} tab={tab} onTab={setChosen} />
      {inputs}
    </>
  );
}

// Sanity Studio's own name for the tab that shows every field.
const ALL_FIELDS = 'all-fields';

// The tab chosen, while this document has it; otherwise all fields.
function shownTab(fieldGroups: readonly RemoteFieldGroup[] | undefined, chosen: string | undefined): string {
  if (fieldGroups === undefined) {
    return ALL_FIELDS;
  }
  if (fieldGroups.some((group) => group.name === chosen)) {
    assert(chosen !== undefined, 'A shown group was chosen');
    return chosen;
  }
  return ALL_FIELDS;
}

/** Where the active tab sits in its list, for the background that slides to it. */
interface TabPlace {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

function FieldGroupTabs(props: { readonly fieldGroups: readonly RemoteFieldGroup[]; readonly tab: string; readonly onTab: (tab: string) => void }) {
  const tabs = [{ name: ALL_FIELDS, title: 'All fields' }, ...props.fieldGroups];
  const list = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<TabPlace | undefined>(undefined);
  // Measured after layout, and again whenever the list resizes and its tabs
  // wrap or move, so the background always sits under the active tab.
  useLayoutEffect(() => {
    const element = list.current;
    if (element === null) {
      return undefined;
    }
    const measure = () => {
      const active = element.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
      setPlace(active === null ? undefined : { left: active.offsetLeft, top: active.offsetTop, width: active.offsetWidth, height: active.offsetHeight });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [props.tab]);
  assert(
    tabs.some((group) => group.name === props.tab),
    'The active tab is one of the tabs',
  );
  return (
    <div ref={list} className="remote-cms-groups" role="tablist">
      {/* Mounted at its first place, so it slides only between tabs, never in from the corner. */}
      {place && (
        <span
          className="remote-cms-groups-mark"
          aria-hidden="true"
          style={{ width: place.width, height: place.height, transform: `translate(${place.left}px, ${place.top}px)` }}
        />
      )}
      {tabs.map((group) => (
        <button key={group.name} type="button" role="tab" aria-selected={group.name === props.tab} onClick={() => props.onTab(group.name)}>
          {group.title}
        </button>
      ))}
    </div>
  );
}

// Whether the slug follows the name, and the slug it was last given.
function useSlugSync(document: RemoteDocument, pair: SlugPair | undefined) {
  const valueOf = (name: string | undefined) => document.fields.find((field) => field.name === name)?.value;
  const [on, setOn] = useState(() => (pair === undefined ? false : slugInStep(valueOf(pair.source), valueOf(pair.slug))));
  // Nothing is followed until the name is typed, so opening never writes.
  const [follow, setFollow] = useState<{ readonly value: RemoteValue | undefined }>();
  const name = useRef(valueOf(pair?.source));
  const follows = (text: RemoteValue | undefined) => setFollow({ value: slugValue(slugify(typeof text === 'string' ? text : '')) });
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
