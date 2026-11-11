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
import { Switch } from '../../ui/Switch';
import { AUDIT_ICONS } from '../../features/audits/AuditIcons';
import { readAuditIgnores, saveAuditIgnores, type StoredIgnores } from '../../features/audits/auditsBridge';
import { updateAuditState } from '../../features/audits/auditStore';
import '../../features/audits/audits.css';
import './roles.css';

const CATEGORY_LABELS: Readonly<Record<AuditCategory, string>> = {
  accessibility: 'Accessibility',
  seo: 'SEO and launch',
  content: 'Placeholders',
  tokens: 'Design tokens',
  performance: 'Speed',
};
const PRIORITY_LABELS: Readonly<Record<AuditSettingPriority, string>> = { high: 'High', medium: 'Medium', low: 'Low' };

type State = { readonly kind: 'loading' } | { readonly kind: 'error'; readonly message: string } | { readonly kind: 'ready'; readonly stored: StoredIgnores };

const DEFAULT_SETTING: AuditCheckSetting = { enabled: true, priority: undefined };

export function AuditsSettings({ projectPath }: { readonly projectPath: string }) {
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
    return <div className="props-empty">Reading the audit settings…</div>;
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
      <p className="audits-settings-intro">
        Shared with the team in <code className="audits-path-chip">.stacki/audits.json</code>
      </p>
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
            title={CATEGORY_LABELS[category]}
            summary={`${on} of ${ids.length} on`}
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
                <h5>Phrases</h5>
                <p className="audits-settings-hint">A single word must be the whole text to count; several words may be part of it.</p>
                <ChipList
                  items={file.placeholders}
                  placeholder="Add a phrase"
                  disabled={!editable}
                  onChange={(placeholders) => void save({ ...file, placeholders })}
                />
              </div>
            )}
            {category === 'tokens' && (
              <div className="audits-settings-subpanel">
                <h5>Rules</h5>
                <div className="app-role-group audits-settings-grid">
                  <PlainSwitch
                    label="Raw colours"
                    description="Hex, rgb() and hsl() outside variables"
                    checked={file.tokens.colors}
                    disabled={!editable}
                    onToggle={() => void save(tokens({ ...file.tokens, colors: !file.tokens.colors }))}
                  />
                  <PlainSwitch
                    label="Flag px"
                    description="Any px value outside a variable definition"
                    checked={file.tokens.px}
                    disabled={!editable}
                    onToggle={() => void save(tokens({ ...file.tokens, px: !file.tokens.px }))}
                  />
                  <PlainSwitch
                    label="Flag rem outside variables"
                    description="rem belongs in variable definitions only"
                    checked={file.tokens.remOutsideVariables}
                    disabled={!editable}
                    onToggle={() => void save(tokens({ ...file.tokens, remOutsideVariables: !file.tokens.remOutsideVariables }))}
                  />
                </div>
                <h5>Properties that need variables</h5>
                <ChipList
                  items={file.tokens.properties}
                  placeholder="Add a property, or padding* for every padding"
                  disabled={!editable}
                  onChange={(properties) => void save(tokens({ ...file.tokens, properties }))}
                />
                <h5>Raw values that are fine</h5>
                <ChipList
                  items={file.tokens.allowed}
                  placeholder="Add a value, such as 1px"
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
            All
            <Switch label={`All ${props.title}`} checked={props.all.checked} disabled={props.all.disabled} onToggle={props.all.onToggle} />
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
  const Icon = AUDIT_ICONS[props.id];
  const priority = props.setting.priority;
  return (
    <div className="app-role-toggle audits-settings-row">
      <span className="app-role-toggle-icon" aria-hidden="true">
        <Icon size={14} />
      </span>
      <span className="app-role-app-permission-text">
        <span className="app-role-toggle-label" title={check.title}>
          {check.title}
          {priority !== undefined && <span className="audits-settings-priority">{PRIORITY_LABELS[priority]}</span>}
        </span>
        <span className="app-role-app-permission-description audits-settings-description" title={check.why}>
          {check.why}
        </span>
      </span>
      <span className="audits-settings-controls">
        {props.setting.enabled && props.editable && (
          <MoreMenu
            className="audits-icon-button"
            title={`${check.title} priority`}
            width={170}
            items={[
              {
                label: `Default (${PRIORITY_LABELS[check.priority]})`,
                current: priority === undefined,
                onSelect: () => props.onChange({ ...props.setting, priority: undefined }),
              },
              ...(['high', 'medium', 'low'] as const).map((level) => ({
                label: PRIORITY_LABELS[level],
                current: priority === level,
                onSelect: () => props.onChange({ ...props.setting, priority: level }),
              })),
            ]}
          />
        )}
        <Switch
          label={check.title}
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
              aria-label={`Remove ${item}`}
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
