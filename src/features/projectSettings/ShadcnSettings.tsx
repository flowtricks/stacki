import { useEffect, useRef, useState } from 'react';
import { parseShadcnSettingsReply, type ShadcnSettingsChange, type ShadcnSettings as Settings } from '../../../shared/ipc/shadcnSettings';
import { useTranslate } from '../../lib/i18n/useTranslate';
import { ChevronRightIcon } from '../../ui/Icons';
import { ShadcnStarterLogo } from '../../ui/ShadcnStarterLogo';
import { SwitchRow } from '../../ui/Switch';

interface Props {
  readonly projectPath: string;
  readonly showToast: (message: string, kind?: 'info' | 'success' | 'warning' | 'error') => void;
}

export default function ShadcnSettings({ projectPath, showToast }: Props) {
  const translate = useTranslate();
  const [settings, setSettings] = useState<Settings>();
  const [pending, setPending] = useState(false);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    let current = true;
    if (typeof window.avb.readShadcnSettings === 'function') {
      void window.avb
        .readShadcnSettings({ projectPath })
        .then((reply) => {
          const result = parseShadcnSettingsReply(reply);
          if (current && result.ok) {
            setSettings(result.value);
          }
        })
        .catch(() => {
          if (current) {
            setSettings(undefined);
          }
        });
    }
    return () => {
      current = false;
      mounted.current = false;
    };
  }, [projectPath]);

  if (settings === undefined) {
    return undefined;
  }

  const update = async (change: Omit<ShadcnSettingsChange, 'projectPath'>) => {
    setPending(true);
    try {
      const result = parseShadcnSettingsReply(await window.avb.changeShadcnSetting({ projectPath, ...change }));
      if (!mounted.current) {
        return;
      }
      if (result.ok) {
        setSettings(result.value);
      } else {
        showToast(result.error.message, 'error');
      }
    } catch (error: unknown) {
      if (mounted.current) {
        showToast(error instanceof Error ? error.message : String(error), 'error');
      }
    } finally {
      if (mounted.current) {
        setPending(false);
      }
    }
  };

  return (
    <details className="shadcn-project-settings">
      <summary className="list-item settings-link">
        <ShadcnStarterLogo brand="shadcn" size={14} />
        {/* shadcn is the name of the UI library. */}
        <span className="label">shadcn</span>
        <ChevronRightIcon size={14} />
      </summary>
      <div className="shadcn-project-options" aria-busy={pending}>
        <SwitchRow
          label={translate('welcome.shadcn.pointer')}
          checked={settings.pointer}
          disabled={pending}
          onToggle={() => void update({ setting: 'pointer', enabled: !settings.pointer })}
        />
        <SwitchRow
          label={translate('welcome.shadcn.rtl')}
          checked={settings.rtl}
          disabled={pending}
          onToggle={() => void update({ setting: 'rtl', enabled: !settings.rtl })}
        />
        {pending && <p role="status">{translate('ui.loading')}</p>}
      </div>
    </details>
  );
}
