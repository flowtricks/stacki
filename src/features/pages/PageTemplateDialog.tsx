// Creating a page template without writing code: choose where the entries come
// from, and the page that shows one of them is written for you. The form shows
// every file it will write before anything happens, and a secret is saved only
// to the project's git-ignored .env, never to the page.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ScanComponent } from '../../../shared/properties/projectScan';
import { SANITY_TOKEN_ENV, parseSourceURL, parseTemplateRoute } from '../../../shared/properties/pageTemplate';
import { createCoalescedRun, type CoalescedRun } from '../../lib/coalescedRun';
import type {
  ConnectionKeyCopy,
  EnvStatus,
  PageTemplateChange,
  PageTemplateDraft,
  PageTemplatePlan,
  SampleField,
  SampleList,
} from '../../../shared/properties/pageTemplate';
import { readContentCollections, type AppCollection } from '../../ipc/appBridge';
import { listCmsConnections } from '../../ipc/cmsConnectionsBridge';
import { planPageTemplate, sampleDataSource, setProjectEnv } from '../../ipc/pageTemplateBridge';
import { CodeBlock } from '../../ui/CodeBlock';
import Dropdown from '../../ui/Dropdown';
import { AstroIcon, BracesIcon, CmsIcon, PlusIcon, RefreshIcon, SanityIcon, TrashIcon } from '../../ui/Icons';
import Popup from '../../ui/Popup';
import {
  EMPTY_TEMPLATE_FORM,
  ENTRY_ID,
  NEW_COLLECTION,
  UNEXPECTED_FAILURE,
  addressExample,
  connectionKeyCopy,
  fieldsAfterDeselect,
  fieldsSummary,
  headersOf,
  pagePreview,
  unfinishedQuietly,
  slugTreatmentOf,
  suggestedRoute,
  suggestedSlugPath,
  templateDraft,
  templateFields,
  toggledFields,
  withFirstCollection,
  withHeaderRow,
  withSampleList,
  withSampleLists,
  withSanityConnection,
  type HeaderRow,
  type SanityConnection,
  type SourceKind,
  type TemplateForm,
} from './pageTemplateForm';
import { DetailPopover, SampleTree } from './SampleTree';
import './pageTemplate.css';

// A pause in typing before the files are worked out again, each plan being a read of the project.
const PLAN_DELAY_MS = 250;
// A pause in typing long enough to mean the address is finished.
const SAMPLE_DELAY_MS = 600;

type Sampling = { readonly kind: 'idle' } | { readonly kind: 'loading' } | { readonly kind: 'failed'; readonly message: string };
type Planning = { readonly kind: 'none' } | { readonly kind: 'ready'; readonly plan: PageTemplatePlan } | { readonly kind: 'failed'; readonly message: string };
type SetForm = (change: (form: TemplateForm) => TemplateForm) => void;

/** Draws the app's connect-Sanity popup; pages know nothing of how a connection is made. */
export type ConnectSanity = (input: { readonly projectPath: string; readonly close: () => void }) => ReactNode;

interface PageTemplateDialogProps {
  readonly projectPath: string;
  readonly layouts: readonly ScanComponent[];
  readonly onClose: () => void;
  readonly connectSanity: ConnectSanity;
  /** Creates the template, answering what went wrong, if anything. */
  readonly onCreate: (draft: PageTemplateDraft, keyCopy: ConnectionKeyCopy | undefined) => Promise<string | undefined>;
}

