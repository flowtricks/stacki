// The Page settings dialog: one sheet per page, opened from the gear on a page row. Grouped sections, top to bottom:
// General (the URL name, or the Homepage badge for `/`), Homepage (make this page the homepage), Layout props (the
// layout instance's props, drawn by the host with the Properties panel's own editors) and Template (a CMS template's
// settings, also from the host). The header holds Duplicate, Delete and Close. Every step that writes asks first,
// inside the dialog, with what will happen (the plan main worked out without writing); nothing here is a native dialog.
// Host-agnostic: Desktop and Studio pass what they can do, and say why in place of what they cannot.
import { useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { Result } from '../../../shared/core/result';
import type { Described } from '../../../shared/properties/i18n/messageRef';
import { pageURLPath } from '../../../shared/properties/pageRename';
import {
  checkUrlName,
  folderOf,
  homeSwapPlan,
  homeSwapRefusalText,
  isHomePage,
  urlNameOf,
  type HomeSwapMoves,
  type PageSettingsRequest,
  type PageSettingsSummary,
} from '../../../shared/properties/pageSettings';
import type { ScanPage } from '../../../shared/properties/projectScan';
import { useTranslate, useTranslateDescribed } from '../../lib/i18n/useTranslate';
import { pageDisplayLabel } from '../../lib/pageName';
import { tooltipHost, useDelayedTooltip } from '../../ui/delayedTooltip';
import { CopyIcon, HomeIcon, TrashIcon } from '../../ui/Icons';
import Popup from '../../ui/Popup';
import Dropdown from '../../ui/Dropdown';
import { SkeletonRows } from '../../ui/Skeleton';
import './pageSettings.css';

export interface PageSettingsHost {
  /** Works out what a step would do, for the confirm; undefined where the host cannot (the step then applies at once). */
  readonly plan: ((request: PageSettingsRequest) => Promise<Result<PageSettingsSummary>>) | undefined;
  /** Applies a step: the host records its undo, rescans and opens the right page. */
  readonly apply: (request: PageSettingsRequest) => Promise<Result<void>>;
  /** Why the host cannot swap the homepage, duplicate or delete; undefined where it can. */
  readonly unavailable: Described | undefined;
}

export interface PageSettingsDialogProps {
  readonly page: ScanPage;
  readonly pages: readonly ScanPage[];
  readonly folders: readonly string[];
  readonly host: PageSettingsHost;
  /** What the person's role allows (shared/properties/projectRoles.ts). */
  readonly allowed: { readonly rename: boolean; readonly create: boolean; readonly remove: boolean };
  /** Locale folders of the project's i18n config, when the host knows them. */
  readonly locales?: readonly string[];
  /** The Layout props section's content, drawn by the host; undefined leaves the section out. */
  readonly layoutProps?: ReactNode;
  /** The Template section's content for a CMS template page; undefined leaves the section out. */
  readonly template?: ReactNode;
  readonly close: () => void;
}

type Action =
  | { readonly kind: 'rename'; readonly to: string }
  | { readonly kind: 'home'; readonly moves: HomeSwapMoves }
  | { readonly kind: 'remove' }
  | { readonly kind: 'duplicate' };

type Step =
  | { readonly kind: 'settings' }
  | { readonly kind: 'planning'; readonly action: Action }
  | { readonly kind: 'confirm'; readonly action: Action; readonly summary: PageSettingsSummary }
  | { readonly kind: 'applying'; readonly action: Action };

export function PageSettingsDialog(props: PageSettingsDialogProps) {
  const translate = useTranslate();
  const model = usePageSettings(props);
  const name = pageDisplayLabel(props.page, translate);
  const title = translate('pages.settings.title', { name });
  return (
    <Popup className="modal page-settings" label={title} onClose={props.close} dismissible={!model.busy}>
      {({ close }) => (
        <>
          <div className="page-settings-header">
            <div className="page-settings-heading">
              <div className="page-settings-title">{title}</div>
              <div className="page-settings-route">{props.page.route}</div>
            </div>
            <HeaderActions model={model} props={props} />
            <button type="button" className="page-settings-close" disabled={model.busy} onClick={close}>
              {translate('ui.close')}
            </button>
          </div>
          <div className="page-settings-body">
            {model.step.kind === 'settings' ? <SettingsSections model={model} props={props} /> : <ConfirmStep model={model} props={props} />}
            {model.problem !== undefined && (
              <div className="page-settings-problem" role="alert">
                {model.problem}
              </div>
            )}
          </div>
        </>
      )}
    </Popup>
  );
}

type Model = ReturnType<typeof usePageSettings>;

function usePageSettings(props: PageSettingsDialogProps) {
  const translateDescribed = useTranslateDescribed();
  const [step, setStep] = useState<Step>({ kind: 'settings' });
  const [problem, setProblem] = useState<Described | undefined>(undefined);
  const pending = useRef(false);
  const busy = step.kind === 'planning' || step.kind === 'applying';
  const requestOf = (action: Action): PageSettingsRequest => {
    switch (action.kind) {
      case 'rename':
        return { kind: 'rename', from: props.page.name, to: action.to };
      case 'home':
        return { kind: 'home', page: props.page.name };
      case 'remove':
        return { kind: 'remove', page: props.page.name };
      case 'duplicate':
        return { kind: 'duplicate', page: props.page.name };
      default: {
        const exhaustive: never = action;
        return exhaustive;
      }
    }
  };
  const apply = async (action: Action): Promise<void> => {
    setStep({ kind: 'applying', action });
    const done = await props.host.apply(requestOf(action));
    if (done.ok) {
      setStep({ kind: 'settings' });
      props.close();
      return;
    }
    setProblem(done.error);
    setStep({ kind: 'settings' });
  };
  // Asks main what the step would do, then shows it; a host that cannot plan applies at once.
  const begin = async (action: Action): Promise<void> => {
    if (pending.current) {
      return;
    }
    pending.current = true;
    setProblem(undefined);
    try {
      const plan = props.host.plan;
      if (plan === undefined || action.kind === 'duplicate') {
        await apply(action);
        return;
      }
      setStep({ kind: 'planning', action });
      const planned = await plan(requestOf(action));
      if (planned.ok) {
        setStep({ kind: 'confirm', action, summary: planned.value });
      } else {
        setProblem(planned.error);
        setStep({ kind: 'settings' });
      }
    } finally {
      pending.current = false;
    }
  };
  const confirm = async (): Promise<void> => {
    if (step.kind !== 'confirm' || pending.current) {
      return;
    }
    pending.current = true;
    try {
      await apply(step.action);
    } finally {
      pending.current = false;
    }
  };
  return {
    step,
    busy,
    problem: problem === undefined ? undefined : translateDescribed(problem),
    begin,
    confirm,
    cancel: () => setStep({ kind: 'settings' }),
  };
}

function HeaderActions({ model, props }: { readonly model: Model; readonly props: PageSettingsDialogProps }) {
  const translate = useTranslate();
  const translateDescribed = useTranslateDescribed();
  const home = isHomePage(props.page.name);
  const unavailable = props.host.unavailable === undefined ? undefined : translateDescribed(props.host.unavailable);
  const deleteReason = home ? translate('pages.settings.delete.homeRefused') : unavailable;
  return (
    <div className="page-settings-actions">
      {props.allowed.create && (
        <TipButton
          label={translate('pages.settings.duplicate')}
          reason={unavailable}
          disabled={model.busy}
          onClick={() => void model.begin({ kind: 'duplicate' })}
        >
          <CopyIcon size={14} />
        </TipButton>
      )}
      {props.allowed.remove && (
        <TipButton label={translate('pages.settings.delete')} reason={deleteReason} disabled={model.busy} onClick={() => void model.begin({ kind: 'remove' })}>
          <TrashIcon size={14} />
        </TipButton>
      )}
    </div>
  );
}

// An icon button with the app's delayed tooltip. A reason disables it and becomes the tip: a disabled button gets no
// pointer events, so the wrapper listens instead.
function TipButton(props: {
  readonly label: string;
  readonly reason: string | undefined;
  readonly disabled: boolean;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  const tooltip = useDelayedTooltip();
  const host = useRef<HTMLSpanElement>(null);
  const tip = props.reason === undefined ? props.label : props.label + ' · ' + props.reason;
  return (
    <span ref={host} className="page-settings-tip" onMouseEnter={tooltip.show} onMouseLeave={tooltip.hide}>
      <button
        type="button"
        className="ghost page-settings-icon"
        aria-label={tip}
        disabled={props.disabled || props.reason !== undefined}
        onClick={props.onClick}
      >
        {props.children}
      </button>
      {tooltip.value !== undefined &&
        createPortal(
          <div className="rail-tooltip below" role="tooltip" style={tooltip.value}>
            {tip}
          </div>,
          tooltipHost(host.current ?? undefined),
        )}
    </span>
  );
}

function SettingsSections({ model, props }: { readonly model: Model; readonly props: PageSettingsDialogProps }) {
  const translate = useTranslate();
  const home = isHomePage(props.page.name);
  return (
    <>
      <section className="page-settings-section">
        <h3>{translate('pages.settings.section.general')}</h3>
        {home ? <HomeBadge /> : <UrlNameField key={props.page.name} model={model} props={props} />}
      </section>
      {/* A template answers many addresses; the homepage is one, so the section is not offered at all (main refuses too). */}
      {!home && !props.page.name.includes('[') && (
        <section className="page-settings-section">
          <h3>{translate('pages.settings.section.homepage')}</h3>
          <HomeSection model={model} props={props} />
        </section>
      )}
      {props.layoutProps !== undefined && (
        <section className="page-settings-section page-settings-layout">
          <h3>{translate('pages.settings.section.layout')}</h3>
          {props.layoutProps}
        </section>
      )}
      {props.template !== undefined && (
        <section className="page-settings-section">
          <h3>{translate('pages.settings.section.template')}</h3>
          {props.template}
        </section>
      )}
    </>
  );
}

function HomeBadge() {
  const translate = useTranslate();
  return (
    <div className="page-settings-home">
      <span className="page-settings-badge">
        <HomeIcon size={12} />
        {translate('pages.settings.homeBadge')}
      </span>
      <span className="page-settings-note">{translate('pages.settings.home.isHome')}</span>
    </div>
  );
}

// The URL name and the folder, one place to change the page's address: a rename, a move, or both in one step. A
// dynamic route's name is its pattern, so only its folder changes here.
function UrlNameField({ model, props }: { readonly model: Model; readonly props: PageSettingsDialogProps }) {
  const translate = useTranslate();
  const translateDescribed = useTranslateDescribed();
  const id = useId();
  const original = urlNameOf(props.page.name);
  const dynamic = props.page.name.includes('[');
  const [name, setName] = useState(original);
  const [folder, setFolder] = useState(folderOf(props.page.name));
  const inventory = { pages: props.pages.map((page) => page.name), folders: props.folders };
  const check = checkUrlName(props.page.name, dynamic ? original : name, inventory, { folder });
  const address = check.kind === 'valid' ? pageURLPath(check.change.to) : props.page.route;
  const canApply = props.allowed.rename && check.kind === 'valid' && !model.busy;
  const folders = [...props.folders].sort((left, right) => left.localeCompare(right));
  return (
    <form
      className="page-settings-field"
      onSubmit={(event) => {
        event.preventDefault();
        if (canApply) {
          void model.begin({ kind: 'rename', to: check.change.to });
        }
      }}
    >
      <label htmlFor={id}>{translate('pages.rename.urlName')}</label>
      <input
        id={id}
        value={dynamic ? original : name}
        readOnly={dynamic}
        maxLength={200}
        spellCheck={false}
        disabled={!props.allowed.rename || model.busy}
        aria-invalid={check.kind === 'invalid'}
        aria-describedby={id + '-status'}
        onChange={(event) => setName(event.currentTarget.value)}
      />
      {dynamic && <div className="page-settings-note">{translate('pages.settings.slug.dynamic')}</div>}
      <label>{translate('pages.settings.folder')}</label>
      <div className="page-settings-row">
        <Dropdown
          className="page-settings-folder"
          ariaLabel={translate('pages.settings.folder')}
          value={folder}
          disabled={!props.allowed.rename || model.busy}
          options={[{ value: '', label: translate('pages.settings.folder.root') }, ...folders.map((entry) => ({ value: entry, label: '/' + entry }))]}
          onChange={setFolder}
        />
        <button type="submit" className="primary" disabled={!canApply}>
          {translate('pages.settings.slug.apply')}
        </button>
      </div>
      <div className="page-settings-address">{translate('pages.settings.slug.address', { url: address })}</div>
      <div id={id + '-status'} className={check.kind === 'invalid' ? 'page-rename-error' : 'page-settings-note'} role="status">
        {check.kind === 'invalid'
          ? translateDescribed(check.problem)
          : check.kind === 'valid'
            ? translate('pages.settings.slug.available', { url: address })
            : ''}
      </div>
    </form>
  );
}

function HomeSection({ model, props }: { readonly model: Model; readonly props: PageSettingsDialogProps }) {
  const translate = useTranslate();
  const translateDescribed = useTranslateDescribed();
  const swap = homeSwapPlan(props.page.name, { pages: props.pages.map((page) => page.name), locales: props.locales ?? [] });
  const current = props.pages.find((page) => isHomePage(page.name));
  const unavailable = props.host.unavailable;
  const reason = !swap.ok ? translateDescribed(homeSwapRefusalText(swap.error)) : unavailable === undefined ? undefined : translateDescribed(unavailable);
  const allowed = props.allowed.rename;
  return (
    <div className="page-settings-field">
      {current !== undefined && (
        <div className="page-settings-note">{translate('pages.settings.home.current', { name: pageDisplayLabel(current, translate) })}</div>
      )}
      <HomeButton
        reason={reason}
        disabled={model.busy || !allowed}
        onClick={() => {
          if (swap.ok) {
            void model.begin({ kind: 'home', moves: swap.value });
          }
        }}
      />
      {reason !== undefined && <div className="page-settings-note page-settings-reason">{reason}</div>}
    </div>
  );
}

function HomeButton(props: { readonly reason: string | undefined; readonly disabled: boolean; readonly onClick: () => void }) {
  const translate = useTranslate();
  const tooltip = useDelayedTooltip();
  const host = useRef<HTMLSpanElement>(null);
  return (
    <span ref={host} className="page-settings-tip page-settings-home-button" onMouseEnter={tooltip.show} onMouseLeave={tooltip.hide}>
      <button type="button" disabled={props.disabled || props.reason !== undefined} onClick={props.onClick}>
        <HomeIcon size={13} />
        {translate('pages.settings.home.make')}
      </button>
      {tooltip.value !== undefined &&
        props.reason !== undefined &&
        createPortal(
          <div className="rail-tooltip below" role="tooltip" style={tooltip.value}>
            {props.reason}
          </div>,
          tooltipHost(host.current ?? undefined),
        )}
    </span>
  );
}

function ConfirmStep({ model, props }: { readonly model: Model; readonly props: PageSettingsDialogProps }) {
  const translate = useTranslate();
  const { step } = model;
  if (step.kind === 'settings') {
    return undefined;
  }
  const summary = step.kind === 'confirm' ? step.summary : undefined;
  return (
    <div className="page-settings-confirm">
      <div className="page-settings-confirm-title">{confirmTitle(step.action, props, translate)}</div>
      {summary === undefined ? (
        <SkeletonRows count={3} />
      ) : (
        <>
          <ul className="page-settings-bullets">
            {confirmLines(step.action, summary, props, translate).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <ReviewList summary={summary} />
        </>
      )}
      <div className="page-settings-confirm-buttons">
        <button type="button" disabled={step.kind === 'applying'} onClick={model.cancel}>
          {translate('ui.cancel')}
        </button>
        <button
          type="button"
          className={step.action.kind === 'remove' ? 'primary danger' : 'primary'}
          disabled={step.kind !== 'confirm'}
          onClick={() => void model.confirm()}
        >
          {step.action.kind === 'remove' ? translate('pages.settings.confirm.delete') : translate('pages.settings.confirm.confirm')}
        </button>
      </div>
    </div>
  );
}

function ReviewList({ summary }: { readonly summary: PageSettingsSummary }) {
  const translate = useTranslate();
  if (summary.reviews.length === 0) {
    return undefined;
  }
  return (
    <div className="page-settings-review">
      <div className="page-settings-note">{translate('pages.settings.confirm.review')}</div>
      <ul>
        {summary.reviews.map((review) => (
          <li key={review.file + ':' + review.line}>
            <span className="page-settings-review-place">
              {review.file}:{review.line}
            </span>
            <span className="page-settings-review-text">{review.text}</span>
          </li>
        ))}
      </ul>
      {summary.reviewsMore > 0 && <div className="page-settings-note">{translate('pages.settings.confirm.reviewMore', { count: summary.reviewsMore })}</div>}
    </div>
  );
}

type Translate = ReturnType<typeof useTranslate>;

function confirmTitle(action: Action, props: PageSettingsDialogProps, translate: Translate): string {
  const name = pageDisplayLabel(props.page, translate);
  switch (action.kind) {
    case 'rename':
      return translate('pages.settings.confirm.renameTitle', { url: pageURLPath(action.to) });
    case 'home':
      return translate('pages.settings.confirm.homeTitle', { name });
    case 'remove':
      return translate('pages.settings.confirm.deleteTitle', { name });
    case 'duplicate':
      return translate('pages.settings.duplicate');
    default: {
      const exhaustive: never = action;
      return exhaustive;
    }
  }
}

/** The confirm's short lines: what moves, how many links change, and that nothing else does. */
export function confirmLines(
  action: Action,
  summary: PageSettingsSummary,
  props: Pick<PageSettingsDialogProps, 'page' | 'pages'>,
  translate: Translate,
): readonly string[] {
  const files = translate('pages.settings.confirm.fileCount', { count: summary.files });
  const links = summary.links === 0 ? translate('pages.settings.confirm.noLinks') : translate('pages.settings.confirm.links', { count: summary.links, files });
  switch (action.kind) {
    case 'rename':
      return [
        translate('pages.settings.confirm.renameMoves', { from: props.page.route, to: pageURLPath(action.to) }),
        links,
        translate('pages.settings.confirm.nothingElse'),
      ];
    case 'home': {
      const name = pageDisplayLabel(props.page, translate);
      const home = props.pages.find((page) => page.name === action.moves.home.from);
      const homeName = home === undefined ? translate('ui.page.home') : pageDisplayLabel(home, translate);
      return [
        translate('pages.settings.confirm.homeBecomes', { name, file: 'src/pages/' + action.moves.page.to }),
        translate('pages.settings.confirm.oldHomeBecomes', {
          name: homeName,
          url: pageURLPath(action.moves.home.to),
          file: 'src/pages/' + action.moves.home.to,
        }),
        links,
        translate('pages.settings.confirm.nothingElse'),
      ];
    }
    case 'remove': {
      const lines = [translate('pages.settings.confirm.deleteFile', { file: 'src/pages/' + props.page.name })];
      if (/^(404|500)\./.test(props.page.name)) {
        lines.push(translate('pages.settings.confirm.deleteErrorPage'));
      }
      lines.push(
        summary.links === 0 ? translate('pages.settings.confirm.deleteNoLinks') : translate('pages.settings.confirm.deleteLinks', { count: summary.links }),
      );
      return lines;
    }
    case 'duplicate':
      return [];
    default: {
      const exhaustive: never = action;
      return exhaustive;
    }
  }
}
