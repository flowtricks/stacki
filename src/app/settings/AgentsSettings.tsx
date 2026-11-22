// The Settings panel's Agents view (left rail, beside Secrets, MCP and Instructions): every Claude and Codex agent definition the project holds, with its provider's mark,
// name and description, or what is wrong with it (shown inline; the file stays listed and opens). Choosing
// one opens it in the Instructions editor over the canvas, as any instruction file opens: the same save,
// unsaved-edits, conflict and outside-change handling, and frontmatter kept line by line, so keys this
// panel does not know are never rewritten. A Codex definition is TOML and opens as source.
//
// "New agent" writes one set of fields to `.stacki/agents/<name>.json` and a definition for each CLI from
// them (shared/properties/projectAgents.ts). A generated file that someone edited, or that is gone, is
// shown as such with Re-sync, which asks before overwriting an edit. Deleting moves the files to the Trash
// after the custom confirm dialog.
import { useCallback, useEffect, useId, useState, type ReactNode } from 'react';
import { AGENT_IDS, agentLabel, type AgentId } from '../../../shared/properties/ai/agentIds';
import { can } from '../../../shared/properties/projectRoles';
import type { AgentFields, AgentListing, PairedAgent, PairedFileState, ProjectAgent } from '../../../shared/properties/projectAgents';
import { selectInstruction } from '../../features/instructions/instructionSelection';
import { announceProjectAgentsChanged, deleteProjectAgent, listProjectAgents, saveProjectAgent } from '../../ipc/agentsBridge';
import { useTranslate } from '../../lib/i18n/useTranslate';
import { useCurrentRole } from '../../lib/useCurrentRole';
import { ClaudeLogo, CodexLogo } from '../../ui/agentLogos';
import { confirmDialog } from '../../ui/ConfirmDialog';
import Dropdown from '../../ui/Dropdown';
import { AgentIcon, PlusIcon, SyncIcon, TrashIcon, WarningTriangleIcon } from '../../ui/Icons';
import { Skeleton } from '../../ui/Skeleton';
import { SettingsEmptyState } from './SettingsEmptyState';
import { SettingsSection } from './SettingsLayout';
import {
  CLAUDE_MODEL_CHOICES,
  draftOfFields,
  draftProblems,
  editedProviders,
  fieldProblemKey,
  fieldsOfDraft,
  newAgentDraft,
  pairNeedsSync,
  problemMessage,
  takenNames,
  type AgentDraft,
} from './agentsSettingsModel';
import './agentsSettings.css';

type State = { readonly kind: 'loading' } | { readonly kind: 'error'; readonly message: string } | { readonly kind: 'ready'; readonly listing: AgentListing };

type Form = { readonly mode: 'create'; readonly draft: AgentDraft } | { readonly mode: 'update'; readonly draft: AgentDraft; readonly pair: PairedAgent };

/** Rows the loading card draws: about as tall as the short list it becomes. */
const SKELETON_ROWS = 3;