export function PageTemplateDialog({ projectPath, layouts, onClose, onCreate, connectSanity }: PageTemplateDialogProps) {
  const [form, setForm] = useState<TemplateForm>({ ...EMPTY_TEMPLATE_FORM, layout: layouts.at(0)?.name ?? '' });
  // Undefined until read, so the form does not call a project empty while it is still asking.
  const [collections, setCollections] = useState<readonly AppCollection[] | undefined>(undefined);
  // Red is for something a person did: an untouched form has nothing to correct yet.
  const [touched, setTouched] = useState(false);
  const [connections, setConnections] = useState<readonly SanityConnection[] | undefined>(undefined);
  const [planning, setPlanning] = useState<Planning>({ kind: 'none' });
  const [showCode, setShowCode] = useState(false);
  // The fetched list the page is built from, for the preview.
  const [sample, setSample] = useState<SampleList | undefined>(undefined);
  const [creating, setCreating] = useState<{ readonly kind: 'idle' } | { readonly kind: 'busy' } | { readonly kind: 'failed'; readonly message: string }>({
    kind: 'idle',
  });
  const set: SetForm = (change) => {
    setTouched(true);
    setForm(change);
  };
  // A new source is a fresh set of empty fields, so it starts untouched too.
  const setSource: SetForm = (change) => {
    setTouched(false);
    setForm(change);
  };

  useEffect(() => {
    let live = true;
    readContentCollections(projectPath)
      .then((listed) => {
        if (live) {
          setCollections(listed);
          setForm((previous) =>
            withFirstCollection(
              previous,
              listed.map((item) => item.name),
            ),
          );
        }
      })
      .catch(() => {
        if (live) {
          setCollections([]);
        }
      });
    return () => {
      live = false;
    };
  }, [projectPath]);

  const refreshConnections = useCallback(() => {
    listCmsConnections(projectPath)
      .then((listed) => setConnections(listed.connections.flatMap((connection) => (connection.kind === 'sanity' ? [connection] : []))))
      .catch(() => setConnections([]));
  }, [projectPath]);
  useEffect(refreshConnections, [refreshConnections]);
  // A connection is used as soon as there is one: on opening, or on coming back
  // from connecting, when everything else in the form stays as it was.
  useEffect(() => {
    const [first] = connections ?? [];
    setForm((previous) => {
      const kept = connections?.some((connection) => connection.id === previous.connectionId) === true;
      return first === undefined || kept ? previous : withSanityConnection(previous, first);
    });
  }, [connections]);

  const layout = useMemo(() => {
    const found = layouts.find((candidate) => candidate.name === form.layout);
    return found === undefined ? undefined : { name: found.name, path: found.path };
  }, [form.layout, layouts]);
  const draft = useMemo(() => templateDraft(form, layout), [form, layout]);

  useEffect(() => {
    if (!draft.ok) {
      setPlanning({ kind: 'none' });
      return undefined;
    }
    let live = true;
    const timer = setTimeout(() => {
      planPageTemplate(projectPath, draft.value)
        .then((answer) => {
          if (live) {
            setPlanning(answer.ok ? { kind: 'ready', plan: answer.value } : { kind: 'failed', message: answer.message });
          }
        })
        .catch((error: unknown) => {
          if (live) {
            setPlanning({ kind: 'failed', message: requestProblem(error) });
          }
        });
    }, PLAN_DELAY_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [draft, projectPath]);

  const create = async (): Promise<void> => {
    if (!draft.ok) {
      return;
    }
    setCreating({ kind: 'busy' });
    let failure: string | undefined;
    try {
      failure = await onCreate(draft.value, planning.kind === 'ready' ? connectionKeyCopy(form, planning.plan.env) : undefined);
    } catch (error: unknown) {
      failure = requestProblem(error);
    }
    setCreating(failure === undefined ? { kind: 'idle' } : { kind: 'failed', message: failure });
    if (failure === undefined) {
      onClose();
    }
  };
  // A plan's refusal explains why Create is off, so it shows even untouched, as a note rather than an error.
  const refused = creating.kind === 'failed' ? creating.message : planning.kind === 'failed' ? planning.message : undefined;
  const invalid = draft.ok || !touched || unfinishedQuietly(form) ? undefined : draft.error;
  const problem = refused ?? invalid;
  const problemClass = touched || creating.kind === 'failed' ? 'page-template-problem' : 'hint-text';
  const ready = planning.kind === 'ready' && creating.kind !== 'busy';

  return (
    <Popup className="modal page-template-dialog" label="Create page template" onClose={onClose} dismissible>
      {({ close }) => (
        <>
          <div className="modal-header">Create page template</div>
          {showCode && planning.kind === 'ready' ? (
            <PlannedFiles changes={planning.plan.changes} />
          ) : (
            <div className="modal-body">
              <SourceKindField form={form} set={setSource} />
              {form.kind === 'content-collection' && (
                <ContentFields projectPath={projectPath} form={form} set={set} collections={collections} onSample={setSample} />
              )}
              {form.kind === 'sanity' && (
                <SanityFields
                  projectPath={projectPath}
                  form={form}
                  set={set}
                  update={setForm}
                  connections={connections}
                  refresh={refreshConnections}
                  connectSanity={connectSanity}
                  onSample={setSample}
                />
              )}
              {form.kind === 'http-json' && <HttpFields projectPath={projectPath} form={form} set={set} update={setForm} onSample={setSample} />}
              {form.route.length > 0 && <AddressPreview form={form} set={set} sample={sample} />}
              {/* One layout is simply used, and none leaves a plain page: only a real choice is asked. */}
              {layouts.length > 1 && (
                <div>
                  <label>Layout</label>
                  <Dropdown
                    livePreview={false}
                    value={form.layout}
                    options={layouts.map((item) => ({ value: item.name, label: item.name }))}
                    onChange={(value) => set((previous) => ({ ...previous, layout: value }))}
                  />
                </div>
              )}
              {planning.kind === 'ready' && <EnvNotes form={form} env={planning.plan.env} set={set} />}
              {problem !== undefined && <p className={problemClass}>{problem}</p>}
            </div>
          )}
          <div className="modal-footer">
            <button
              className={`page-template-code-toggle ${showCode ? 'is-on' : ''}`}
              title="Show the code that will be written"
              aria-pressed={showCode}
              disabled={planning.kind !== 'ready'}
              onClick={() => setShowCode((shown) => !shown)}
            >
              <BracesIcon size={13} />
            </button>
            <button onClick={close}>Cancel</button>
            <button className="primary" disabled={!ready} onClick={() => void create()}>
              Create template
            </button>
          </div>
        </>
      )}
    </Popup>
  );
}

// The page a designer will get, in words, with the address pattern a click away.
function AddressPreview({ form, set, sample }: { readonly form: TemplateForm; readonly set: SetForm; readonly sample: SampleList | undefined }) {
  // The route and its origin as they were when editing began, for Escape.
  const [editing, setEditing] = useState<Pick<TemplateForm, 'route' | 'routeSource'> | undefined>(undefined);
  // A route that cannot work stays open, with the form's error beneath it.
  const finish = (): void => {
    if (parseTemplateRoute(form.route).ok) {
      setEditing(undefined);
    }
  };
  const preview = sample === undefined ? undefined : pagePreview(form, sample);
  const address = preview?.address ?? `yoursite.com${addressExample(form.route, '…')}`;
  return (
    <div className="page-template-preview">
      {preview !== undefined && (
        <p>
          {preview.pages} {preview.pages === 1 ? 'page' : 'pages'}
          {preview.title === undefined ? '' : `, like: ${preview.title}`}
        </p>
      )}
      <div className="page-template-row">
        {editing === undefined ? (
          <span className="page-template-address">{address}</span>
        ) : (
          <input
            autoFocus
            aria-label="Address pattern"
            value={form.route}
            spellCheck={false}
            placeholder="/blog/[slug]"
            onBlur={finish}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                finish();
              } else if (event.key === 'Escape') {
                // Escape here takes back the edit; it is not asking to leave the dialog.
                event.preventDefault();
                event.stopPropagation();
                set((previous) => ({ ...previous, ...editing }));
                setEditing(undefined);
              }
            }}
            onChange={(event) => {
              const route = event.currentTarget.value;
              set((previous) => ({ ...previous, route, routeSource: 'typed' }));
            }}
          />
        )}
        <button className="ghost" onClick={() => (editing === undefined ? setEditing({ route: form.route, routeSource: form.routeSource }) : finish())}>
          {editing === undefined ? 'Edit' : 'Done'}
        </button>
      </div>
    </div>
  );
}

