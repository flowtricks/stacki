// Desktop's Page settings: the shared dialog (src/features/pages/PageSettingsDialog.tsx) with what Desktop can do.
// Every step goes through main as one planned, atomic write with one undo token (page:applySettings), recorded on
// the same history Cmd+Z reads; after it the scan is read again and the canvas opens the page where it now lives.
// The layout's props are drawn by the Properties panel's own editors on the layout instance, written by the same
// handlers; a CMS template's settings are the Create page template dialog's own fields, read back from its code.
import { useEffect, useMemo, useState } from 'react';
import { err, ok, type Result } from '../../../shared/core/result';
import { messageRef } from '../../../shared/properties/i18n/messageRef';
import type { PageSettingsApplied, PageSettingsRequest } from '../../../shared/properties/pageSettings';
import { isHomePage } from '../../../shared/properties/pageSettings';
import type { ContentSlug } from '../../../shared/properties/pageTemplate';
import type { TemplateReading } from '../../../shared/properties/pageTemplateReading';
import type { ScanPage } from '../../../shared/properties/projectScan';
import { can } from '../../../shared/properties/projectRoles';
import type { FieldDefinition } from '../../features/props/propRules';
import { InstancePropFields } from '../../features/props/PropsPanel';
import { PageSettingsDialog, type PageSettingsHost } from '../../features/pages/PageSettingsDialog';
import { ContentFields } from '../../features/pages/PageTemplateDialog';
import { ENTRY_ID, EMPTY_TEMPLATE_FORM, type TemplateForm } from '../../features/pages/pageTemplateForm';
import { readContentCollections, type AppCollection } from '../../ipc/appBridge';
import { applyPageSettings, planPageSettings, readPageTemplateSettings, retargetPageTemplate, revertPageSettings } from '../../ipc/pageSettingsBridge';
import { useTranslate, useTranslateDescribed } from '../../lib/i18n/useTranslate';
import { pageDisplayLabel } from '../../lib/pageName';
import { useCurrentRole } from '../../lib/useCurrentRole';
import { CodeBlock } from '../../ui/CodeBlock';
import { ErrorToast } from '../../ui/ErrorToast';
import TipAnchor from '../../ui/TipAnchor';
import { BracesIcon, PlusIcon } from '../../ui/Icons';
import { SkeletonRows } from '../../ui/Skeleton';
import type { ShellView } from '../App';
import { settingsHandlers, settingsValues } from './AppPanes';

/** Props a layout passes to the page's head, shown first when the layout declares them; never invented. */
const SEO_PROPS = ['title', 'description', 'image', 'ogImage', 'canonical', 'noindex', 'keywords'] as const;

export function DesktopPageSettings({ app, page, close }: { readonly app: ShellView; readonly page: ScanPage; readonly close: () => void }) {
  const role = useCurrentRole();
  const projectPath = app.project.path;
  // The layout props are the open page's: settings for another page open that page first, so edits show on the canvas.
  const open = app.currentScanPage?.path === page.path;
  const { onSelectPage } = app;
  useEffect(() => {
    if (!open) {
      onSelectPage(page);
    }
    // Only when the dialog opens for a page: navigating away inside the dialog is not asked for.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once per page the dialog opens for; a later navigation is the person's own
  }, [page.path]);
  const host = useDesktopHost(app, page);
  return (
    <PageSettingsDialog
      page={page}
      pages={app.scan.pages}
      folders={app.scan.pageFolders}
      host={host}
      allowed={{ rename: can(role, 'page:rename'), create: can(role, 'page:create'), remove: can(role, 'page:delete') }}
      layoutProps={<LayoutProps app={app} page={page} close={close} />}
      template={page.name.includes('[') ? <TemplateSettings app={app} page={page} projectPath={projectPath} /> : undefined}
      close={close}
    />
  );
}