export function AgentsSettings({ projectPath }: { readonly projectPath: string }) {
  const translate = useTranslate();
  const role = useCurrentRole();
  const editable = can(role, 'instructions:edit');
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [form, setForm] = useState<Form>();
  const [problem, setProblem] = useState<string>();
  const load = useCallback(() => {
    void listProjectAgents(projectPath).then(
      (listing) => setState({ kind: 'ready', listing }),
      (failure: unknown) => setState({ kind: 'error', message: failure instanceof Error ? failure.message : String(failure) }),
    );
  }, [projectPath]);
  useEffect(load, [load]);
  useEffect(() => window.avb.onInstructionsChanged(load), [load]);

  if (state.kind === 'loading') {
    return (
      <div className="agents-settings">
        <SettingsSection title={translate('settings.agents.list.title')}>
          <div className="agents-card" role="status" aria-busy="true">
            {Array.from({ length: SKELETON_ROWS }, (_, index) => (
              <Skeleton key={index} height="44px" radius="6px" />
            ))}
          </div>
        </SettingsSection>
      </div>
    );
  }
  if (state.kind === 'error') {
    return (
      <div className="props-empty" role="alert">
        {state.message}
      </div>
    );
  }
  const listing = state.listing;
  const open = (file: string): void => {
    // The editor opens over the canvas beside the Settings panel, as an instruction file does.
    selectInstruction({ projectPath, file });
  };
  const written = (): void => {
    announceProjectAgentsChanged();
    load();
  };
  const remove = async (agent: ProjectAgent): Promise<void> => {
    const paired = agent.pairedSource === undefined ? undefined : listing.paired.find((pair) => pair.source === agent.pairedSource);
    const pairedName = paired?.fields.ok === true ? paired.fields.value.name : undefined;
    const answer = await confirmDialog({
      title: translate('settings.agents.delete.title', { name: agent.name }),
      body:
        pairedName === undefined
          ? translate('settings.agents.delete.body', { file: agent.path })
          : translate('settings.agents.delete.pairedBody', { name: pairedName }),
      confirmLabel: translate('settings.agents.delete.confirm'),
      danger: true,
    });
    if (answer === false) {
      return;
    }
    const result = await deleteProjectAgent(projectPath, pairedName === undefined ? { kind: 'file', path: agent.path } : { kind: 'paired', name: pairedName });
    setProblem(result.ok ? undefined : result.error.message);
    written();
  };
  const resync = async (pair: PairedAgent): Promise<void> => {
    if (!pair.fields.ok) {
      return;
    }
    const overwrite = editedProviders(pair);
    if (overwrite.length > 0) {
      const answer = await confirmDialog({
        title: translate('settings.agents.resync.title', { name: pair.fields.value.name }),
        body: translate('settings.agents.resync.body', { providers: overwrite.map(agentLabel).join(', ') }),
        confirmLabel: translate('settings.agents.resync.confirm'),
        danger: true,
      });
      if (answer === false) {
        return;
      }
    }
    const result = await saveProjectAgent(projectPath, { fields: pair.fields.value, mode: 'update', overwrite });
    setProblem(result.ok ? undefined : result.error.message);
    written();
  };
  const save = async (current: Form, fields: AgentFields): Promise<void> => {
    let overwrite: readonly AgentId[] = [];
    if (current.mode === 'update') {
      overwrite = editedProviders(current.pair);
      if (overwrite.length > 0) {
        const answer = await confirmDialog({
          title: translate('settings.agents.resync.title', { name: fields.name }),
          body: translate('settings.agents.resync.body', { providers: overwrite.map(agentLabel).join(', ') }),
          confirmLabel: translate('settings.agents.resync.confirm'),
          danger: true,
        });
        if (answer === false) {
          return;
        }
      }
    }
    const result = await saveProjectAgent(projectPath, { fields, mode: current.mode, overwrite });
    if (result.ok) {
      setForm(undefined);
      setProblem(undefined);
    } else {
      setProblem(result.error.message);
    }
    written();
  };
  const startNew = (): void =>
    setForm({
      mode: 'create',
      draft: newAgentDraft({
        role: translate('settings.agents.template.role'),
        steps: translate('settings.agents.template.steps'),
        output: translate('settings.agents.template.output'),
      }),
    });
  const newButton = (
    <button type="button" className="agents-new" onClick={startNew}>
      <PlusIcon size={12} />
      <span>{translate('settings.agents.new')}</span>
    </button>
  );
  return (
    <div className="agents-settings">
      <SettingsSection title={translate('settings.agents.list.title')} info={translate('settings.agents.list.info')}>
        <div className="agents-card">
          {listing.agents.length === 0 ? (
            <SettingsEmptyState icon={<AgentIcon size={16} />} title={translate('settings.agents.empty.title')} hint={translate('settings.agents.empty.hint')}>
              {editable && form === undefined && newButton}
            </SettingsEmptyState>
          ) : (
            <ul className="agents-list">
              {listing.agents.map((agent) => (
                <AgentRow key={agent.path} agent={agent} editable={editable} onOpen={() => open(agent.path)} onDelete={() => void remove(agent)} />
              ))}
            </ul>
          )}
          {listing.truncated && <p className="agents-note">{translate('settings.agents.truncated')}</p>}
          {editable && form === undefined && listing.agents.length > 0 && <div className="agents-actions">{newButton}</div>}
          {problem !== undefined && (
            <p className="agents-problem" role="alert">
              {problem}
            </p>
          )}
        </div>
      </SettingsSection>
      {form !== undefined && (
        <AgentForm
          form={form}
          taken={takenNames(listing, form.mode === 'update' ? form.draft.name : undefined)}
          onCancel={() => setForm(undefined)}
          onSave={save}
        />
      )}
      {listing.paired.length > 0 && (
        <SettingsSection title={translate('settings.agents.paired.title')} info={translate('settings.agents.paired.info')}>
          <div className="agents-card">
            <ul className="agents-list">
              {listing.paired.map((pair) => (
                <PairRow
                  key={pair.source}
                  pair={pair}
                  editable={editable}
                  onResync={() => void resync(pair)}
                  onEdit={() => {
                    if (pair.fields.ok) {
                      setForm({ mode: 'update', draft: draftOfFields(pair.fields.value), pair });
                    }
                  }}
                />
              ))}
            </ul>
          </div>
        </SettingsSection>
      )}
    </div>
  );
}