function SourceKindField({ form, set }: { readonly form: TemplateForm; readonly set: SetForm }) {
  return (
    <div>
      <label>Data source</label>
      <Dropdown<SourceKind>
        livePreview={false}
        value={form.kind}
        options={[
          { value: 'content-collection', label: 'Content collection', icon: <AstroIcon size={13} /> },
          { value: 'sanity', label: 'Sanity', icon: <SanityIcon size={13} /> },
          { value: 'http-json', label: 'Data from a link', icon: <CmsIcon size={13} /> },
        ]}
        onChange={(kind) => set((previous) => ({ ...previous, kind, slugPath: '', slugTreatment: 'exact', fields: [] }))}
      />
    </div>
  );
}

function ContentFields({
  projectPath,
  form,
  set,
  collections,
  onSample,
}: {
  readonly projectPath: string;
  readonly form: TemplateForm;
  readonly set: SetForm;
  readonly collections: readonly AppCollection[] | undefined;
  readonly onSample: (list: SampleList | undefined) => void;
}) {
  const [sampled, setSampled] = useState<readonly SampleField[]>([]);
  const { collection } = form;
  useEffect(() => {
    setSampled([]);
    onSample(undefined);
    if (collection.length === 0 || collection === NEW_COLLECTION) {
      return undefined;
    }
    let live = true;
    sampleDataSource(projectPath, { kind: 'content-collection', collection })
      .then((answer) => {
        if (live && answer.ok && answer.value.kind === 'lists') {
          // Only an entry's own fields: the page reads `entry.data.<field>`.
          const fields = answer.value.lists.flatMap((list) => list.fields.filter((field) => !field.path.includes('.')));
          setSampled(fields);
          onSample({ path: '', count: answer.value.lists[0]?.count ?? 0, fields });
        }
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [collection, onSample, projectPath]);
  const named = (name: string, previous: TemplateForm): TemplateForm =>
    previous.routeSource === 'suggested' ? { ...previous, route: suggestedRoute(name) } : previous;
  return (
    <>
      <div>
        <label>Collection</label>
        <Dropdown
          livePreview={false}
          value={form.collection}
          placeholder={collections === undefined ? 'Reading collections…' : 'Choose a collection'}
          options={collectionOptions(collections ?? [])}
          onChange={(value) =>
            set((previous) =>
              named(value === NEW_COLLECTION ? previous.newCollection : value, {
                ...previous,
                collection: value,
                contentSlug: ENTRY_ID,
                slugTreatment: 'exact',
              }),
            )
          }
        />
      </div>
      {form.collection === NEW_COLLECTION && (
        <div>
          <label>Collection name</label>
          <input
            autoFocus
            value={form.newCollection}
            placeholder="Blog posts"
            onChange={(event) => {
              const newCollection = event.currentTarget.value;
              set((previous) => named(newCollection, { ...previous, newCollection }));
            }}
          />
          <p className="hint-text">Stacki adds it to your content config with a title field and a first entry to preview.</p>
        </div>
      )}
      {form.collection !== NEW_COLLECTION && (
        <div>
          <label>Each page’s web address uses</label>
          <DetailPopover label={form.contentSlug === ENTRY_ID ? 'Entry id' : form.contentSlug} title="Each page’s web address uses" surface="data">
            {(close) => (
              <SampleTree
                list={{ path: '', count: sampled.length, fields: sampled }}
                mode={{
                  kind: 'address',
                  value: form.contentSlug,
                  route: form.route,
                  extra: { value: ENTRY_ID, label: 'Entry id' },
                  pick: (value) => {
                    set((previous) => ({ ...previous, contentSlug: value, slugTreatment: slugTreatmentOf(sampled, value) }));
                    close();
                  },
                }}
              />
            )}
          </DetailPopover>
        </div>
      )}
    </>
  );
}

// A project with collections lists them first; with none, a new one is the only way forward, so it leads.
// Each collection carries the CMS icon and the new row its plus, so the icons line up down the left edge.
function collectionOptions(collections: readonly AppCollection[]) {
  const created = { value: NEW_COLLECTION, label: 'New collection…', icon: <PlusIcon size={13} /> };
  return collections.length === 0 ? [created] : [...collections.map((item) => ({ value: item.name, label: item.name, icon: <CmsIcon size={13} /> })), created];
}

function SanityFields({
  projectPath,
  form,
  set,
  update,
  connections,
  refresh,
  connectSanity,
  onSample,
}: {
  readonly projectPath: string;
  readonly form: TemplateForm;
  readonly set: SetForm;
  /** Changes the form without counting as something the person did. */
  readonly update: SetForm;
  readonly connections: readonly SanityConnection[] | undefined;
  readonly refresh: () => void;
  readonly connectSanity: ConnectSanity;
  readonly onSample: (list: SampleList | undefined) => void;
}) {
  const [types, setTypes] = useState<readonly string[]>([]);
  const [lists, setLists] = useState<readonly SampleList[]>([]);
  const [sampling, setSampling] = useState<Sampling>({ kind: 'idle' });
  const [connecting, setConnecting] = useState(false);
  const { connectionId } = form;
  const [firstList] = lists;
  useEffect(() => onSample(firstList), [firstList, onSample]);
  useEffect(() => {
    setTypes([]);
    setLists([]);
    if (connectionId.length === 0) {
      return undefined;
    }
    let live = true;
    setSampling({ kind: 'loading' });
    sampleDataSource(projectPath, { kind: 'sanity-types', connectionId })
      .then((answer) => {
        if (!live) {
          return;
        }
        if (answer.ok && answer.value.kind === 'types') {
          const { types: listed, access } = answer.value;
          setTypes(listed);
          update((previous) => ({ ...previous, sanityAccess: access }));
          setSampling(listed.length === 0 ? { kind: 'failed', message: 'This Sanity dataset has no documents yet.' } : { kind: 'idle' });
        } else {
          setSampling({ kind: 'failed', message: answer.ok ? 'Sanity listed no document types.' : answer.message });
        }
      })
      .catch((error: unknown) => {
        if (live) {
          setSampling({ kind: 'failed', message: requestProblem(error) });
        }
      });
    return () => {
      live = false;
    };
  }, [connectionId, projectPath, update]);
  const newestType = useRef('');
  const pickType = async (documentType: string): Promise<void> => {
    newestType.current = documentType;
    set((previous) => ({ ...previous, documentType, route: previous.routeSource === 'suggested' ? suggestedRoute(documentType) : previous.route }));
    setSampling({ kind: 'loading' });
    try {
      const answer = await sampleDataSource(projectPath, { kind: 'sanity-documents', connectionId, documentType });
      if (newestType.current !== documentType) {
        return;
      }
      if (answer.ok && answer.value.kind === 'lists') {
        const [first] = answer.value.lists;
        setLists(answer.value.lists);
        setSampling({ kind: 'idle' });
        if (first !== undefined) {
          update((previous) => ({ ...previous, ...addressChoice(first), fields: templateFields(first) }));
        }
      } else {
        setSampling({ kind: 'failed', message: answer.ok ? 'Sanity sent no documents.' : answer.message });
      }
    } catch (error: unknown) {
      setSampling({ kind: 'failed', message: requestProblem(error) });
    }
  };
  const connect =
    connecting &&
    connectSanity({
      projectPath,
      close: () => {
        setConnecting(false);
        refresh();
      },
    });
  if (connections === undefined) {
    return <p className="hint-text">Looking for a Sanity connection…</p>;
  }
  if (connections.length === 0) {
    return (
      <div className="page-template-connect">
        <p className="hint-text">Connect this project to Sanity to build a template from its content.</p>
        <button onClick={() => setConnecting(true)}>
          <SanityIcon size={13} /> Connect Sanity
        </button>
        {connect}
      </div>
    );
  }
  return (
    <>
      <SanityConnectionField connections={connections} form={form} set={set} />
      <div>
        <label>Document type</label>
        <Dropdown
          livePreview={false}
          value={form.documentType}
          disabled={types.length === 0}
          placeholder={sampling.kind === 'loading' ? 'Asking Sanity…' : 'Choose a type'}
          options={types.map((type) => ({ value: type, label: type }))}
          onChange={(value) => void pickType(value)}
        />
      </div>
      {sampling.kind === 'failed' && <p className="page-template-problem">{sampling.message}</p>}
      {lists[0] !== undefined && (
        <>
          <div className="page-template-triggers">
            <FieldsPopover list={lists[0]} form={form} set={set} />
          </div>
          <AddressField list={lists[0]} form={form} set={set} />
        </>
      )}
    </>
  );
}

function SanityConnectionField({
  connections,
  form,
  set,
}: {
  readonly connections: readonly SanityConnection[];
  readonly form: TemplateForm;
  readonly set: SetForm;
}) {
  const [only] = connections;
  if (only !== undefined && connections.length === 1) {
    return (
      <p className="hint-text">
        Using {only.label}: {only.projectId}, {only.dataset}.
      </p>
    );
  }
  return (
    <div>
      <label>Sanity connection</label>
      <Dropdown
        livePreview={false}
        value={form.connectionId}
        options={connections.map((connection) => ({ value: connection.id, label: connection.label, hint: connection.dataset }))}
        onChange={(value) => {
          const connection = connections.find((candidate) => candidate.id === value);
          if (connection !== undefined) {
            set((previous) => withSanityConnection(previous, connection));
          }
        }}
      />
    </div>
  );
}

// What a page needs from .env and does not have. A connection's key can be
// copied there; it is an Editor key, which is more than a site needs, so the
// person can leave it and set a read token of their own.
function EnvNotes({ form, env, set }: { readonly form: TemplateForm; readonly env: readonly EnvStatus[]; readonly set: SetForm }) {
  const missing = env.flatMap((item) => (item.state === 'missing' ? [item.name] : []));
  const offered = form.kind === 'sanity' && missing.includes(SANITY_TOKEN_ENV);
  const unset = offered && form.connectionKey === 'copy' ? missing.filter((name) => name !== SANITY_TOKEN_ENV) : missing;
  return (
    <>
      {offered && (
        <label className="check-row">
          <input
            type="checkbox"
            checked={form.connectionKey === 'copy'}
            onChange={(event) => {
              const connectionKey = event.currentTarget.checked ? 'copy' : 'skip';
              set((previous) => ({ ...previous, connectionKey }));
            }}
          />
          <span>This dataset is private. Copy the connection’s Editor key to .env as {SANITY_TOKEN_ENV}, which stays out of Git, so the site can build.</span>
        </label>
      )}
      {unset.length > 0 && <p className="hint-text">Still to set in .env: {unset.join(', ')}. The page shows an error until it is.</p>}
    </>
  );
}

function HttpFields({
  projectPath,
  form,
  set,
  update,
  onSample,
}: {
  readonly projectPath: string;
  readonly form: TemplateForm;
  readonly set: SetForm;
  /** Changes the form without counting as something the person did. */
  readonly update: SetForm;
  readonly onSample: (list: SampleList | undefined) => void;
}) {
  const [lists, setLists] = useState<readonly SampleList[]>([]);
  const [sampling, setSampling] = useState<Sampling>({ kind: 'idle' });
  const url = parseSourceURL(form.url);
  const headers = headersOf(form.headers);
  const target = url.ok && headers.ok ? { url: url.value, headers: headers.value } : undefined;
  const key = target === undefined ? undefined : JSON.stringify(target);
  // The newest target, and whether anything is still listening for the answer.
  const latest = useRef(target);
  latest.current = target;
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  // One request at a time, the newest waiting behind it: a burst of edits costs
  // at most two fetches, and an answer overtaken by an edit is dropped.
  const runner = useMemo(() => {
    const run: CoalescedRun<void> = createCoalescedRun(async () => {
      const asked = latest.current;
      if (asked === undefined) {
        return;
      }
      // Compared as text: each render builds its own equal target.
      const stale = (): boolean => !live.current || run.superseded() || JSON.stringify(latest.current) !== JSON.stringify(asked);
      setSampling({ kind: 'loading' });
      try {
        const answer = await sampleDataSource(projectPath, { kind: 'http-json', ...asked });
        if (stale()) {
          return;
        }
        if (answer.ok && answer.value.kind === 'lists') {
          const found = answer.value.lists;
          setLists(found);
          setSampling({ kind: 'idle' });
          update((previous) => withSampleLists(previous, found));
        } else {
          setSampling({ kind: 'failed', message: answer.ok ? 'That address has no list of items.' : answer.message });
        }
      } catch (error: unknown) {
        if (!stale()) {
          setSampling({ kind: 'failed', message: requestProblem(error) });
        }
      }
    });
    return run;
  }, [projectPath, update]);
  const asked = useRef<string | undefined>(undefined);
  const pasted = useRef(false);
  const fetchNow = useCallback(
    (askedKey: string): void => {
      asked.current = askedKey;
      void runner.request();
    },
    [runner],
  );
  useEffect(() => {
    if (key === undefined) {
      asked.current = undefined;
      setLists([]);
      setSampling({ kind: 'idle' });
      update((previous) => (previous.slugPath.length === 0 ? previous : { ...previous, listPath: '', slugPath: '', slugTreatment: 'exact', fields: [] }));
      return undefined;
    }
    if (key === asked.current) {
      return undefined;
    }
    const delay = pasted.current ? 0 : SAMPLE_DELAY_MS;
    pasted.current = false;
    const timer = setTimeout(() => {
      if (key !== asked.current) {
        fetchNow(key);
      }
    }, delay);
    return () => clearTimeout(timer);
  }, [fetchNow, key, update]);
  const refresh = (): void => {
    if (key !== undefined) {
      fetchNow(key);
    }
  };
  const chosen = lists.find((list) => list.path === form.listPath);
  useEffect(() => onSample(chosen), [chosen, onSample]);
  const changeRow = (index: number, row: HeaderRow): void => {
    set((previous) => ({ ...previous, headers: previous.headers.map((header, at) => (at === index ? row : header)) }));
  };
  const named = form.headers.filter((row) => row.name.trim().length > 0).length;
  return (
    <>
      <div>
        <label>Link to your data</label>
        <div className="page-template-row">
          <input
            value={form.url}
            spellCheck={false}
            placeholder="https://api.example.com/posts"
            onPaste={() => {
              pasted.current = true;
            }}
            onBlur={() => {
              if (key !== undefined && key !== asked.current) {
                fetchNow(key);
              }
            }}
            onChange={(event) => {
              const address = event.currentTarget.value;
              set((previous) => ({
                ...previous,
                url: address,
                route: previous.routeSource === 'suggested' ? suggestedRoute(lastPathWord(address)) : previous.route,
              }));
            }}
          />
          {form.url.trim().length > 0 && (
            <button
              className={`ghost page-template-refresh ${sampling.kind === 'loading' ? 'is-loading' : ''}`}
              title={sampling.kind === 'loading' ? 'Fetching a sample' : 'Fetch the sample again'}
              aria-busy={sampling.kind === 'loading'}
              disabled={key === undefined}
              onClick={refresh}
            >
              <RefreshIcon size={13} />
            </button>
          )}
        </div>
        {sampling.kind === 'loading' && chosen === undefined && <div className="page-template-shimmer" role="status" aria-label="Reading your data" />}
        {sampling.kind === 'failed' && <p className="page-template-problem">{sampling.message}</p>}
      </div>
      <div className="page-template-triggers">
        <DetailPopover label={`Headers (${named})`} title="Request headers" surface="form">
          <p className="hint-text">Only needed if your link requires a key.</p>
          {form.headers.map((row, index) => (
            <HeaderFields
              key={index}
              projectPath={projectPath}
              row={row}
              change={(next) => changeRow(index, next)}
              remove={() => set((previous) => ({ ...previous, headers: previous.headers.filter((_header, at) => at !== index) }))}
              saved={refresh}
            />
          ))}
          {!headers.ok && <p className="page-template-problem">{headers.error}</p>}
          <button className="ghost page-template-add" onClick={() => set((previous) => ({ ...previous, headers: withHeaderRow(previous.headers) }))}>
            <PlusIcon size={11} />
            Add header
          </button>
        </DetailPopover>
        {chosen !== undefined && <FieldsPopover list={chosen} form={form} set={set} />}
        {lists.length > 1 && (
          <Dropdown
            livePreview={false}
            ariaLabel="List of items"
            value={form.listPath}
            options={lists.map((list) => ({ value: list.path, label: list.path === '' ? 'The whole reply' : list.path, hint: `${list.count}` }))}
            onChange={(value) => set((previous) => withSampleList(previous, lists, value))}
          />
        )}
      </div>
      {chosen !== undefined && <AddressField list={chosen} form={form} set={set} />}
    </>
  );
}

function HeaderFields({
  projectPath,
  row,
  change,
  remove,
  saved,
}: {
  readonly projectPath: string;
  readonly row: HeaderRow;
  readonly change: (row: HeaderRow) => void;
  readonly remove: () => void;
  readonly saved: () => void;
}) {
  return (
    <div className="page-template-header">
      <div className="page-template-header-row">
        <input
          aria-label="Header name"
          value={row.name}
          spellCheck={false}
          placeholder="Authorization"
          onChange={(event) => change({ ...row, name: event.currentTarget.value })}
        />
        <input
          aria-label="Variable holding its value"
          value={row.env}
          spellCheck={false}
          placeholder="API_TOKEN"
          onChange={(event) => change({ ...row, env: event.currentTarget.value })}
        />
        <button className="ghost" title="Remove header" onClick={remove}>
          <TrashIcon size={12} />
        </button>
      </div>
      {`${row.name}${row.env}`.trim().length > 0 && (
        <Dropdown
          className="page-template-header-send"
          livePreview={false}
          ariaLabel="How the value is sent"
          value={row.scheme}
          options={[
            { value: 'plain', label: 'Send the key as it is' },
            { value: 'bearer', label: 'Put “Bearer” before the key' },
          ]}
          onChange={(scheme) => change({ ...row, scheme: scheme === 'bearer' ? 'bearer' : 'plain' })}
        />
      )}
      {row.env.trim().length > 0 && <SecretField projectPath={projectPath} name={row.env.trim()} saved={saved} />}
    </div>
  );
}

// The value goes to .env when saved, and is forgotten here: the field empties
// and nothing in the form or the page holds it.
function SecretField({ projectPath, name, saved }: { readonly projectPath: string; readonly name: string; readonly saved: () => void }) {
  const [value, setValue] = useState('');
  const [state, setState] = useState<{ readonly kind: 'idle' } | { readonly kind: 'saved' } | { readonly kind: 'failed'; readonly message: string }>({
    kind: 'idle',
  });
  const save = async (): Promise<void> => {
    try {
      const answer = await setProjectEnv(projectPath, name, value);
      setState(answer.ok ? { kind: 'saved' } : { kind: 'failed', message: answer.message });
      if (answer.ok) {
        setValue('');
        saved();
      }
    } catch (error: unknown) {
      setState({ kind: 'failed', message: requestProblem(error) });
    }
  };
  return (
    <div>
      <div className="page-template-row">
        <input type="password" value={value} autoComplete="off" placeholder={`Value of ${name}`} onChange={(event) => setValue(event.currentTarget.value)} />
        <button disabled={value.length === 0} onClick={() => void save()}>
          Save to .env
        </button>
      </div>
      {state.kind === 'saved' && <p className="hint-text">Saved to .env, which stays out of Git.</p>}
      {state.kind === 'failed' && <p className="page-template-problem">{state.message}</p>}
    </div>
  );
}

function AddressField({ list, form, set }: { readonly list: SampleList; readonly form: TemplateForm; readonly set: SetForm }) {
  return (
    <div>
      <label>Each page’s web address uses</label>
      <DetailPopover label={form.slugPath.length > 0 ? form.slugPath : 'Choose what makes it unique'} title="Each page’s web address uses" surface="data">
        {(close) => (
          <SampleTree
            list={list}
            mode={{
              kind: 'address',
              value: form.slugPath,
              route: form.route,
              pick: (path) => {
                set((previous) => ({ ...previous, slugPath: path, slugTreatment: slugTreatmentOf(list.fields, path) }));
                close();
              },
            }}
          />
        )}
      </DetailPopover>
    </div>
  );
}

function FieldsPopover({ list, form, set }: { readonly list: SampleList; readonly form: TemplateForm; readonly set: SetForm }) {
  return (
    <DetailPopover label={fieldsSummary(form.fields.length, list.count)} title="Fields for the template" surface="data">
      <SampleTree
        list={list}
        mode={{
          kind: 'fields',
          chosen: form.fields,
          toggle: (path) => set((previous) => ({ ...previous, fields: toggledFields(previous.fields, list, path) })),
          selectAll: () => set((previous) => ({ ...previous, fields: templateFields(list) })),
          deselectAll: () => set((previous) => ({ ...previous, fields: fieldsAfterDeselect(list, previous.slugPath) })),
        }}
      />
    </DetailPopover>
  );
}

function PlannedFiles({ changes }: { readonly changes: readonly PageTemplateChange[] }) {
  return (
    <div className="modal-body page-template-files">
      {changes.map((change) => (
        <section key={change.path}>
          <h4>
            {change.action === 'create' ? 'New file' : 'Added to'} {change.path}
          </h4>
          <CodeBlock text={change.text} filename={change.path} label={change.path} className="page-template-code" />
        </section>
      ))}
    </div>
  );
}

function addressChoice(list: SampleList): Pick<TemplateForm, 'slugPath' | 'slugTreatment'> {
  const slugPath = suggestedSlugPath(list.fields);
  return { slugPath, slugTreatment: slugTreatmentOf(list.fields, slugPath) };
}

function lastPathWord(address: string): string {
  if (!URL.canParse(address)) {
    return '';
  }
  const word =
    new URL(address).pathname
      .split('/')
      .filter((part) => part.length > 0)
      .at(-1) ?? '';
  return word.replace(/\.[A-Za-z0-9]+$/, '');
}

// Expected failures arrive as messages, so a throw here is Stacki's own fault:
// a designer gets a sentence, and the detail goes to the console for whoever fixes it.
function requestProblem(error: unknown): string {
  console.error('Create page template:', error);
  return UNEXPECTED_FAILURE;
}
