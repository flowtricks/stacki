// The custom audit dialog: the project's own audits listed (each with its switch, Edit, Duplicate and Delete) and the editor
// that adds or changes one. The editor asks for a name, an icon, a category (a built-in one, one the project already uses, or
// a new name), a severity and what to look for: property names and plain value text, or, under "Regular expression", the
// expressions themselves over any scope. Below the fields, the live count: how many places in this project match right now,
// with a few of them, from the same bounded matcher the audit runs (shared/page/auditCustom.ts), recomputed a moment after
// typing stops, with skeleton rows while it computes.
//
// A field the guard refuses takes the error fill and says why in its tooltip; Save says it once in a toast. Nothing is ever
// appended under a field. Delete asks through the app's own confirmation. Every save writes `.stacki/audits.json` through the
// panel's writer, which re-audits.
import { useEffect, useMemo, useRef, useState } from 'react';
import { assert } from '../../../shared/core/assert';
import { scanCustomFiles, type CustomFilesScan } from '../../../shared/page/auditCustom';
import {
  CUSTOM_AUDIT_BUILTIN_CATEGORIES,
  CUSTOM_AUDIT_ICONS,
  CUSTOM_AUDIT_LIMITS,
  CUSTOM_AUDIT_PRESETS,
  CUSTOM_AUDIT_SCOPES,
  CUSTOM_AUDIT_SEVERITIES,
  builtinCategoryOf,
  compileCustomAudit,
  customAuditIdFor,
  type CustomAudit,
  type CustomAuditPreset,
  type CustomAuditScope,
  type CustomAuditSeverity,
} from '../../../shared/properties/customAudits';
import type { MessageKey, Translator } from '../../../shared/properties/i18n/messageRef';
import { useTranslate } from '../../lib/i18n/useTranslate';
import { CodeInline } from '../../ui/CodeBlock';
import { confirmDialog } from '../../ui/ConfirmDialog';
import Dropdown from '../../ui/Dropdown';
import { CloseIcon } from '../../ui/Icons';
import MoreMenu from '../../ui/MoreMenu';
import Popup from '../../ui/Popup';
import { SegmentedTabs } from '../../ui/SegmentedTabs';
import { SkeletonRows } from '../../ui/Skeleton';
import { Switch } from '../../ui/Switch';
import { CUSTOM_AUDIT_ICON_COMPONENTS } from './AuditIcons';
import { auditOf, EMPTY_CUSTOM_AUDIT_FORM, formOf, matchOf, type CustomAuditForm, type CustomAuditFormProblem } from './customAuditForm';
import type { LiveFiles } from './customAuditLive';
import './customAudits.css';

type Toast = (message: string, kind?: 'info' | 'success' | 'error') => void;

/** What the dialog shows: the list, or the editor for a new audit (from a preset or blank) or an existing one. */
export type CustomAuditView =
  { readonly kind: 'list' } | { readonly kind: 'new'; readonly preset: CustomAuditPreset | undefined } | { readonly kind: 'edit'; readonly id: string };

export interface CustomAuditDialogProps {
  readonly view: CustomAuditView;
  readonly audits: readonly CustomAudit[];
  /** Reads the files the live count runs over, once per open dialog. */
  readonly loadFiles: () => Promise<LiveFiles>;
  /** Writes the changed list; true once saved (a failure was already told). */
  readonly onSave: (change: (audits: readonly CustomAudit[]) => readonly CustomAudit[]) => Promise<boolean>;
  readonly showToast: Toast;
  readonly onClose: () => void;
}

/** How long typing must pause before the live count runs again. */
export const LIVE_DEBOUNCE_MS = 250;
/** Matching places the live count shows. */
export const LIVE_SAMPLES_MAX = 5;

export function CustomAuditDialog(props: CustomAuditDialogProps) {
  const translate = useTranslate();
  const [view, setView] = useState<CustomAuditView>(props.view);
  const title = view.kind === 'list' ? 'customAudits.dialog.listTitle' : view.kind === 'new' ? 'customAudits.dialog.newTitle' : 'customAudits.dialog.editTitle';
  return (
    <Popup className="modal custom-audit-dialog" label={translate(title)} onClose={props.onClose}>
      {({ close }) => (
        <>
          <div className="modal-header custom-audit-header">
            <h4>{translate(title)}</h4>
            <button type="button" className="ghost" aria-label={translate('ui.close')} title={translate('ui.close')} onClick={close}>
              <CloseIcon size={13} />
            </button>
          </div>
          {view.kind === 'list' ? (
            <AuditList {...props} onOpen={setView} />
          ) : (
            <AuditEditor
              key={view.kind === 'edit' ? view.id : (view.preset?.preset ?? 'blank')}
              {...props}
              view={view}
              onDone={() => (props.view.kind === 'list' ? setView({ kind: 'list' }) : close())}
            />
          )}
        </>
      )}
    </Popup>
  );
}

