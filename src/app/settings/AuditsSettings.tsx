// Settings → Audits: which checks run and how loud, the design-token rules and
// the placeholder phrases (under Placeholders), kept in the project's tracked `.stacki/audits.json`
// beside its ignored findings (shared/properties/auditIgnores.ts). It reads like
// the Roles tab: collapsible sections with an "All" switch and a count, and rows
// on a two-column grid — the check's icon, its name over a short description,
// then its switch; a check's priority is in the row's ⋯. Every change saves at
// once, against the bytes it was read from, and the panel audits again.
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { AUDIT_CATEGORIES, AUDIT_CHECKS, AUDIT_CHECK_IDS, type AuditCategory, type AuditCheckId } from '../../../shared/page/auditFindings';
import {
  withCheckSetting,
  type AuditCheckSetting,
  type AuditFile,
  type AuditSettingPriority,
  type AuditTokenSettings,
} from '../../../shared/properties/auditIgnores';
import { can } from '../../../shared/properties/projectRoles';
import { useCurrentRole } from '../../lib/useCurrentRole';
import { ChevronRightIcon, CloseIcon } from '../../ui/Icons';
import MoreMenu from '../../ui/MoreMenu';
import { Skeleton, SkeletonRows } from '../../ui/Skeleton';
import { Switch } from '../../ui/Switch';
import { useTranslate } from '../../lib/i18n/useTranslate';
import type { MessageKey } from '../../lib/i18n/localeContext';
import InfoHint from '../../ui/InfoHint';
import { AUDIT_ICONS } from '../../features/audits/AuditIcons';
import { readAuditIgnores, saveAuditIgnores, type StoredIgnores } from '../../features/audits/auditsBridge';
import { updateAuditState } from '../../features/audits/auditStore';
import { useAuditText } from '../../features/audits/useAuditText';
import '../../features/audits/audits.css';
import './roles.css';

/** Placeholder rows drawn while the audit file is first read: a few checks' worth. */
const AUDIT_SETTINGS_SKELETON_ROWS = 6;

// Keys, not words: the language can change while the screen is open, so the text is looked up where it is drawn.
const CATEGORY_KEYS: Readonly<Record<AuditCategory, MessageKey>> = {
  accessibility: 'settings.audits.category.accessibility',
  seo: 'settings.audits.category.seo',
  content: 'settings.audits.category.content',
  tokens: 'settings.audits.category.tokens',
  performance: 'settings.audits.category.performance',
};
const PRIORITY_KEYS: Readonly<Record<AuditSettingPriority, MessageKey>> = {
  high: 'settings.audits.priority.high',
  medium: 'settings.audits.priority.medium',
  low: 'settings.audits.priority.low',
};

type State = { readonly kind: 'loading' } | { readonly kind: 'error'; readonly message: string } | { readonly kind: 'ready'; readonly stored: StoredIgnores };

const DEFAULT_SETTING: AuditCheckSetting = { enabled: true, priority: undefined };

