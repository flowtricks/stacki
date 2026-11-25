import { useEffect, useId, useRef, useState } from 'react';
import {
  parseShadcnPresetCode,
  parseStarterName,
  SHADCN_BASES,
  SHADCN_ICON_LIBRARIES,
  SHADCN_PRESET_CODE_LENGTH_MAX,
  SHADCN_STARTER_DEFAULTS,
  SHADCN_STYLES,
  type ShadcnStarterOptions,
  type ShadcnStyle,
} from '../../../shared/ipc/shadcnStarter';
import type { CreatePackageManager } from '../../../shared/properties/packageManager';
import { useTranslate } from '../../lib/i18n/useTranslate';
import { ErrorToast } from '../../ui/ErrorToast';
import { CheckIcon } from '../../ui/Icons';
import { SwitchRow } from '../../ui/Switch';
import TipAnchor from '../../ui/TipAnchor';
import { ShadcnStarterLogo, type ShadcnStarterChoice } from '../../ui/ShadcnStarterLogo';
import { CreateLog, PackageManagerField, SITE_NAME_DEFAULT, SiteNameField, useCreateLog, WizardFrame, type RunState, type WizardProps } from './WelcomeWizards';
import { createShadcnStarterProject, inspectShadcnPreset } from './welcomeBridge';
import './shadcnStarterWizard.css';

const PRESET_CHECK_DELAY_MS = 250;
const SHADCN_CREATE_URL = 'https://ui.shadcn.com/create';
// i18n-ignore: base, style, and icon library names are product names.
const BASE_LABELS = { base: 'Base UI', aria: 'React Aria', radix: 'Radix UI' } as const;
const STYLE_LABELS = { vega: 'Vega', nova: 'Nova', maia: 'Maia', lyra: 'Lyra', mira: 'Mira', luma: 'Luma', sera: 'Sera', rhea: 'Rhea' } as const;
const ICON_LABELS = { lucide: 'Lucide', tabler: 'Tabler Icons', hugeicons: 'Hugeicons', phosphor: 'Phosphor Icons', remixicon: 'Remix Icon' } as const;
type IconLibrary = ShadcnStarterOptions['iconLibrary'];
type PresetSelection =
  | { readonly kind: 'empty' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'checking'; readonly code: string }
  | { readonly kind: 'valid'; readonly code: string; readonly iconLibrary: IconLibrary; readonly style: ShadcnStyle }
  | { readonly kind: 'error'; readonly code: string; readonly message: string };