// ----- the list ---------------------------------------------------------------------------------

function AuditList(props: CustomAuditDialogProps & { readonly onOpen: (view: CustomAuditView) => void }) {
  const translate = useTranslate();
  return (
    <>
      <div className="modal-body custom-audit-list">
        {props.audits.length === 0 && <p className="custom-audit-empty">{translate('customAudits.list.empty')}</p>}
        {props.audits.map((audit) => {
          const Icon = CUSTOM_AUDIT_ICON_COMPONENTS[audit.icon];
          return (
            <div key={audit.id} className="custom-audit-item">
              <span className="custom-audit-item-icon">
                <Icon size={14} />
              </span>
              <button type="button" className="ghost custom-audit-item-name" title={audit.name} onClick={() => props.onOpen({ kind: 'edit', id: audit.id })}>
                {audit.name}
                <span className="custom-audit-item-category">{categoryLabel(audit.category, translate)}</span>
              </button>
              <Switch
                label={translate('customAudits.list.enabled', { name: audit.name })}
                checked={audit.enabled}
                onToggle={() => void props.onSave((audits) => audits.map((entry) => (entry.id === audit.id ? { ...entry, enabled: !entry.enabled } : entry)))}
              />
              <AuditItemMenu audit={audit} {...props} />
            </div>
          );
        })}
      </div>
      <div className="modal-footer">
        <PresetMenu label={translate('customAudits.list.add')} onPick={(preset) => props.onOpen({ kind: 'new', preset })} />
      </div>
    </>
  );
}

function AuditItemMenu(props: CustomAuditDialogProps & { readonly audit: CustomAudit; readonly onOpen: (view: CustomAuditView) => void }) {
  const translate = useTranslate();
  return (
    <MoreMenu
      title={translate('auditsUi.more')}
      width={180}
      items={[
        { label: translate('customAudits.row.edit'), onSelect: () => props.onOpen({ kind: 'edit', id: props.audit.id }) },
        { label: translate('customAudits.row.duplicate'), onSelect: () => void duplicateAudit(props.audit, props, translate) },
        { label: translate('customAudits.row.delete'), danger: true, onSelect: () => void deleteAudit(props.audit, props, translate) },
      ]}
    />
  );
}

/** Adds a copy of `audit` named "<name> copy", under a fresh id, after it in the list. */
export async function duplicateAudit(audit: CustomAudit, props: Pick<CustomAuditDialogProps, 'onSave' | 'showToast'>, translate: Translator): Promise<void> {
  const saved = await props.onSave((audits) => {
    const name = translate('customAudits.copyName', { name: audit.name }).slice(0, CUSTOM_AUDIT_LIMITS.nameCharsMax);
    const copy: CustomAudit = {
      ...audit,
      name,
      id: customAuditIdFor(
        name,
        audits.map((entry) => entry.id),
      ),
    };
    if (audits.length >= CUSTOM_AUDIT_LIMITS.auditsMax) {
      throw new Error(translate('customAudits.problem.full', { count: CUSTOM_AUDIT_LIMITS.auditsMax }));
    }
    const at = audits.findIndex((entry) => entry.id === audit.id);
    return [...audits.slice(0, at + 1), copy, ...audits.slice(at + 1)];
  });
  if (saved) {
    props.showToast(translate('customAudits.toast.duplicated'), 'success');
  }
}

/** Deletes `audit` after the app's own confirmation (Cancel is focused). */
export async function deleteAudit(audit: CustomAudit, props: Pick<CustomAuditDialogProps, 'onSave' | 'showToast'>, translate: Translator): Promise<boolean> {
  const answer = await confirmDialog({
    title: translate('customAudits.delete.title', { name: audit.name }),
    body: translate('customAudits.delete.body'),
    confirmLabel: translate('customAudits.delete.confirm'),
    danger: true,
  });
  if (answer === false) {
    return false;
  }
  const saved = await props.onSave((audits) => audits.filter((entry) => entry.id !== audit.id));
  if (saved) {
    props.showToast(translate('customAudits.toast.deleted'), 'success');
  }
  return saved;
}

