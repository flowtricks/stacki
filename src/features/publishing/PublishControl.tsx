import { ChevronDownIcon } from '../../ui/Icons';
import { useEffect, useRef, useState } from 'react';
import type { PublishConfig, PublishTarget } from '../../../shared/properties/publishConfig';
import { parsePublishConfig, parsePublishSource } from '../../../shared/properties/publishConfig';
import { readMetadata, writeMetadata } from '../../ipc/projectMetadataBridge';
import Popup from '../../ui/Popup';
import { PublishSettings } from './PublishSettings';
import { PublishMenuOptions } from './PublishMenuOptions';
import { publishButtonState, UNKNOWN_PUBLISH_AVAILABILITY, type PublishAvailability, type PublishButtonState } from '../../../shared/properties/publishState';
import { usePublishConfiguration, configuredPublishAvailability } from './usePublishConfiguration';
import { cachedPublishingDiscovery } from './publishDiscoveryCache';
import './publishing.css';

interface Props {
  readonly projectPath: string;
  readonly busy: boolean;
  readonly availability?: PublishAvailability;
  readonly publish: (target: PublishTarget) => void;
  readonly settingsClosed?: () => void;
  readonly refreshAvailability?: () => void;
}
type PublishChoice = PublishTarget | 'default';

export function PublishControl({
  projectPath,
  busy,
  publish,
  settingsClosed,
  refreshAvailability,
  availability: checkedAvailability = UNKNOWN_PUBLISH_AVAILABILITY,
}: Props) {
  const { open, setOpen, settings, checking, run, openSettings, closeSettings } = usePublishMenu(projectPath, publish, settingsClosed, refreshAvailability);
  const configuration = usePublishConfiguration(projectPath, { open, settings, checking });
  const defaultTarget = 'config' in configuration ? configuration.config.defaultTarget : 'all';
  const availability = configuredPublishAvailability(checkedAvailability, configuration);
  const provider = 'config' in configuration ? configuration.config.hosting.provider : 'none';
  const repositoryURL = usePublishRepositoryURL(projectPath, availability);
  const container = useRef<HTMLDivElement>(null);
  const state = publishButtonState(availability, defaultTarget);
  return (
    <div
      className="stacki-publish-control"
      ref={container}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          setOpen(false);
        }
      }}
    >
      <PublishButtons busy={busy} checking={checking} state={state} open={open} publish={() => run('default')} toggle={() => setOpen(!open)} />
      <Popup
        mode="popover"
        portal={false}
        open={open}
        anchor={container.current ?? undefined}
        onClose={() => setOpen(false)}
        className="stacki-publish-menu"
        label="Publish options"
      >
        <PublishMenuOptions
          key={projectPath}
          projectPath={projectPath}
          publish={run}
          availability={availability}
          repositoryURL={repositoryURL}
          busy={busy || checking}
          provider={provider}
          config={'config' in configuration ? configuration.config : undefined}
          openSettings={openSettings}
        />
      </Popup>
      {settings && <PublishSettings key={projectPath} projectPath={projectPath} close={closeSettings} />}
    </div>
  );
}

function usePublishMenu(
  projectPath: string,
  publish: Props['publish'],
  settingsClosed: Props['settingsClosed'],
  refreshAvailability: Props['refreshAvailability'],
) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open || !refreshAvailability) {
      return undefined;
    }
    refreshAvailability();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') {
        refreshAvailability();
      }
    }, 30_000);
    return () => clearInterval(timer);
  }, [open, refreshAvailability]);
  const { settings, setSettings, checking, prepare } = usePublishSetup(projectPath, publish);
  const run = (target: PublishChoice) => {
    setOpen(false);
    void prepare(target);
  };
  const openSettings = () => {
    setOpen(false);
    setSettings(true);
  };
  const closeSettings = () => {
    setSettings(false);
    settingsClosed?.();
  };
  return { open, setOpen, settings, checking, run, openSettings, closeSettings };
}