function ProviderMark({ provider }: { readonly provider: AgentId }): ReactNode {
  switch (provider) {
    case 'claude':
      return <ClaudeLogo size={16} />;
    case 'codex':
      return <CodexLogo size={16} />;
    default: {
      const exhaustive: never = provider;
      return exhaustive;
    }
  }
}

function AgentRow(props: { readonly agent: ProjectAgent; readonly editable: boolean; readonly onOpen: () => void; readonly onDelete: () => void }) {
  const translate = useTranslate();
  const { agent } = props;
  const label = agentLabel(agent.provider);
  return (
    <li className="agents-row">
      <button type="button" className="agents-row-main" onClick={props.onOpen} title={translate('settings.agents.open', { file: agent.path })}>
        <span className="agents-row-mark" aria-label={label} title={label}>
          <ProviderMark provider={agent.provider} />
        </span>
        <span className="agents-row-text">
          <span className="agents-row-name">
            {agent.name}
            {agent.pairedSource !== undefined && <span className="agents-tag">{translate('settings.agents.pairedTag')}</span>}
          </span>
          {agent.problems.length === 0 ? (
            <span className="agents-row-description">{agent.description}</span>
          ) : (
            agent.problems.map((problem, index) => {
              const message = problemMessage(problem);
              return (
                <span key={index} className="agents-row-warning">
                  <WarningTriangleIcon size={12} />
                  {translate(message.key, message.params)}
                </span>
              );
            })
          )}
          <span className="agents-row-path">{agent.path}</span>
        </span>
      </button>
      {props.editable && (
        <button
          type="button"
          className="agents-row-delete"
          aria-label={translate('settings.agents.delete.label', { name: agent.name })}
          title={translate('settings.agents.delete.label', { name: agent.name })}
          onClick={props.onDelete}
        >
          <TrashIcon size={13} />
        </button>
      )}
    </li>
  );
}

const STATE_KEYS = {
  'in-sync': 'settings.agents.paired.inSync',
  edited: 'settings.agents.paired.edited',
  missing: 'settings.agents.paired.missing',
} as const satisfies Readonly<Record<PairedFileState, string>>;

function PairRow(props: { readonly pair: PairedAgent; readonly editable: boolean; readonly onResync: () => void; readonly onEdit: () => void }) {
  const translate = useTranslate();
  const { pair } = props;
  if (!pair.fields.ok) {
    const message = problemMessage(pair.fields.error);
    return (
      <li className="agents-row agents-pair">
        <span className="agents-row-text">
          <span className="agents-row-name">{pair.source}</span>
          <span className="agents-row-warning">
            <WarningTriangleIcon size={12} />
            {translate(message.key, message.params)}
          </span>
        </span>
      </li>
    );
  }
  const name = pair.fields.value.name;
  return (
    <li className="agents-row agents-pair">
      <span className="agents-row-text">
        <span className="agents-row-name">{name}</span>
        <span className="agents-pair-states">
          {AGENT_IDS.map((provider) => (
            <span key={provider} className={`agents-pair-state agents-pair-${pair.files[provider]}`}>
              <ProviderMark provider={provider} />
              {translate(STATE_KEYS[pair.files[provider]], { provider: agentLabel(provider) })}
            </span>
          ))}
        </span>
      </span>
      {props.editable && (
        <span className="agents-pair-actions">
          {pairNeedsSync(pair) && (
            <button type="button" onClick={props.onResync} title={translate('settings.agents.resync.tip')}>
              <SyncIcon size={12} />
              <span>{translate('settings.agents.resync.label')}</span>
            </button>
          )}
          <button type="button" onClick={props.onEdit}>
            {translate('settings.agents.paired.editFields')}
          </button>
        </span>
      )}
    </li>
  );
}

