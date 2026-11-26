import { useState } from 'react';
import type { CreatePackageManager } from '../../../shared/properties/packageManager';
import { useTranslate } from '../../lib/i18n/useTranslate';
import { createStarterProject } from './welcomeBridge';
import {
  CreateLog,
  PackageManagerField,
  SITE_NAME_DEFAULT,
  SiteNameField,
  starterNameProblem,
  useCreateLog,
  WizardFrame,
  type RunState,
  type WizardProps,
} from './WelcomeWizards';

export default function HeroUIStarterWizard({ parentPath, onClose, onDone }: WizardProps & { readonly parentPath: string }) {
  const translate = useTranslate();
  const [name, setName] = useState(SITE_NAME_DEFAULT);
  const [manager, setManager] = useState<CreatePackageManager>('npm');
  const [state, setState] = useState<RunState>({ kind: 'idle' });
  const log = useCreateLog();
  const nameProblem = starterNameProblem(name);
  const running = state.kind === 'running';

  const run = async (): Promise<void> => {
    if (nameProblem !== undefined || !log.begin()) {
      return;
    }
    setState({ kind: 'running' });
    const result = await createStarterProject({ starter: 'heroui', parentPath, name: name.trim(), packageManager: manager });
    log.end();
    if (result.ok && result.value.ok) {
      onDone(result.value.projectPath);
    } else {
      setState({ kind: 'error', message: result.ok ? translate('welcome.starter.unfinished') : result.error });
    }
  };

  return (
    <WizardFrame
      title={translate('welcome.hero.startHeroUI')}
      className="starter-wizard-modal"
      running={running}
      onClose={onClose}
      footer={(close) => (
        <>
          <button className="ghost" onClick={close} disabled={running}>
            {translate('ui.cancel')}
          </button>
          <button className="primary" onClick={() => void run()} disabled={running || nameProblem !== undefined}>
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
        pathLabel={translate('welcome.starter.path')}
        problem={nameProblem === undefined ? undefined : translate(nameProblem)}
      />
      <PackageManagerField value={manager} disabled={running} change={setManager} />
      {(running || log.text !== '') && <CreateLog log={log.text || translate('welcome.project.starting')} running={running} elementRef={log.elementRef} />}
      {state.kind === 'error' && (
        <div className="starter-creation-error" role="alert">
          {state.message}
        </div>
      )}
    </WizardFrame>
  );
}