function useDesktopHost(app: ShellView, page: ScanPage): PageSettingsHost {
  const translate = useTranslate();
  const projectPath = app.project.path;
  return useMemo(
    () => ({
      unavailable: undefined,
      plan: (request: PageSettingsRequest) => planPageSettings(projectPath, request),
      apply: async (request: PageSettingsRequest): Promise<Result<void>> => {
        await app.flushSave();
        const applied = await applyPageSettings(projectPath, request);
        if (!applied.ok) {
          return applied;
        }
        const name = pageDisplayLabel(page, translate);
        await afterStep(app, request, applied.value, 'forward');
        app.showToast(doneText(request, applied.value, name, translate), 'success');
        let token = applied.value.undo;
        app.pushCommand({
          labelRef: undoLabel(request, name),
          undo: async () => {
            const back = await revertPageSettings(token, 'undo');
            if (!back.ok) {
              app.reportFailure(new Error(back.error.message));
              return;
            }
            await afterStep(app, request, applied.value, 'back');
          },
          redo: async () => {
            const again = await revertPageSettings(token, 'redo');
            if (!again.ok) {
              app.reportFailure(new Error(again.error.message));
              return;
            }
            token = applied.value.undo;
            await afterStep(app, request, applied.value, 'forward');
          },
        });
        return ok(undefined);
      },
    }),
    [app, page, projectPath, translate],
  );
}

// After a step (or its undo), the scan is read again and the canvas shows the page it was on, wherever that is now.
async function afterStep(app: ShellView, request: PageSettingsRequest, applied: PageSettingsApplied, direction: 'forward' | 'back'): Promise<void> {
  const projectPath = app.project.path;
  const current = app.currentScanPage?.name;
  window.dispatchEvent(new Event('stacki:pages-renamed'));
  const result = await app.rescan(projectPath);
  const moves = applied.summary.moves.map((move) => ({ from: move.from.slice('src/pages/'.length), to: move.to.slice('src/pages/'.length) }));
  const mapped = moves.map((move) => (direction === 'forward' ? move : { from: move.to, to: move.from }));
  let target: string | undefined = mapped.find((move) => move.from === current)?.to;
  if (request.kind === 'duplicate') {
    target = direction === 'forward' ? applied.page : request.page;
  }
  if (request.kind === 'remove') {
    if (direction === 'forward' && current === request.page) {
      target = result.pages.find((candidate) => isHomePage(candidate.name))?.name;
    } else if (direction === 'back') {
      target = request.page;
    }
  }
  const next = target === undefined ? undefined : result.pages.find((candidate) => candidate.name === target);
  if (next !== undefined) {
    app.onSelectPage(next);
  }
}

type Translate = ReturnType<typeof useTranslate>;

function doneText(request: PageSettingsRequest, applied: PageSettingsApplied, name: string, translate: Translate): string {
  switch (request.kind) {
    case 'rename':
      return translate('pages.settings.done.rename', { name });
    case 'home':
      return translate('pages.settings.done.home', { name });
    case 'duplicate':
      return translate('pages.settings.done.duplicate', { name: applied.page });
    case 'remove':
      return translate('pages.settings.done.delete', { name });
    default: {
      const exhaustive: never = request;
      return exhaustive;
    }
  }
}

function undoLabel(request: PageSettingsRequest, name: string) {
  switch (request.kind) {
    case 'rename':
      return messageRef('pages.settings.undo.rename', { name });
    case 'home':
      return messageRef('pages.settings.undo.home', { name });
    case 'duplicate':
      return messageRef('pages.settings.undo.duplicate', { name });
    case 'remove':
      return messageRef('pages.settings.undo.delete', { name });
    default: {
      const exhaustive: never = request;
      return exhaustive;
    }
  }
}

/** The layout's fields in the order the dialog shows them: the head's props first, then the rest as declared. */
export function orderedLayoutFields(schema: readonly FieldDefinition[]): readonly FieldDefinition[] {
  const seo = SEO_PROPS.flatMap((name) => schema.filter((field) => field.name === name));
  return [...seo, ...schema.filter((field) => !seo.includes(field))];
}