function AgentForm(props: {
  readonly form: Form;
  readonly taken: readonly string[];
  readonly onCancel: () => void;
  readonly onSave: (form: Form, fields: AgentFields) => Promise<void>;
}) {
  const translate = useTranslate();
  const [draft, setDraft] = useState<AgentDraft>(props.form.draft);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const ids = useId();
  const problems = draftProblems(draft, props.taken);
  const problemOf = (field: string): string | undefined => {
    const found = problems.find((each) => each.field === field);
    return found === undefined || !touched ? undefined : translate(fieldProblemKey(found));
  };
  const change = (key: keyof AgentDraft, value: string): void => {
    setDraft((current) => ({ ...current, [key]: value }));
    setTouched(true);
  };
  const updating = props.form.mode === 'update';
  return (
    <SettingsSection title={updating ? translate('settings.agents.form.editTitle', { name: draft.name }) : translate('settings.agents.form.title')}>
      <form
        className="agents-card agents-form"
        onSubmit={(event) => {
          event.preventDefault();
          setTouched(true);
          if (problems.length === 0 && !busy) {
            setBusy(true);
            void props.onSave(props.form, fieldsOfDraft(draft)).finally(() => setBusy(false));
          }
        }}
      >
        <p className="agents-note">{translate('settings.agents.form.intro')}</p>
        <FormField
          id={`${ids}-name`}
          label={translate('settings.agents.form.name')}
          problem={problemOf('name')}
          hint={translate('settings.agents.form.nameHint')}
        >
          <input
            id={`${ids}-name`}
            type="text"
            value={draft.name}
            disabled={updating}
            spellCheck={false}
            placeholder={translate('settings.agents.form.namePlaceholder')}
            onChange={(event) => change('name', event.target.value)}
          />
        </FormField>
        <FormField
          id={`${ids}-description`}
          label={translate('settings.agents.form.description')}
          problem={problemOf('description')}
          hint={translate('settings.agents.form.descriptionHint')}
        >
          <input id={`${ids}-description`} type="text" value={draft.description} onChange={(event) => change('description', event.target.value)} />
        </FormField>
        <FormField id={`${ids}-instructions`} label={translate('settings.agents.form.instructions')} problem={problemOf('instructions')}>
          <textarea id={`${ids}-instructions`} rows={8} value={draft.instructions} onChange={(event) => change('instructions', event.target.value)} />
        </FormField>
        <FormField
          id={`${ids}-tools`}
          label={translate('settings.agents.form.tools')}
          problem={problemOf('tools')}
          hint={translate('settings.agents.form.toolsHint')}
        >
          <input
            id={`${ids}-tools`}
            type="text"
            value={draft.tools}
            spellCheck={false}
            placeholder={translate('settings.agents.form.toolsPlaceholder')}
            onChange={(event) => change('tools', event.target.value)}
          />
        </FormField>
        <FormField id={`${ids}-claudeModel`} label={translate('settings.agents.form.claudeModel')} problem={problemOf('claudeModel')}>
          <Dropdown
            ariaLabel={translate('settings.agents.form.claudeModel')}
            value={draft.claudeModel}
            options={CLAUDE_MODEL_CHOICES.map((choice) => ({ value: choice, label: choice === '' ? translate('settings.agents.form.modelDefault') : choice }))}
            onChange={(value) => change('claudeModel', value)}
          />
        </FormField>
        <FormField
          id={`${ids}-codexModel`}
          label={translate('settings.agents.form.codexModel')}
          problem={problemOf('codexModel')}
          hint={translate('settings.agents.form.codexModelHint')}
        >
          <input
            id={`${ids}-codexModel`}
            type="text"
            value={draft.codexModel}
            spellCheck={false}
            placeholder={translate('settings.agents.form.modelDefault')}
            onChange={(event) => change('codexModel', event.target.value)}
          />
        </FormField>
        <div className="agents-actions">
          <button type="button" onClick={props.onCancel}>
            {translate('settings.agents.form.cancel')}
          </button>
          <button type="submit" className="primary" disabled={busy || (touched && problems.length > 0)}>
            {updating ? translate('settings.agents.form.save') : translate('settings.agents.form.create')}
          </button>
        </div>
      </form>
    </SettingsSection>
  );
}

function FormField(props: {
  readonly id: string;
  readonly label: string;
  readonly hint?: string;
  readonly problem: string | undefined;
  readonly children: ReactNode;
}) {
  return (
    <div className="agents-field">
      <label htmlFor={props.id}>{props.label}</label>
      {props.children}
      {props.problem !== undefined ? (
        <span className="agents-problem" role="alert">
          {props.problem}
        </span>
      ) : (
        props.hint !== undefined && <span className="agents-note">{props.hint}</span>
      )}
    </div>
  );
}