export function AuditsSettings({ projectPath }: { readonly projectPath: string }) {
  const translate = useTranslate();
  const role = useCurrentRole();
  const editable = can(role, 'settings:audits') || can(role, 'panel:audits');
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [problem, setProblem] = useState<string>();
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set(['accessibility']));
  const load = useCallback(() => {
    void readAuditIgnores(projectPath).then((read) => setState(read.ok ? { kind: 'ready', stored: read.value } : { kind: 'error', message: read.error }));
  }, [projectPath]);
  useEffect(load, [load]);
  if (state.kind === 'loading') {
    return <SkeletonRows count={AUDIT_SETTINGS_SKELETON_ROWS} row={() => <Skeleton height="28px" radius="8px" />} />;
  }
  if (state.kind === 'error') {
    return (
      <div className="props-empty" role="alert">
        {state.message}
      </div>
    );
  }
  const file = state.stored.value;
  const save = async (next: AuditFile): Promise<void> => {
    const saved = await saveAuditIgnores(projectPath, state.stored, next);
    if (saved.ok) {
      setState({ kind: 'ready', stored: saved.value });
      setProblem(undefined);
      updateAuditState((current) => ({ ...current, ignores: saved.value, request: current.request + 1 }));
    } else {
      setProblem(saved.error);
      load();
    }
  };
  const toggleSection = (key: string): void =>
    setOpen((current) => {
      const next = new Set(current);
      if (!next.delete(key)) {
        next.add(key);
      }
      return next;
    });
  const setting = (id: AuditCheckId): AuditCheckSetting => file.checks[id] ?? DEFAULT_SETTING;
  const tokens = (next: AuditTokenSettings): AuditFile => ({ ...file, tokens: next });
  return (
    <div className="audits-settings">
      {problem !== undefined && (
        <p className="audits-note" role="alert">
          {problem}
        </p>
      )}
      {AUDIT_CATEGORIES.map((category) => {
        const ids = AUDIT_CHECK_IDS.filter((id) => AUDIT_CHECKS[id].category === category);
        const on = ids.filter((id) => setting(id).enabled).length;
        const all = on === ids.length;
        return (
          <Section
            key={category}
            title={translate(CATEGORY_KEYS[category])}
            summary={translate('settings.audits.summary', { on, total: ids.length })}
            open={open.has(category)}
            onToggle={() => toggleSection(category)}
            all={{
              checked: all,
              disabled: !editable,
              onToggle: () => void save(ids.reduce((next, id) => withCheckSetting(next, id, { ...setting(id), enabled: !all }), file)),
            }}
          >
            <div className="app-role-group audits-settings-grid">
              {ids.map((id) => (
                <CheckRow key={id} id={id} setting={setting(id)} editable={editable} onChange={(next) => void save(withCheckSetting(file, id, next))} />
              ))}
            </div>
            {category === 'content' && (
              <div className="audits-settings-subpanel">
                <h5>
                  {translate('settings.audits.phrases.title')}
                  <InfoHint text={translate('settings.audits.phrases.info')} />
                </h5>
                <ChipList
                  items={file.placeholders}
                  placeholder={translate('settings.audits.phrases.add')}
                  disabled={!editable}
                  onChange={(placeholders) => void save({ ...file, placeholders })}
                />
              </div>
            )}
            {category === 'tokens' && (
              <div className="audits-settings-subpanel">
                <h5>{translate('settings.audits.rules.title')}</h5>
                <div className="app-role-group audits-settings-grid">
                  <PlainSwitch
                    label={translate('settings.audits.rules.colors')}
                    description={translate('settings.audits.rules.colorsInfo')}
                    checked={file.tokens.colors}
                    disabled={!editable}
                    onToggle={() => void save(tokens({ ...file.tokens, colors: !file.tokens.colors }))}
                  />
                  <PlainSwitch
                    label={translate('settings.audits.rules.pxLabel')}
                    description={translate('settings.audits.rules.px')}
                    checked={file.tokens.px}
                    disabled={!editable}
                    onToggle={() => void save(tokens({ ...file.tokens, px: !file.tokens.px }))}
                  />
                  <PlainSwitch
                    label={translate('settings.audits.rules.remLabel')}
                    description={translate('settings.audits.rules.remInfo')}
                    checked={file.tokens.remOutsideVariables}
                    disabled={!editable}
                    onToggle={() => void save(tokens({ ...file.tokens, remOutsideVariables: !file.tokens.remOutsideVariables }))}
                  />
                </div>
                <h5>{translate('settings.audits.properties.title')}</h5>
                <ChipList
                  items={file.tokens.properties}
                  placeholder={translate('settings.audits.properties.add')}
                  disabled={!editable}
                  onChange={(properties) => void save(tokens({ ...file.tokens, properties }))}
                />
                <h5>{translate('settings.audits.allowed.title')}</h5>
                <ChipList
                  items={file.tokens.allowed}
                  placeholder={translate('settings.audits.allowed.add')}
                  disabled={!editable}
                  onChange={(allowed) => void save(tokens({ ...file.tokens, allowed: allowed.map((item) => item.toLowerCase()) }))}
                />
              </div>
            )}
          </Section>
        );
      })}
    </div>
  );
}

// A collapsible group: its name and count, the "All" switch at the right, the body below.
function Section(props: {
  readonly title: string;
  readonly summary: string;
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly all: { readonly checked: boolean; readonly disabled: boolean; readonly onToggle: () => void } | undefined;
  readonly children: ReactNode;
}) {
  const translate = useTranslate();
  return (
    <section className="audits-settings-section" data-open={props.open ? 'true' : 'false'}>
      <div className="app-role-group-heading audits-settings-heading">
        <button type="button" className="audits-settings-disclosure" aria-expanded={props.open} onClick={props.onToggle}>
          <ChevronRightIcon size={12} />
          <h4>{props.title}</h4>
          <span className="audits-settings-summary">{props.summary}</span>
        </button>
        {props.all !== undefined && (
          <span className="app-role-group-all">
            {translate('settings.audits.all')}
            <Switch
              label={translate('settings.audits.allLabel', { title: props.title })}
              checked={props.all.checked}
              disabled={props.all.disabled}
              onToggle={props.all.onToggle}
            />
          </span>
        )}
      </div>
      {props.open && <div className="audits-settings-body">{props.children}</div>}
    </section>
  );
}