function PresetMenu(props: { readonly label: string; readonly onPick: (preset: CustomAuditPreset | undefined) => void }) {
  const translate = useTranslate();
  return (
    <Dropdown<string>
      ariaLabel={props.label}
      className="custom-audit-add"
      menuWidthMin={260}
      placeholder={props.label}
      value=""
      options={[
        { value: 'blank', label: translate('customAudits.preset.blank') },
        ...CUSTOM_AUDIT_PRESETS.map((preset) => ({ value: preset.preset, label: presetName(preset, translate) })),
      ]}
      onChange={(value) => props.onPick(CUSTOM_AUDIT_PRESETS.find((preset) => preset.preset === value))}
    />
  );
}

// ----- the editor -------------------------------------------------------------------------------

function AuditEditor(props: CustomAuditDialogProps & { readonly view: Exclude<CustomAuditView, { readonly kind: 'list' }>; readonly onDone: () => void }) {
  const translate = useTranslate();
  const view = props.view;
  const existing = view.kind === 'edit' ? props.audits.find((audit) => audit.id === view.id) : undefined;
  const [form, setForm] = useState<CustomAuditForm>(() => initialForm(props.view, existing, translate));
  const [newCategory, setNewCategory] = useState(builtinCategoryOf(form.category) === undefined && !knownCategories(props.audits).includes(form.category));
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof CustomAuditForm>(field: K, value: CustomAuditForm[K]): void => setForm((current) => ({ ...current, [field]: value }));
  const problem = matchOf(form);
  const fieldProblem = !problem.ok && problem.error.kind === 'pattern' ? problem.error.problem : undefined;
  const invalid = (field: string): { readonly 'aria-invalid'?: true; readonly title?: string } =>
    fieldProblem?.field === field ? { 'aria-invalid': true, title: problemText({ kind: 'pattern', problem: fieldProblem }, translate) } : {};
  const save = async (): Promise<void> => {
    const audit = auditOf(form, {
      id: existing?.id,
      enabled: existing?.enabled ?? true,
      taken: props.audits.map((entry) => entry.id),
    });
    if (!audit.ok) {
      props.showToast(problemText(audit.error, translate), 'error');
      return;
    }
    if (existing === undefined && props.audits.length >= CUSTOM_AUDIT_LIMITS.auditsMax) {
      props.showToast(translate('customAudits.problem.full', { count: CUSTOM_AUDIT_LIMITS.auditsMax }), 'error');
      return;
    }
    setSaving(true);
    const saved = await props.onSave((audits) =>
      audits.some((entry) => entry.id === audit.value.id)
        ? audits.map((entry) => (entry.id === audit.value.id ? audit.value : entry))
        : [...audits, audit.value],
    );
    setSaving(false);
    if (saved) {
      props.showToast(translate('customAudits.toast.saved'), 'success');
      props.onDone();
    }
  };
  return (
    <>
      <div className="modal-body custom-audit-body">
        <label>
          {translate('customAudits.field.name')}
          <input
            value={form.name}
            maxLength={CUSTOM_AUDIT_LIMITS.nameCharsMax}
            placeholder={translate('customAudits.field.namePlaceholder')}
            onChange={(event) => set('name', event.target.value)}
          />
        </label>
        <div className="custom-audit-row">
          <IconField value={form.icon} onChange={(icon) => set('icon', icon)} />
          <div className="custom-audit-grow">
            <span className="custom-audit-label">{translate('customAudits.field.category')}</span>
            <Dropdown<string>
              ariaLabel={translate('customAudits.field.category')}
              value={newCategory ? NEW_CATEGORY : form.category}
              options={categoryOptions(props.audits, form.category, translate)}
              onChange={(value) => {
                if (value === NEW_CATEGORY) {
                  setNewCategory(true);
                  set('category', '');
                } else {
                  setNewCategory(false);
                  set('category', value);
                }
              }}
            />
            {newCategory && (
              <input
                aria-label={translate('customAudits.field.categoryName')}
                className="custom-audit-category-name"
                value={form.category}
                maxLength={CUSTOM_AUDIT_LIMITS.categoryCharsMax}
                placeholder={translate('customAudits.field.categoryPlaceholder')}
                onChange={(event) => set('category', event.target.value)}
              />
            )}
          </div>
        </div>
        <div>
          <span className="custom-audit-label">{translate('customAudits.field.severity')}</span>
          <SegmentedTabs<CustomAuditSeverity>
            label={translate('customAudits.field.severity')}
            value={form.severity}
            tabs={CUSTOM_AUDIT_SEVERITIES.map((severity) => ({ value: severity, label: translate(SEVERITY_LABELS[severity]) }))}
            onPick={(severity) => set('severity', severity)}
          />
        </div>
        <div className="custom-audit-look">
          <span className="custom-audit-label">{translate('customAudits.field.mode')}</span>
          <SegmentedTabs<CustomAuditForm['mode']>
            label={translate('customAudits.field.mode')}
            value={form.mode}
            tabs={[
              { value: 'simple', label: translate('customAudits.mode.simple') },
              { value: 'advanced', label: translate('customAudits.mode.advanced') },
            ]}
            onPick={(mode) => setForm((current) => switchedMode(current, mode))}
          />
          {form.mode === 'simple' ? (
            <>
              <label>
                {translate('customAudits.field.properties')}
                <input
                  className="custom-audit-code"
                  value={form.properties}
                  placeholder="text-align, color, border*"
                  spellCheck={false}
                  aria-invalid={!problem.ok && problem.error.kind === 'properties' && form.properties.length > 0 ? true : undefined}
                  onChange={(event) => set('properties', event.target.value)}
                />
              </label>
              <p className="hint-text">{translate('customAudits.field.propertiesHint')}</p>
              <label>
                {translate('customAudits.field.valueContains')}
                <input
                  className="custom-audit-code"
                  value={form.valueContains}
                  placeholder="var(--swatch-"
                  spellCheck={false}
                  onChange={(event) => set('valueContains', event.target.value)}
                />
              </label>
              <label>
                {translate('customAudits.field.valueLacks')}
                <input
                  className="custom-audit-code"
                  value={form.valueLacks}
                  placeholder="var("
                  spellCheck={false}
                  onChange={(event) => set('valueLacks', event.target.value)}
                />
              </label>
            </>
          ) : (
            <>
              <div>
                <span className="custom-audit-label">{translate('customAudits.field.scope')}</span>
                <Dropdown<CustomAuditScope>
                  ariaLabel={translate('customAudits.field.scope')}
                  value={form.scope}
                  options={CUSTOM_AUDIT_SCOPES.map((scope) => ({ value: scope, label: translate(SCOPE_LABELS[scope]) }))}
                  onChange={(scope) => set('scope', scope)}
                />
              </div>
              {form.scope === 'declaration' ? (
                <>
                  <PatternField
                    label={translate('customAudits.field.property')}
                    placeholder="^text-align$"
                    value={form.property}
                    {...invalid('property')}
                    onChange={(property) => set('property', property)}
                  />
                  <PatternField
                    label={translate('customAudits.field.valueMustMatch')}
                    placeholder="var\(\s*--swatch-"
                    value={form.valueMustMatch}
                    {...invalid('valueMustMatch')}
                    onChange={(valueMustMatch) => set('valueMustMatch', valueMustMatch)}
                  />
                  <PatternField
                    label={translate('customAudits.field.valueMustNotMatch')}
                    placeholder="var\("
                    value={form.valueMustNotMatch}
                    {...invalid('valueMustNotMatch')}
                    onChange={(valueMustNotMatch) => set('valueMustNotMatch', valueMustNotMatch)}
                  />
                </>
              ) : (
                <PatternField
                  label={translate('customAudits.field.pattern')}
                  placeholder={form.scope === 'markup' ? '\\bTODO\\b' : 'url\\(http:'}
                  value={form.pattern}
                  {...invalid('pattern')}
                  onChange={(pattern) => set('pattern', pattern)}
                />
              )}
              <PatternField
                label={`${translate('customAudits.field.exclude')} · ${translate('customAudits.field.optional')}`}
                placeholder="inherit|initial"
                value={form.exclude}
                {...invalid('exclude')}
                onChange={(exclude) => set('exclude', exclude)}
              />
            </>
          )}
        </div>
        <label>
          {`${translate('customAudits.field.message')} · ${translate('customAudits.field.optional')}`}
          <input
            value={form.message}
            maxLength={CUSTOM_AUDIT_LIMITS.messageCharsMax}
            placeholder={translate('customAudits.field.messagePlaceholder')}
            onChange={(event) => set('message', event.target.value)}
          />
        </label>
        <LiveCount form={form} loadFiles={props.loadFiles} />
      </div>
      <div className="modal-footer">
        {existing !== undefined && (
          <button
            type="button"
            className="danger custom-audit-delete"
            onClick={() => void deleteAudit(existing, props, translate).then((deleted) => (deleted ? props.onDone() : undefined))}
          >
            {translate('customAudits.delete.confirm')}
          </button>
        )}
        <button type="button" onClick={props.onDone}>
          {translate('ui.cancel')}
        </button>
        <button
          type="button"
          className="primary"
          disabled={saving}
          title={problem.ok ? undefined : problemText(problem.error, translate)}
          onClick={() => void save()}
        >
          {translate('customAudits.save')}
        </button>
      </div>
    </>
  );
}

