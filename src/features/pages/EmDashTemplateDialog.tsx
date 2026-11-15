// A page template for an EmDash content type: choose the type and where its pages live, and one page is written
// that reads its entry from EmDash when it is requested. The types come from EmDash itself (the project's schema
// export, seed or local database), never from this form, and the page never copies content: an edit in the EmDash
// admin shows on the next request. Entries to preview come from the local EmDash data, read only.
import { useEffect, useMemo, useState } from 'react';
import type { ScanComponent } from '../../../shared/properties/projectScan';
import { parsePageTemplateDraft, type PageTemplateDraft } from '../../../shared/properties/pageTemplate';
import type { EmDashProject } from '../../../shared/properties/emdash';
import type { Described } from '../../../shared/properties/i18n/messageRef';
import { readEmDashProject } from '../../ipc/emdashBridge';
import { planPageTemplate } from '../../ipc/pageTemplateBridge';
import { useTranslate, useTranslateDescribed } from '../../lib/i18n/useTranslate';
import Dropdown from '../../ui/Dropdown';
import Popup from '../../ui/Popup';
import { Skeleton } from '../../ui/Skeleton';
import { suggestedRoute } from './pageTemplateForm';
import './pageTemplate.css';

// A pause in typing before the plan is worked out again, each plan being a read of the project.
const PLAN_DELAY_MS = 250;
const NO_LAYOUT = '';

type Planning = { readonly kind: 'none' } | { readonly kind: 'ready' } | { readonly kind: 'refused'; readonly problem: Described };

export interface EmDashTemplateDialogProps {
  readonly projectPath: string;
  readonly layouts: readonly ScanComponent[];
  readonly onClose: () => void;
  /** Creates the template, answering what went wrong, if anything (the Pages panel's own creator). */
  readonly onCreate: (draft: PageTemplateDraft) => Promise<string | undefined>;
}

export function EmDashTemplateDialog({ projectPath, layouts, onClose, onCreate }: EmDashTemplateDialogProps) {
  const translate = useTranslate();
  const translateDescribed = useTranslateDescribed();
  const [project, setProject] = useState<EmDashProject | undefined>(undefined);
  const [collection, setCollection] = useState('');
  const [route, setRoute] = useState('');
  const [routeTyped, setRouteTyped] = useState(false);
  const [layout, setLayout] = useState(layouts.at(0)?.name ?? NO_LAYOUT);
  const [planning, setPlanning] = useState<Planning>({ kind: 'none' });
  const [creating, setCreating] = useState<'idle' | 'busy'>('idle');
  const [failure, setFailure] = useState<string | undefined>(undefined);

  useEffect(() => {
    let current = true;
    readEmDashProject(projectPath).then(
      (found) => {
        if (current) {
          setProject(found);
          const [first] = found.kind === 'present' ? found.collections : [];
          if (first !== undefined) {
            setCollection(first.slug);
            setRoute(suggestedRoute(first.slug));
          }
        }
      },
      () => current && setProject({ kind: 'absent' }),
    );
    return () => {
      current = false;
    };
  }, [projectPath]);

  const draft = useMemo((): PageTemplateDraft | undefined => {
    const chosen = layouts.find((candidate) => candidate.name === layout);
    try {
      return parsePageTemplateDraft({
        route,
        layout: chosen === undefined ? undefined : { name: chosen.name, path: chosen.path },
        source: { kind: 'emdash', collection },
      });
    } catch {
      // An unfinished route or no collection yet: Create stays off and the form says nothing until it is wrong.
      return undefined;
    }
  }, [collection, layout, layouts, route]);

  useEffect(() => {
    if (draft === undefined) {
      setPlanning({ kind: 'none' });
      return undefined;
    }
    let live = true;
    const timer = setTimeout(() => {
      planPageTemplate(projectPath, draft).then(
        (answer) => live && setPlanning(answer.ok ? { kind: 'ready' } : { kind: 'refused', problem: answer }),
        () => live && setPlanning({ kind: 'none' }),
      );
    }, PLAN_DELAY_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [draft, projectPath]);

  const create = async (): Promise<void> => {
    if (draft === undefined) {
      return;
    }
    setCreating('busy');
    const problem = await onCreate(draft).catch((error: unknown) => String(error));
    setCreating('idle');
    setFailure(problem);
    if (problem === undefined) {
      onClose();
    }
  };

  const collections = project?.kind === 'present' ? project.collections : [];
  const refused = planning.kind === 'refused' ? translateDescribed(planning.problem) : failure;
  return (
    <Popup className="modal page-template-dialog" label={translate('emdash.template.title')} onClose={onClose} dismissible>
      {({ close }) => (
        <>
          <div className="modal-header">{translate('emdash.template.title')}</div>
          <div className="modal-body">
            {project === undefined && <Skeleton width="100%" height="2rem" />}
            {project !== undefined && collections.length === 0 && <p className="hint-text">{translate('emdash.template.empty')}</p>}
            {collections.length > 0 && (
              <>
                <div>
                  <label>{translate('emdash.template.collection')}</label>
                  <Dropdown
                    livePreview={false}
                    value={collection}
                    options={collections.map((item) => ({ value: item.slug, label: item.label }))}
                    onChange={(value) => {
                      setCollection(value);
                      if (!routeTyped) {
                        setRoute(suggestedRoute(value));
                      }
                    }}
                  />
                </div>
                <div>
                  <label>{translate('emdash.template.route')}</label>
                  <input
                    value={route}
                    spellCheck={false}
                    placeholder="/blog/[slug]"
                    onChange={(event) => {
                      setRoute(event.currentTarget.value);
                      setRouteTyped(true);
                    }}
                  />
                  <p className="hint-text">{translate('emdash.template.routeHint')}</p>
                </div>
                {layouts.length > 1 && (
                  <div>
                    <label>{translate('emdash.template.layout')}</label>
                    <Dropdown
                      livePreview={false}
                      value={layout}
                      options={[
                        { value: NO_LAYOUT, label: translate('emdash.template.noLayout') },
                        ...layouts.map((item) => ({ value: item.name, label: item.name })),
                      ]}
                      onChange={setLayout}
                    />
                  </div>
                )}
              </>
            )}
            {refused !== undefined && <p className="page-template-problem">{refused}</p>}
          </div>
          <div className="modal-footer">
            <button onClick={close}>{translate('ui.cancel')}</button>
            <button className="primary" disabled={planning.kind !== 'ready' || creating === 'busy'} onClick={() => void create()}>
              {translate('emdash.template.create')}
            </button>
          </div>
        </>
      )}
    </Popup>
  );
}