export default function ShadcnStarterWizard({ parentPath, onClose, onDone }: WizardProps & { readonly parentPath: string }) {
  const translate = useTranslate();
  const [name, setName] = useState(SITE_NAME_DEFAULT);
  const [manager, setManager] = useState<CreatePackageManager>('npm');
  const [base, setBase] = useState<ShadcnStarterOptions['base']>(SHADCN_STARTER_DEFAULTS.base);
  const [chosenStyle, setStyle] = useState<ShadcnStyle>(SHADCN_STARTER_DEFAULTS.style);
  const [pointer, setPointer] = useState<boolean>(SHADCN_STARTER_DEFAULTS.pointer);
  const [rtl, setRTL] = useState<boolean>(SHADCN_STARTER_DEFAULTS.rtl);
  const [state, setState] = useState<RunState>({ kind: 'idle' });
  const submitted = useRef(false);
  const log = useCreateLog();
  const preset = usePreset();
  const style = preset.selection.kind === 'valid' ? preset.selection.style : chosenStyle;
  const cleanName = name.trim();
  const nameProblem = shadcnNameProblem(cleanName);
  const running = state.kind === 'running';
  const presetReady = preset.selection.kind === 'empty' || preset.selection.kind === 'valid';
  const ready = !running && nameProblem === undefined && presetReady;

  const run = async (): Promise<void> => {
    if (!ready || submitted.current) {
      return;
    }
    submitted.current = true;
    setState({ kind: 'running' });
    log.clear();
    const shadcn = { base, style, iconLibrary: preset.iconLibrary, pointer, rtl, ...(preset.code === undefined ? {} : { preset: preset.code }) };
    const result = await createShadcnStarterProject({ parentPath, name: cleanName, packageManager: manager, shadcn });
    if (result.ok && result.value.ok) {
      onDone(result.value.projectPath);
      return;
    }
    submitted.current = false;
    setState({ kind: 'error', message: result.ok ? translate('welcome.starter.unfinished') : result.error });
  };

  return (
    <WizardFrame
      title={translate('welcome.hero.startShadcn')}
      className="shadcn-starter-modal"
      running={running}
      onClose={onClose}
      footer={(close) => (
        <>
          <button className="ghost" onClick={close} disabled={running}>
            {translate('ui.cancel')}
          </button>
          <button className="primary" onClick={() => void run()} disabled={!ready}>
            {running ? translate('welcome.creating') : state.kind === 'error' ? translate('welcome.project.tryAgain') : translate('welcome.starter.submit')}
          </button>
        </>
      )}
    >
      <SiteNameField
        parentPath={parentPath}
        name={name}
        running={running}
        change={setName}
        submit={() => void run()}
        pathLabel={translate('welcome.shadcn.path')}
        problem={nameProblem === undefined ? undefined : translate(nameProblem)}
      />
      <PackageManagerField value={manager} disabled={running} change={setManager} />
      <StarterChoices label={translate('welcome.shadcn.base')} values={SHADCN_BASES} labels={BASE_LABELS} value={base} disabled={running} change={setBase} />
      <StarterChoices
        label={translate('shell.rightTabs.style')}
        layout="three-columns"
        values={SHADCN_STYLES}
        labels={STYLE_LABELS}
        value={style}
        disabled={running || preset.selection.kind === 'checking' || preset.selection.kind === 'valid'}
        change={setStyle}
      />
      <StarterChoices
        label={translate('welcome.shadcn.icons')}
        values={SHADCN_ICON_LIBRARIES}
        labels={ICON_LABELS}
        value={preset.iconLibrary}
        disabled={running || preset.selection.kind === 'checking'}
        change={preset.chooseIcon}
      />
      <div className="shadcn-starter-switches">
        <SwitchRow label={translate('welcome.shadcn.pointer')} checked={pointer} disabled={running} onToggle={() => setPointer(!pointer)} />
        <SwitchRow label={translate('welcome.shadcn.rtl')} checked={rtl} disabled={running} onToggle={() => setRTL(!rtl)} />
      </div>
      <PresetField value={preset.value} selection={preset.selection} disabled={running} change={preset.change} retry={preset.retry} />
      {running || log.text ? <CreateLog log={log.text || translate('welcome.project.starting')} running={running} elementRef={log.elementRef} /> : undefined}
      <ErrorToast message={state.kind === 'error' ? state.message : undefined} />
      <ErrorToast message={preset.selection.kind === 'error' ? preset.selection.message : undefined} />
    </WizardFrame>
  );
}

function shadcnNameProblem(name: string): 'welcome.shadcn.nameEmpty' | 'welcome.shadcn.nameInvalid' | undefined {
  if (name === '') {
    return 'welcome.shadcn.nameEmpty';
  }
  try {
    parseStarterName(name);
    return undefined;
  } catch {
    return 'welcome.shadcn.nameInvalid';
  }
}

function usePreset() {
  const [value, setValue] = useState('');
  const [selection, setSelection] = useState<PresetSelection>({ kind: 'empty' });
  const [explicitIcon, setExplicitIcon] = useState<IconLibrary>();
  const code = selection.kind === 'valid' ? selection.code : undefined;
  const presetIcon = selection.kind === 'valid' ? selection.iconLibrary : SHADCN_STARTER_DEFAULTS.iconLibrary;

  useEffect(() => {
    if (selection.kind !== 'checking') {
      return undefined;
    }
    const timer = setTimeout(() => {
      const settle = (verdict: PresetSelection) => {
        // A late reply must never select a style or icon, even if the same code was entered again.
        setSelection((current) => (current === selection ? verdict : current));
      };
      void inspectShadcnPreset(selection.code).then((result) => {
        if (!result.ok) {
          settle({ kind: 'error', code: selection.code, message: result.error });
        } else if (!result.value.ok) {
          settle({ kind: 'error', code: selection.code, message: result.value.error.message });
        } else {
          settle({ kind: 'valid', code: selection.code, ...result.value.value });
        }
      });
    }, PRESET_CHECK_DELAY_MS);
    return () => clearTimeout(timer);
  }, [selection]);

  const change = (next: string) => {
    setValue(next);
    if (next.trim() !== value.trim()) {
      setSelection(parsePresetInput(next.trim()));
      setExplicitIcon(undefined);
    }
  };
  const retry = () => {
    setSelection((current) => (current.kind === 'error' ? { kind: 'checking', code: current.code } : current));
  };
  return { value, code, selection, iconLibrary: explicitIcon ?? presetIcon, chooseIcon: setExplicitIcon, change, retry };
}