const NEW_CATEGORY = '\u0000new';

function initialForm(view: Exclude<CustomAuditView, { readonly kind: 'list' }>, existing: CustomAudit | undefined, translate: Translator): CustomAuditForm {
  if (existing !== undefined) {
    return formOf(existing);
  }
  if (view.kind === 'new' && view.preset !== undefined) {
    // A preset is added in the language on screen: its name and message become the project's own words.
    const preset = view.preset;
    return formOf({ ...preset.audit, name: presetName(preset, translate), message: presetMessage(preset, translate) });
  }
  return EMPTY_CUSTOM_AUDIT_FORM;
}

// Moving to the advanced mode carries the simple rule over as the expressions it stands for; moving back keeps the simple
// fields as they were, since an arbitrary expression has no simple form.
function switchedMode(form: CustomAuditForm, mode: CustomAuditForm['mode']): CustomAuditForm {
  if (mode === form.mode) {
    return form;
  }
  if (mode === 'advanced') {
    const described = matchOf(form);
    if (described.ok && described.value.match.scope === 'declaration') {
      const match = described.value.match;
      return {
        ...form,
        mode,
        scope: 'declaration',
        property: match.property,
        valueMustMatch: match.valueMustMatch ?? '',
        valueMustNotMatch: match.valueMustNotMatch ?? '',
      };
    }
    return { ...form, mode };
  }
  return { ...form, mode };
}