function CheckRow(props: {
  readonly id: AuditCheckId;
  readonly setting: AuditCheckSetting;
  readonly editable: boolean;
  readonly onChange: (next: AuditCheckSetting) => void;
}) {
  const check = AUDIT_CHECKS[props.id];
  const translate = useTranslate();
  const auditText = useAuditText();
  const Icon = AUDIT_ICONS[props.id];
  const priority = props.setting.priority;
  return (
    <div className="app-role-toggle audits-settings-row">
      <span className="app-role-toggle-icon" aria-hidden="true">
        <Icon size={14} />
      </span>
      <span className="app-role-app-permission-text">
        <span className="app-role-toggle-label" title={auditText.checkTitle(props.id)}>
          {auditText.checkTitle(props.id)}
          {/* Why the check matters is audit-definition text (shared/page/auditFindings.ts), shown as the (i) tip. */}
          <InfoHint text={auditText.checkWhy(props.id)} />
          {priority !== undefined && <span className="audits-settings-priority">{translate(PRIORITY_KEYS[priority])}</span>}
        </span>
      </span>
      <span className="audits-settings-controls">
        {props.setting.enabled && props.editable && (
          <MoreMenu
            className="audits-icon-button"
            title={translate('settings.audits.priority.title', { name: auditText.checkTitle(props.id) })}
            width={170}
            items={[
              {
                label: translate('settings.audits.priority.default', { priority: translate(PRIORITY_KEYS[check.priority]) }),
                current: priority === undefined,
                onSelect: () => props.onChange({ ...props.setting, priority: undefined }),
              },
              ...(['high', 'medium', 'low'] as const).map((level) => ({
                label: translate(PRIORITY_KEYS[level]),
                current: priority === level,
                onSelect: () => props.onChange({ ...props.setting, priority: level }),
              })),
            ]}
          />
        )}
        <Switch
          label={auditText.checkTitle(props.id)}
          checked={props.setting.enabled}
          disabled={!props.editable}
          onToggle={() => props.onChange({ ...props.setting, enabled: !props.setting.enabled })}
        />
      </span>
    </div>
  );
}

function PlainSwitch(props: {
  readonly label: string;
  readonly description: string;
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly onToggle: () => void;
}) {
  return (
    <div className="app-role-toggle audits-settings-row audits-settings-plain">
      <span className="app-role-app-permission-text">
        <span className="app-role-toggle-label" title={props.label}>
          {props.label}
        </span>
        <span className="app-role-app-permission-description audits-settings-description">{props.description}</span>
      </span>
      <Switch label={props.label} checked={props.checked} disabled={props.disabled} onToggle={props.onToggle} />
    </div>
  );
}

// A list as chips: each with its remove, and a field that adds one on Enter.
function ChipList(props: {
  readonly items: readonly string[];
  readonly placeholder: string;
  readonly disabled: boolean;
  readonly onChange: (items: readonly string[]) => void;
}) {
  const translate = useTranslate();
  const [draft, setDraft] = useState('');
  const add = (): void => {
    const value = draft.trim();
    if (value.length === 0 || value.length > 120 || props.items.includes(value) || props.items.length >= 200) {
      return;
    }
    props.onChange([...props.items, value]);
    setDraft('');
  };
  return (
    <div className="audits-chips">
      {props.items.map((item) => (
        <span key={item} className="app-role-chip audits-chip-item">
          {item}
          {!props.disabled && (
            <button
              type="button"
              className="audits-chip-remove"
              aria-label={translate('settings.audits.chip.remove', { item })}
              onClick={() => props.onChange(props.items.filter((each) => each !== item))}
            >
              <CloseIcon size={10} />
            </button>
          )}
        </span>
      ))}
      {!props.disabled && (
        <input
          className="audits-chip-input"
          aria-label={props.placeholder}
          placeholder={props.placeholder}
          value={draft}
          maxLength={120}
          onChange={(event) => setDraft(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              add();
            }
          }}
          onBlur={add}
        />
      )}
    </div>
  );
}
