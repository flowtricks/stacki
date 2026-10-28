import { validateGuidePreferences } from '../../../shared/properties/guidePreferences';
// One pending settings value coalesces slider changes; saves are serialized per mounted project.
import { useEffect, useRef, useState } from 'react';
import { onWindowReturn } from '../../lib/windowReturn';
import { record } from '../../../shared/core/boundary';
import { readMetadata, writeMetadata } from '../../ipc/projectMetadataBridge';
import { GUIDE_DEFAULTS, type GuideSettings } from './guideModel';
import { loadLegacyGuideSettings, parseGuideSettings, type GuideUpdate } from './guideSettings';

export interface GuidePersistence {
  readonly message: string;
  readonly loading: boolean;
  readonly reload: () => void;
}
interface GuideState {
  readonly settings: GuideSettings;
  readonly message: string;
  readonly loading: boolean;
}
interface GuideController {
  readonly change: GuideUpdate;
  readonly reload: () => void;
  readonly close: () => void;
}

export function useProjectGuideSettings(project: string | undefined) {
  const [state, setState] = useState<GuideState>({
    settings: GUIDE_DEFAULTS,
    message: '',
    loading: true,
  });
  const controller = useRef<GuideController>();
  useEffect(() => {
    if (project === undefined) {
      setState({ settings: GUIDE_DEFAULTS, message: '', loading: false });
      return;
    }
    const current = createGuideController(project, setState);
    controller.current = current;
    current.reload();
    const refresh = () => {
      if (!document.hidden) {
        current.reload();
      }
    };
    const offReturn = onWindowReturn(refresh);
    // Project metadata has no dedicated watcher; reconcile while the editor remains visible.
    const timer = window.setInterval(refresh, 15_000);
    return () => {
      offReturn();
      window.clearInterval(timer);
      current.close();
      controller.current = undefined;
    };
  }, [project]);
  return {
    settings: state.settings,
    update: (change: Parameters<GuideUpdate>[0]) => controller.current?.change(change),
    persistence: {
      loading: state.loading,
      message: state.message,
      reload: () => controller.current?.reload(),
    },
  };
}

export function createGuideController(
  project: string,
  notify: (state: GuideState) => void,
): GuideController {
  const controller = new ProjectGuideController(project, notify);
  return {
    change: (change) => controller.change(change),
    reload: () => controller.reload(),
    close: () => controller.close(),
  };
}

class ProjectGuideController {
  private settings = GUIDE_DEFAULTS;
  private source: string | undefined;
  private pending: GuideSettings | undefined;
  private writing = false;
  private status: 'loading' | 'ready' | 'failed' | 'closed' = 'loading';
  private timer: ReturnType<typeof setTimeout> | undefined;
  private loadToken: object | undefined;
  constructor(
    private readonly project: string,
    private readonly notify: (state: GuideState) => void,
  ) {}

  change(change: Parameters<GuideUpdate>[0]): void {
    if (this.status !== 'ready') {
      return;
    }
    this.settings = change(this.settings);
    this.pending = this.settings;
    this.report('Saving project guide…');
    this.schedule();
  }

  reload(): void {
    if (this.writing || this.pending !== undefined || this.status === 'closed') {
      return;
    }
    const token = {};
    this.loadToken = token;
    this.status = 'loading';
    this.report('Loading project guide…');
    void readMetadata(this.project, 'guide')
      .then(async (stored) => {
        if (this.status === 'closed' || this.loadToken !== token) {
          return;
        }
        this.source = stored.source;
        // Without a file, only settings from app storage are written; defaults wait for a change.
        const legacy =
          this.source === undefined ? loadLegacyGuideSettings(this.project) : undefined;
        this.settings =
          this.source === undefined ? (legacy ?? GUIDE_DEFAULTS) : guideFromSource(this.source);
        this.status = 'ready';
        this.report('');
        if (legacy !== undefined) {
          this.pending = legacy;
          await this.save();
        }
      })
      .catch((error: unknown) => {
        if (this.status !== 'closed' && this.loadToken === token) {
          this.status = 'failed';
          this.report(errorMessage(error));
        }
      });
  }

  close(): void {
    this.status = 'closed';
    clearTimeout(this.timer);
    void this.save();
  }

  private schedule(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.save(), 200);
  }

  private report(message: string): void {
    if (this.status !== 'closed') {
      this.notify({ settings: this.settings, message, loading: this.status === 'loading' });
    }
  }

  private async save(): Promise<void> {
    if (this.writing || this.pending === undefined) {
      return;
    }
    const next = this.pending;
    this.pending = undefined;
    this.writing = true;
    try {
      const result = await writeMetadata(this.project, {
        kind: 'guide',
        source:
          JSON.stringify(
            { version: 1, settings: { ...next, columnDefaultsVersion: 1 } },
            undefined,
            2,
          ) + '\n',
        ...(this.source === undefined ? {} : { base: this.source }),
      });
      this.source = result.source;
      this.report('');
    } catch (error: unknown) {
      this.pending = undefined;
      if (this.status !== 'closed') {
        this.status = 'failed';
      }
      this.report(`${errorMessage(error)} Project settings will retry automatically.`);
    } finally {
      this.writing = false;
      if (this.pending !== undefined) {
        this.schedule();
      }
    }
  }
}

function guideFromSource(source: string): GuideSettings {
  const input: unknown = JSON.parse(source);
  const value = record(input);
  if (value['version'] !== 1) {
    throw new Error('Unsupported project guide version.');
  }
  validateGuidePreferences(value['settings']);
  return parseGuideSettings(record(value['settings']));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Could not save the project guide.';
}