function PatternField(props: {
  readonly label: string;
  readonly placeholder: string;
  readonly value: string;
  readonly 'aria-invalid'?: true;
  readonly title?: string;
  readonly onChange: (value: string) => void;
}) {
  return (
    <label title={props.title}>
      {props.label}
      <input
        className="custom-audit-code"
        value={props.value}
        maxLength={CUSTOM_AUDIT_LIMITS.patternCharsMax}
        placeholder={props.placeholder}
        spellCheck={false}
        aria-invalid={props['aria-invalid']}
        onChange={(event) => props.onChange(event.target.value)}
      />
    </label>
  );
}

// The icon: a custom dropdown of the icons the panel already draws, each named.
function IconField(props: { readonly value: CustomAudit['icon']; readonly onChange: (icon: CustomAudit['icon']) => void }) {
  const translate = useTranslate();
  return (
    <div className="custom-audit-icon-field">
      <span className="custom-audit-label">{translate('customAudits.field.icon')}</span>
      <Dropdown<CustomAudit['icon']>
        ariaLabel={translate('customAudits.field.icon')}
        className="custom-audit-icon-pick"
        menuWidthMin={200}
        rowsMax={10}
        value={props.value}
        options={CUSTOM_AUDIT_ICONS.map((icon) => {
          const Option = CUSTOM_AUDIT_ICON_COMPONENTS[icon];
          return { value: icon, label: translate(ICON_LABELS[icon]), icon: <Option size={14} /> };
        })}
        onChange={props.onChange}
      />
    </div>
  );
}