function LayoutProps({ app, page, close }: { readonly app: ShellView; readonly page: ScanPage; readonly close: () => void }) {
  const translate = useTranslate();
  const loaded = app.currentScanPage?.path === page.path && app.model !== undefined;
  if (!loaded) {
    return <SkeletonRows count={3} />;
  }
  const node = app.layoutNode;
  if (node === undefined || node.kind !== 'component') {
    return <div className="page-settings-note">{translate('pages.settings.layout.none')}</div>;
  }
  const name = app.currentLayoutName || node.name;
  const schema = orderedLayoutFields(app.layoutSchema).filter((field) => field.name !== 'class');
  if (schema.length === 0) {
    const file = app.scan.layouts.find((layout) => layout.name === name) ?? app.layoutComponent;
    return (
      <div className="page-settings-field">
        <div className="page-settings-note">{translate('pages.settings.layout.empty', { name })}</div>
        {file !== undefined && (
          <button
            type="button"
            className="page-settings-add-prop"
            onClick={() => {
              close();
              void app
                .openComponent(file.name, undefined, 0, file.path)
                .then(() => app.setLeftTab('properties'))
                .catch(app.reportFailure);
            }}
          >
            <PlusIcon size={12} />
            {translate('pages.settings.layout.add', { name })}
          </button>
        )}
      </div>
    );
  }
  // The Properties panel's values and handlers, aimed at the layout instance instead of the selection.
  const view: ShellView = { ...app, selectedId: 'layout', selectedNode: node, selectedSchema: schema, selectedComponent: app.layoutComponent };
  return <InstancePropFields {...settingsValues(view)} {...settingsHandlers(view, translate)} node={node} />;
}

type TemplateState =
  { readonly kind: 'reading' } | { readonly kind: 'read'; readonly reading: TemplateReading } | { readonly kind: 'failed'; readonly message: string };

function TemplateSettings({ app, page, projectPath }: { readonly app: ShellView; readonly page: ScanPage; readonly projectPath: string }) {
  const [state, setState] = useState<TemplateState>({ kind: 'reading' });
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let live = true;
    readPageTemplateSettings(projectPath, page.name).then(
      (reading) => live && setState({ kind: 'read', reading }),
      (error: unknown) => live && setState({ kind: 'failed', message: error instanceof Error ? error.message : String(error) }),
    );
    return () => {
      live = false;
    };
  }, [page.name, projectPath, version]);
  switch (state.kind) {
    case 'reading':
      return <SkeletonRows count={3} />;
    case 'failed':
      return <ErrorToast message={state.message} />;
    case 'read':
      return <TemplateReadingView app={app} page={page} reading={state.reading} projectPath={projectPath} reread={() => setVersion((value) => value + 1)} />;
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
}

function TemplateReadingView(props: {
  readonly app: ShellView;
  readonly page: ScanPage;
  readonly reading: TemplateReading;
  readonly projectPath: string;
  readonly reread: () => void;
}) {
  const translate = useTranslate();
  const { reading } = props;
  if (reading.kind === 'none') {
    return undefined;
  }
  if (reading.kind === 'custom') {
    return (
      <div className="page-settings-field">
        <TipAnchor text={translate('pages.settings.template.customBody')}>
          <div className="page-settings-badge">{translate('pages.settings.template.custom')}</div>
        </TipAnchor>
        <CodeBlock className="page-settings-template-code" text={reading.code} language="typescript" />
        <button type="button" className="page-settings-add-prop" onClick={() => props.app.openCodeWindow()}>
          {translate('pages.settings.template.editCode')}
        </button>
      </div>
    );
  }
  return <ContentTemplateForm {...props} reading={reading} />;
}