function parsePresetInput(value: string): PresetSelection {
  if (value === '') {
    return { kind: 'empty' };
  }
  try {
    return { kind: 'checking', code: parseShadcnPresetCode(value) };
  } catch {
    return { kind: 'invalid' };
  }
}

function StarterChoices<Value extends ShadcnStarterChoice>({
  label,
  layout,
  values,
  labels,
  value,
  disabled,
  change,
}: {
  readonly label: string;
  readonly layout?: 'three-columns';
  readonly values: readonly Value[];
  readonly labels: Readonly<Record<Value, string>>;
  readonly value: Value;
  readonly disabled: boolean;
  readonly change: (value: Value) => void;
}) {
  const groupName = useId();
  return (
    <fieldset className="shadcn-starter-choices" disabled={disabled}>
      <legend>{label}</legend>
      <div className="shadcn-starter-tiles" data-layout={layout}>
        {values.map((choice) => (
          <label className="shadcn-starter-tile" key={choice}>
            <input className="shadcn-starter-radio" type="radio" name={groupName} value={choice} checked={choice === value} onChange={() => change(choice)} />
            <ShadcnStarterLogo brand={choice} size={20} />
            <span className="shadcn-starter-tile-name" dir="auto">
              {labels[choice]}
            </span>
            <span className="shadcn-starter-tile-check" aria-hidden="true">
              <CheckIcon size={12} />
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function PresetField({
  value,
  selection,
  disabled,
  change,
  retry,
}: {
  readonly value: string;
  readonly selection: PresetSelection;
  readonly disabled: boolean;
  readonly change: (value: string) => void;
  readonly retry: () => void;
}) {
  const translate = useTranslate();
  const inputId = useId();
  const statusId = useId();
  const input = useRef<HTMLInputElement>(null);
  const invalid = selection.kind === 'invalid' || selection.kind === 'error';
  const checking = selection.kind === 'checking';
  const status = checking ? translate('welcome.shadcn.presetChecking') : selection.kind === 'invalid' ? translate('welcome.shadcn.presetInvalid') : undefined;
  return (
    <div className="starter-field">
      <div className="shadcn-preset-heading">
        <label htmlFor={inputId}>{translate('welcome.shadcn.preset')}</label>
        <span className="shadcn-preset-action" id={statusId}>
          <span role="status" data-invalid={selection.kind === 'invalid'}>
            {status}
          </span>
          {selection.kind === 'error' ? (
            <TipAnchor text={selection.message || undefined}>
              <button
                type="button"
                disabled={disabled}
                onClick={() => {
                  // Keep keyboard focus in the field when the retry action gives way to progress.
                  input.current?.focus();
                  retry();
                }}
              >
                {translate('welcome.project.tryAgain')}
              </button>
            </TipAnchor>
          ) : status === undefined ? (
            <a href={SHADCN_CREATE_URL} target="_blank" rel="noreferrer">
              {translate('welcome.shadcn.presetLink')}
            </a>
          ) : undefined}
        </span>
      </div>
      <input
        id={inputId}
        ref={input}
        value={value}
        disabled={disabled}
        spellCheck={false}
        autoComplete="off"
        maxLength={SHADCN_PRESET_CODE_LENGTH_MAX + 1}
        aria-invalid={invalid || undefined}
        aria-describedby={checking || invalid ? statusId : undefined}
        onChange={(event) => change(event.currentTarget.value)}
      />
    </div>
  );
}