// The live count: the same matcher over the files read when the dialog opened, a moment after the last change.
function LiveCount(props: { readonly form: CustomAuditForm; readonly loadFiles: () => Promise<LiveFiles> }) {
  const translate = useTranslate();
  const [files, setFiles] = useState<LiveFiles | undefined>(undefined);
  const [scan, setScan] = useState<{ readonly key: string; readonly result: CustomFilesScan } | undefined>(undefined);
  const load = useRef(props.loadFiles);
  useEffect(() => {
    let live = true;
    void load.current().then((read) => {
      if (live) {
        setFiles(read);
      }
    });
    return () => {
      live = false;
    };
  }, []);
  const described = matchOf(props.form);
  const key = described.ok ? JSON.stringify(described.value) : '';
  const compiled = useMemo(() => (described.ok ? compileCustomAudit(described.value) : undefined), [key]); // eslint-disable-line react-hooks/exhaustive-deps -- `key` is the described match, serialized
  useEffect(() => {
    if (files === undefined || compiled === undefined || !compiled.ok || compiled.value.scope === 'rendered') {
      return undefined;
    }
    const matcher = compiled.value;
    const timer = setTimeout(() => {
      const startedMs = performance.now();
      setScan({ key, result: scanCustomFiles(files.files, matcher, { samplesMax: LIVE_SAMPLES_MAX, startedMs }, () => performance.now()) });
    }, LIVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [files, compiled, key]);
  if (!described.ok) {
    return <section className="custom-audit-live" aria-label={translate('customAudits.live.label')} />;
  }
  if (described.value.match.scope === 'rendered') {
    return (
      <section className="custom-audit-live" aria-label={translate('customAudits.live.label')}>
        <span className="custom-audit-live-count">{translate('customAudits.live.rendered')}</span>
      </section>
    );
  }
  const current = scan?.key === key ? scan.result : undefined;
  if (current === undefined) {
    return (
      <section className="custom-audit-live" aria-label={translate('customAudits.live.label')} aria-busy="true">
        <SkeletonRows count={3} />
      </section>
    );
  }
  const more = current.stopped !== 'complete' || files?.partial === true;
  return (
    <section className="custom-audit-live" aria-label={translate('customAudits.live.label')} role="status">
      <span className="custom-audit-live-count">{translate(more ? 'customAudits.live.countMore' : 'customAudits.live.count', { count: current.count })}</span>
      {current.samples.map((sample, index) => (
        <div key={`${sample.file}:${sample.line}:${index}`} className="custom-audit-sample">
          <span className="custom-audit-sample-where" title={`${sample.file}:${sample.line}`}>
            {`${sample.file.split('/').pop() ?? sample.file}:${sample.line}`}
          </span>
          <CodeInline text={sample.text} language={sample.file.endsWith('.astro') && props.form.scope === 'markup' ? 'astro' : 'css'} />
        </div>
      ))}
    </section>
  );
}

// ----- labels -----------------------------------------------------------------------------------

const SEVERITY_LABELS: Readonly<Record<CustomAuditSeverity, MessageKey>> = {
  high: 'customAudits.severity.high',
  medium: 'customAudits.severity.medium',
  low: 'customAudits.severity.low',
};

const SCOPE_LABELS: Readonly<Record<CustomAuditScope, MessageKey>> = {
  declaration: 'customAudits.scope.declaration',
  css: 'customAudits.scope.css',
  markup: 'customAudits.scope.markup',
  rendered: 'customAudits.scope.rendered',
};

const BUILTIN_CATEGORY_LABELS: Readonly<Record<(typeof CUSTOM_AUDIT_BUILTIN_CATEGORIES)[number], MessageKey>> = {
  accessibility: 'auditsUi.filter.accessibility',
  seo: 'auditsUi.filter.seo',
  content: 'auditsUi.filter.content',
  tokens: 'auditsUi.filter.tokens',
  performance: 'auditsUi.filter.performance',
};

const ICON_LABELS: Readonly<Record<CustomAudit['icon'], MessageKey>> = {
  droplet: 'customAudits.icon.droplet',
  text: 'customAudits.icon.text',
  ruler: 'customAudits.icon.ruler',
  variable: 'customAudits.icon.variable',
  layers: 'customAudits.icon.layers',
  tag: 'customAudits.icon.tag',
  braces: 'customAudits.icon.braces',
  image: 'customAudits.icon.image',
  link: 'customAudits.icon.link',
  globe: 'customAudits.icon.globe',
  hash: 'customAudits.icon.hash',
  heading: 'customAudits.icon.heading',
  contrast: 'customAudits.icon.contrast',
  form: 'customAudits.icon.form',
  accessibility: 'customAudits.icon.accessibility',
  placeholder: 'customAudits.icon.placeholder',
  star: 'customAudits.icon.star',
  chart: 'customAudits.icon.chart',
  gauge: 'customAudits.icon.gauge',
  block: 'customAudits.icon.block',
  file: 'customAudits.icon.file',
  hide: 'customAudits.icon.hide',
  clock: 'customAudits.icon.clock',
  target: 'customAudits.icon.target',
};

const PRESET_LABELS: Readonly<Record<string, { readonly name: MessageKey; readonly message: MessageKey }>> = {
  'hard-coded-text-align': { name: 'customAudits.preset.textAlign.name', message: 'customAudits.preset.textAlign.message' },
  'core-swatch-instead-of-theme': { name: 'customAudits.preset.coreSwatch.name', message: 'customAudits.preset.coreSwatch.message' },
  important: { name: 'customAudits.preset.important.name', message: 'customAudits.preset.important.message' },
  'hard-coded-z-index': { name: 'customAudits.preset.zIndex.name', message: 'customAudits.preset.zIndex.message' },
  'inline-style': { name: 'customAudits.preset.inlineStyle.name', message: 'customAudits.preset.inlineStyle.message' },
  'todo-comment': { name: 'customAudits.preset.todo.name', message: 'customAudits.preset.todo.message' },
};

function presetName(preset: CustomAuditPreset, translate: Translator): string {
  const keys = PRESET_LABELS[preset.preset];
  return keys === undefined ? preset.audit.name : translate(keys.name);
}

function presetMessage(preset: CustomAuditPreset, translate: Translator): string | undefined {
  const keys = PRESET_LABELS[preset.preset];
  return keys === undefined ? preset.audit.message : translate(keys.message);
}

/** A category's name on screen: a built-in one translated, the project's own as written. */
export function categoryLabel(category: string, translate: Translator): string {
  const builtin = builtinCategoryOf(category);
  return builtin === undefined ? category : translate(BUILTIN_CATEGORY_LABELS[builtin]);
}

function knownCategories(audits: readonly CustomAudit[]): readonly string[] {
  return [...new Set(audits.map((audit) => audit.category).filter((category) => builtinCategoryOf(category) === undefined))].sort();
}

function categoryOptions(
  audits: readonly CustomAudit[],
  current: string,
  translate: Translator,
): readonly { readonly value: string; readonly label: string }[] {
  const own = knownCategories(audits);
  const extra = current.length > 0 && builtinCategoryOf(current) === undefined && !own.includes(current) ? [current] : [];
  const options = [
    ...CUSTOM_AUDIT_BUILTIN_CATEGORIES.map((id) => ({ value: id, label: translate(BUILTIN_CATEGORY_LABELS[id]) })),
    ...[...own, ...extra].map((name) => ({ value: name, label: name })),
    { value: NEW_CATEGORY, label: translate('customAudits.category.new') },
  ];
  assert(options.length <= CUSTOM_AUDIT_BUILTIN_CATEGORIES.length + CUSTOM_AUDIT_LIMITS.auditsMax + 2, 'categoryOptions: bounded by the audits');
  return options;
}

const PROBLEM_KEYS: Readonly<Record<Extract<CustomAuditFormProblem, { readonly kind: 'pattern' }>['problem']['code'], MessageKey>> = {
  empty: 'customAudits.problem.empty',
  'too-long': 'customAudits.problem.tooLong',
  invalid: 'customAudits.problem.invalid',
  backreference: 'customAudits.problem.backreference',
  'nested-repeat': 'customAudits.problem.nestedRepeat',
  'too-many-repeats': 'customAudits.problem.tooManyRepeats',
  'matches-empty': 'customAudits.problem.matchesEmpty',
};

/** Why a form cannot be saved, in the language on screen. */
export function problemText(problem: CustomAuditFormProblem, translate: Translator): string {
  switch (problem.kind) {
    case 'name':
      return translate('customAudits.problem.name');
    case 'category':
      return translate('customAudits.problem.category');
    case 'properties':
      return translate('customAudits.problem.properties');
    case 'pattern':
      return translate(PROBLEM_KEYS[problem.problem.code], { count: CUSTOM_AUDIT_LIMITS.patternCharsMax, repeats: CUSTOM_AUDIT_LIMITS.repeatsUnboundedMax });
    default: {
      const exhaustive: never = problem;
      return exhaustive;
    }
  }
}