function ContentTemplateForm(props: {
  readonly app: ShellView;
  readonly page: ScanPage;
  readonly reading: Extract<TemplateReading, { readonly kind: 'content' }>;
  readonly projectPath: string;
  readonly reread: () => void;
}) {
  const translate = useTranslate();
  const translateDescribed = useTranslateDescribed();
  const { reading, app, page, projectPath } = props;
  const initial = formOf(reading, page);
  const [form, setForm] = useState<TemplateForm>(initial);
  const [collections, setCollections] = useState<readonly AppCollection[] | undefined>(undefined);
  const [showCode, setShowCode] = useState(false);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    readContentCollections(projectPath).then(
      (list) => live && setCollections(list),
      () => live && setCollections([]),
    );
    return () => {
      live = false;
    };
  }, [projectPath]);
  const slug = slugOf(form);
  const changed = form.collection !== initial.collection || form.contentSlug !== initial.contentSlug || form.slugTreatment !== initial.slugTreatment;
  const isNew = form.collection.startsWith('\u0000');
  const apply = async (): Promise<void> => {
    if (slug === undefined || isNew || busy) {
      return;
    }
    setBusy(true);
    setProblem(undefined);
    await app.flushSave();
    const done = await retargetTemplate(projectPath, page.name, form.collection, slug);
    setBusy(false);
    if (!done.ok) {
      setProblem(translateDescribed(done.error));
      return;
    }
    const name = pageDisplayLabel(page, translate);
    app.showToast(translate('pages.settings.done.template', { name }), 'success');
    const token = done.value.undo;
    app.pushCommand({
      labelRef: messageRef('pages.settings.undo.template', { name }),
      undo: async () => {
        const back = await revertPageSettings(token, 'undo');
        if (!back.ok) {
          app.reportFailure(new Error(back.error.message));
        }
        props.reread();
      },
      redo: async () => {
        const again = await revertPageSettings(token, 'redo');
        if (!again.ok) {
          app.reportFailure(new Error(again.error.message));
        }
        props.reread();
      },
    });
    props.reread();
  };
  const applyButton = (
    <button type="button" className="primary" disabled={!changed || slug === undefined || isNew || busy} onClick={() => void apply()}>
      {translate('pages.settings.template.apply')}
    </button>
  );
  return (
    <div className="page-settings-field page-template-dialog">
      <ContentFields projectPath={projectPath} form={form} set={setForm} collections={collections} onSample={() => undefined} />
      {showCode && <CodeBlock className="page-settings-template-code" text={reading.code} language="typescript" />}
      <ErrorToast message={problem} />
      <div className="page-settings-row">
        <button
          type="button"
          className={`page-template-code-toggle ${showCode ? 'is-on' : ''}`}
          title={translate('pages.settings.template.showCode')}
          aria-label={translate('pages.settings.template.showCode')}
          aria-pressed={showCode}
          onClick={() => setShowCode((shown) => !shown)}
        >
          <BracesIcon size={13} />
        </button>
        {isNew ? <TipAnchor text={translate('pages.settings.template.newCollection')}>{applyButton}</TipAnchor> : applyButton}
      </div>
    </div>
  );
}

/** The creation dialog's form, filled from what the template's code says. */
export function formOf(reading: Extract<TemplateReading, { readonly kind: 'content' }>, page: ScanPage): TemplateForm {
  const field = reading.slug.kind === 'field' ? reading.slug : undefined;
  return {
    ...EMPTY_TEMPLATE_FORM,
    kind: 'content-collection',
    route: page.route,
    routeSource: 'typed',
    collection: reading.collection,
    contentSlug: field === undefined ? ENTRY_ID : field.name,
    slugTreatment: field === undefined ? 'exact' : field.treatment,
  };
}

function slugOf(form: TemplateForm): ContentSlug | undefined {
  if (form.contentSlug === ENTRY_ID) {
    return { kind: 'entry-id' };
  }
  if (form.contentSlug.length === 0) {
    return undefined;
  }
  return { kind: 'field', name: form.contentSlug, treatment: form.slugTreatment };
}

async function retargetTemplate(projectPath: string, page: string, collection: string, slug: ContentSlug): Promise<Result<PageSettingsApplied>> {
  if (collection.length === 0) {
    return err({ code: 'collection', message: 'Choose a collection.' });
  }
  return retargetPageTemplate(projectPath, page, { kind: 'content-collection', collection, origin: 'existing', slug });
}
