import { validateGuidePreferences } from '../../../shared/properties/guidePreferences';
// One pending settings value coalesces slider changes; saves are serialized per mounted project.
import { useEffect, useRef, useState } from 'react';
import { onWindowReturn } from '../../lib/windowReturn';
import { record } from '../../../shared/core/boundary';
import { readMetadata, writeMetadata } from '../../ipc/projectMetadataBridge';
import { GUIDE_DEFAULTS, type GuideSettings } from './guideModel';
import { loadLegacyGuideSettings, parseGuideSettings, type GuideUpdate } from './guideSettings';

export interface GuidePersistence {
  /** Why the guide could not be loaded or saved; empty while all is well. Progress is never one. */
  readonly problem: string;
  readonly loading: boolean;
  readonly reload: () => void;
}
// Every setting, so a change can be told apart field by field.
const GUIDE_KEYS = ['visible', 'columns', 'color', 'opacity', 'numbers', 'margin', 'gutter', 'widthMax'] as const satisfies ReadonlyArray<keyof GuideSettings>;

interface GuideState {
  readonly settings: GuideSettings;
  readonly problem: string;
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
    problem: '',
    loading: true,
  });
  const controller = useRef<GuideController>();
  useEffect(() => {
    if (project === undefined) {
      setState({ settings: GUIDE_DEFAULTS, problem: '', loading: false });
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
      problem: state.problem,
      reload: () => controller.current?.reload(),
    },
  };
}

export function createGuideController(project: string, notify: (state: GuideState) => void): GuideController {
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
  /** The settings changed here and not yet written; each outlives a failed save and a re-read. */
  private unsaved = new Set<keyof GuideSettings>();
  /** App-storage settings read for a project with no file yet, still to be written. */
  private unmigrated = false;
  private writing = false;
  private problem = '';
  private status: 'loading' | 'ready' | 'failed' | 'closed' = 'loading';
  private timer: ReturnType<typeof setTimeout> | undefined;
  private loadToken: object | undefined;
  constructor(
    private readonly project: string,
    private readonly notify: (state: GuideState) => void,
  ) {}

  change(change: Parameters<GuideUpdate>[0]): void {
    if (this.status === 'closed') {
      return;
    }
    const next = change(this.settings);
    for (const key of GUIDE_KEYS) {
      if (next[key] !== this.settings[key]) {
        this.unsaved.add(key);
      }
    }
    this.settings = next;
    if (this.status === 'ready') {
      // A save in progress is no news: the guide already shows the change.
      this.report('');
      this.schedule();
    } else {
      // The read in flight, or the next one, saves it over what the file then holds.
      this.report(this.problem);
    }
  }

  reload(): void {
    // A save on its way would be raced by the read; it reports for itself.
    if (this.writing || this.status === 'closed' || (this.status === 'ready' && this.unsaved.size > 0)) {
      return;
    }
    const token = {};
    this.loadToken = token;
    this.status = 'loading';
    this.report('');
    void readMetadata(this.project, 'guide')
      .then(async (stored) => {
        if (this.status === 'closed' || this.loadToken !== token) {
          return;
        }
        this.adopt(stored.source);
        this.status = 'ready';
        this.report('');
        await this.save();
      })
      .catch((error: unknown) => {
        if (this.status !== 'closed' && this.loadToken === token) {
          this.status = 'failed';
          this.report(errorMessage(error));
        }
      });
  }

  close(): void {
    const status = this.status;
    this.status = 'closed';
    clearTimeout(this.timer);
    if (status === 'ready') {
      void this.save();
    } else if (this.unsaved.size > 0 && !this.writing) {
      // One last try over the current file. A file that cannot be read is left as it is.
      void readMetadata(this.project, 'guide')
        .then(async (stored) => {
          this.adopt(stored.source);
          await this.save();
        })
        .catch(() => undefined);
    }
  }

  // The file's settings, with the unsaved changes over them.
  private adopt(source: string | undefined): void {
    // Without a file, only settings from app storage are written; defaults wait for a change.
    const legacy = source === undefined ? loadLegacyGuideSettings(this.project) : undefined;
    let settings = source === undefined ? (legacy ?? GUIDE_DEFAULTS) : guideFromSource(source);
    for (const key of this.unsaved) {
      settings = { ...settings, [key]: this.settings[key] };
    }
    this.source = source;
    this.unmigrated = legacy !== undefined;
    this.settings = settings;
  }

  private schedule(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.save(), 200);
  }

  private report(problem: string): void {
    if (this.status !== 'closed') {
      this.problem = problem;
      this.notify({ settings: this.settings, problem, loading: this.status === 'loading' });
    }
  }

  private async save(): Promise<void> {
    if (this.writing || (this.unsaved.size === 0 && !this.unmigrated)) {
      return;
    }
    const next = this.settings;
    const sending = this.unsaved;
    this.unsaved = new Set();
    this.writing = true;
    let saved = false;
    try {
      const result = await writeMetadata(this.project, {
        kind: 'guide',
        source: JSON.stringify({ version: 1, settings: { ...next, columnDefaultsVersion: 1 } }, undefined, 2) + '\n',
        ...(this.source === undefined ? {} : { base: this.source }),
      });
      this.source = result.source;
      this.unmigrated = false;
      saved = true;
      this.report('');
    } catch (error: unknown) {
      for (const key of sending) {
        this.unsaved.add(key);
      }
      if (this.status !== 'closed') {
        this.status = 'failed';
      }
      // The next `reload` reads the file again and saves what is still unsaved.
      this.report(`${errorMessage(error)} Project settings will retry automatically.`);
    } finally {
      this.writing = false;
      // A change made during this write; a failed one waits for `reload` instead.
      if (saved && this.unsaved.size > 0) {
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
  return error instanceof Error ? error.message : 'Could not save the project guide.'; // i18n-ignore: stored fallback for a non-Error throw; every real failure carries the system's own message.
}