function usePublishRepositoryURL(projectPath: string, availability: PublishAvailability) {
  const [known, setKnown] = useState<{
    readonly projectPath: string;
    readonly url: string | undefined;
  }>({ projectPath, url: undefined });
  const discovered = availability.githubPush?.repositoryUrl;
  useEffect(() => {
    // The last known remote survives count invalidation, but never a project switch.
    setKnown((previous) => ({
      projectPath,
      url: discovered ?? (previous.projectPath === projectPath ? previous.url : undefined),
    }));
  }, [projectPath, discovered]);
  return discovered ?? (known.projectPath === projectPath ? known.url : undefined);
}

function PublishButtons(props: {
  readonly busy: boolean;
  readonly checking: boolean;
  readonly state: PublishButtonState;
  readonly open: boolean;
  readonly publish: () => void;
  readonly toggle: () => void;
}) {
  // A finished publish rests as a neutral control, not a dimmed call to action; a running one
  // keeps its blue so "Publishing…" still reads as the app at work.
  const current = props.state === 'current';
  const resting = current && !props.busy;
  return (
    <div className="stacki-publish-split" data-state={resting ? 'current' : 'ready'}>
      <span className="stacki-publish-main" title={current ? 'All changes are up to date' : undefined}>
        <button
          className={resting ? undefined : 'primary'}
          disabled={props.busy || props.checking || current}
          aria-description={current ? 'All changes are up to date' : undefined}
          onClick={props.publish}
        >
          {props.busy ? 'Publishing…' : 'Publish'}
        </button>
      </span>
      <button
        className={resting ? 'stacki-publish-arrow' : 'primary stacki-publish-arrow'}
        aria-label="More publish options"
        aria-expanded={props.open}
        disabled={props.busy || props.checking}
        onClick={props.toggle}
      >
        <ChevronDownIcon size={12} />
      </button>
    </div>
  );
}

function usePublishSetup(projectPath: string, publish: Props['publish']) {
  const [settings, setSettings] = useState(false);
  const [checking, setChecking] = useState(false);
  const pending = useRef(false);
  const prepare = async (choice: PublishChoice) => {
    if (pending.current) {
      return;
    }
    pending.current = true;
    setChecking(true);
    try {
      const target = await preparePublishTarget(projectPath, choice);
      if (target === undefined) {
        setSettings(true);
      } else {
        publish(target);
      }
    } catch {
      // The setup dialog reports load errors and offers a retry instead of starting a job.
      setSettings(true);
    } finally {
      pending.current = false;
      setChecking(false);
    }
  };
  return { settings, setSettings, checking, prepare };
}

async function preparePublishTarget(projectPath: string, choice: PublishChoice): Promise<PublishTarget | undefined> {
  const file = await readMetadata(projectPath, 'publish');
  const config = parsePublishSource(file.source);
  // Resolve on click so edits from either host apply without restarting the editor.
  const target = choice === 'default' ? config.defaultTarget : choice;
  if (target === 'github') {
    return target;
  }
  if (file.source === undefined) {
    return (await saveLinkedHosting(projectPath, config)) ? target : undefined;
  }
  if (target === 'hosting' && config.hosting.provider === 'none') {
    return undefined;
  }
  return target;
}

async function saveLinkedHosting(projectPath: string, config: PublishConfig): Promise<boolean> {
  const discovery = await cachedPublishingDiscovery(projectPath, { provider: 'linked', account: '' }, 'refresh');
  if (discovery.kind !== 'ready') {
    return false;
  }
  const linked = discovery.projects.length === 1 ? discovery.projects[0] : undefined;
  if (linked === undefined) {
    return false;
  }
  if (linked.hosting.provider === 'none') {
    return false;
  }
  // Publish itself confirms the existing link. Persist it before the job reads its config,
  // and validate unresolved accounts with the same parser as an explicit settings save.
  const validated = parsePublishConfig({ ...config, hosting: linked.hosting });
  await writeMetadata(projectPath, {
    kind: 'publish',
    source: JSON.stringify(validated, undefined, 2) + '\n',
  });
  return true;
}
